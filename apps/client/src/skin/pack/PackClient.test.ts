// PackClient：用 globalSetup 生成的合成素材包（.cache/synthetic-pack，fixture 地图 test / test-allkinds）走一遍
// manifest 校验、带哈希的 URL、地图绑定（修正 9）、按组懒加载与校验、失败组回退；
// 以及各种「没有素材包」的响应（404 / 204 / HTML / 校验失败 / 5xx / 网络）、401 门禁、FLC 条目。
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withPackId } from '@rich4/shared/assets';
import { buildFixtureMaps, type MapDef } from '@rich4/shared/data';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { syntheticManifestDraft } from '../../../../../packages/shared/src/assets/testing/synthetic';
import { AnimClock } from '../../game/anim/AnimClock';
import { loadFlicPlayer } from '../flic/packFlic';
import { buildFlc, randomPalette } from '../flic/testing/flcBuilder';
import type { FetchLike } from './http';
import { HttpError } from './http';
import { PackClient } from './PackClient';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const PACK = join(REPO, '.cache', 'synthetic-pack');

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** 从磁盘上的合成素材包提供 /pack/*；overrides 按完整 URL 覆盖；记录请求 */
function diskFetch(overrides: Record<string, Handler> = {}): FetchLike & { urls: string[] } {
  const urls: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    urls.push(url);
    const o = overrides[url];
    if (o) return o(url, init);
    if (!url.startsWith('/pack/')) return json({ ok: false }, 404);
    const rel = url.slice('/pack/'.length);
    try {
      const buf = await readFile(join(PACK, rel));
      const type = rel.endsWith('.json')
        ? 'application/json'
        : rel.endsWith('.png')
          ? 'image/png'
          : 'application/octet-stream';
      return new Response(buf, { status: 200, headers: { 'content-type': type } });
    } catch {
      return json({ ok: false, error: { code: 'BAD_REQUEST', details: { reason: 'notFound' } } }, 404);
    }
  }) as FetchLike & { urls: string[] };
  f.urls = urls;
  return f;
}

let maps: MapDef[];
beforeAll(() => {
  maps = buildFixtureMaps();
});
const mapOf = (id: string): MapDef => maps.find((m) => m.id === id)!;

describe('PackClient + 合成素材包', () => {
  it('manifest 通过 zod 与一致性校验；逻辑路径解析为带哈希的 URL', async () => {
    const f = diskFetch();
    const c = new PackClient({ fetch: f });
    const s = await c.loadManifest();
    expect(s.status).toBe('ready');
    const m = c.manifest!;
    expect(m.generator).toBe('rich4-extract/synthetic@1');
    expect(f.urls).toEqual(['/pack/manifest.json']);
    const skin = m.maps.test!.skin;
    expect(c.fileUrl(skin)).toBe(`/pack/${m.files[skin]!.path}`);
    expect(c.fileUrl(skin)).toMatch(/^\/pack\/maps\/test\.skin\.[0-9a-f]{8}\.json$/);
    expect(c.fileUrl('nope.json')).toBeNull();
    // 同一实例只请求一次
    await c.loadManifest();
    expect(f.urls).toHaveLength(1);
  });

  it('fixture 地图与皮肤绑定匹配（resourceSha256=null + 几何摘要）；几何改动 → mismatch；没有的地图 → missing', async () => {
    const c = new PackClient({ fetch: diskFetch() });
    await c.loadManifest();
    expect(c.checkMap(mapOf('test'))).toEqual({ mapId: 'test', status: 'ok', mismatches: [], group: 'map.test' });
    expect(c.checkMap(mapOf('test-allkinds')).status).toBe('ok');
    const moved = structuredClone(mapOf('test'));
    moved.tiles[0]!.world = { x: moved.tiles[0]!.world.x + 1, y: moved.tiles[0]!.world.y };
    const bad = c.checkMap(moved);
    expect(bad.status).toBe('mismatch');
    expect(bad.mismatches.map((x) => x.code)).toEqual(['geometry']);
    const taiwan = { ...structuredClone(mapOf('test')), id: 'taiwan' };
    expect(c.checkMap(taiwan)).toMatchObject({ status: 'missing', group: null });
  });

  it('按组懒加载：图集与地图皮肤逐个校验；图集页位图 URL 在白名单内', async () => {
    const f = diskFetch();
    const c = new PackClient({ fetch: f });
    await c.loadManifest();
    const b = await c.loadGroup('map.test');
    expect(b.mapSkins.get('test')?.mapId).toBe('test');
    expect(b.atlases.size).toBeGreaterThan(0);
    expect(b.images.size).toBe(0);
    const m = c.manifest!;
    const servable = new Set(Object.values(m.files).map((x) => `/pack/${x.path}`));
    for (const [lp, atlas] of b.atlases) expect(servable.has(c.atlasImageUrl(lp, atlas)!), lp).toBe(true);
    // 只请求了 JSON（位图按需）
    expect(f.urls.filter((u) => u.endsWith('.png'))).toEqual([]);
    expect(f.urls.some((u) => /\/pack\/sprites\/.+\.json$/.test(u))).toBe(true);
    // 缓存：再取一次不再请求
    const n = f.urls.length;
    await c.loadGroup('map.test');
    await c.loadMapSkin('test');
    expect(f.urls.length).toBe(n);
    // 精灵条目可用；guess 条目回退
    expect(c.usableEntry('map.test.house.1')?.type).toBe('sprite');
    expect(c.usableEntry('board.lotHighlight')).toBeNull();
    expect(c.entryRejection('board.lotHighlight')).toBe('guess');
  });

  it('images=true 时解码位图（注入解码器）；loadBinary 返回原始字节', async () => {
    const decodeImage = vi.fn(async (blob: Blob) => ({ width: blob.size }) as unknown as ImageBitmap);
    const c = new PackClient({ fetch: diskFetch(), decodeImage });
    await c.loadManifest();
    const b = await c.loadGroup('board.common', { images: true });
    expect(b.images.size).toBeGreaterThan(0);
    expect(decodeImage).toHaveBeenCalled();
    const png = [...b.images.keys()][0]!;
    const bytes = new Uint8Array(await c.loadBinary(png));
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('位图按引用计数常驻：每个使用者归还后关闭并移出缓存（离开对局不再常驻）；还有使用者时不关', async () => {
    const closed: string[] = [];
    const decodeImage = vi.fn(
      async (_blob: Blob, lp: string) =>
        ({ width: 1, height: 1, close: () => closed.push(lp) }) as unknown as ImageBitmap,
    );
    const f = diskFetch();
    const c = new PackClient({ fetch: f, decodeImage });
    await c.loadManifest();
    const pngs = Object.keys(c.manifest!.files).filter((lp) => lp.endsWith('.png'));
    const [a, b] = [pngs[0]!, pngs[1]!];
    // 两个使用者共用一份（只下载、解码一次）
    const [x, y] = await Promise.all([c.loadImage(a), c.loadImage(a)]);
    expect(x).toBe(y);
    await c.loadImage(b);
    expect(decodeImage).toHaveBeenCalledTimes(2);
    expect(c.cachedImageCount).toBe(2);
    c.releaseImage(a);
    await Promise.resolve();
    expect(closed).toEqual([]);
    expect(c.cachedImageCount).toBe(2);
    c.releaseImage(a);
    c.releaseImage(b);
    await new Promise((r) => setTimeout(r, 0));
    expect(closed.sort()).toEqual([a, b].sort());
    expect(c.cachedImageCount).toBe(0);
    // 多还一次无害；再借会重新解码
    c.releaseImage(a);
    await c.loadImage(a);
    expect(decodeImage).toHaveBeenCalledTimes(3);
    // 加载失败：计数自动退回，不影响之后的成功加载
    const bad = new PackClient({
      fetch: diskFetch({ [c.fileUrl(b)!]: () => json({ ok: false }, 500) }),
      decodeImage,
    });
    await bad.loadManifest();
    await expect(bad.loadImage(b)).rejects.toThrow();
    expect(bad.cachedImageCount).toBe(0);
  });

  it('二进制缓存按字节预算 LRU：超预算淘汰最久未用的（再取时重新下载），命中的刷新次序', async () => {
    const f = diskFetch();
    const c = new PackClient({ fetch: f, binaryCacheBytes: 1 });
    await c.loadManifest();
    const pngs = Object.keys(c.manifest!.files).filter((lp) => lp.endsWith('.png'));
    const [a, b] = [pngs[0]!, pngs[1]!];
    const fetches = (lp: string) => f.urls.filter((u) => u === c.fileUrl(lp)).length;
    const bufA = await c.loadBinary(a);
    const bufB = await c.loadBinary(b);
    // 预算 1 字节：只留最近的一个
    expect(c.binaryCacheBytes).toBe(bufB.byteLength);
    await c.loadBinary(b);
    expect(fetches(b)).toBe(1);
    expect((await c.loadBinary(a)).byteLength).toBe(bufA.byteLength);
    expect(fetches(a)).toBe(2);
    expect(c.binaryCacheBytes).toBe(bufA.byteLength);
    // 预算足够时两个都留着
    const roomy = new PackClient({ fetch: diskFetch() });
    await roomy.loadManifest();
    await roomy.loadBinary(a);
    await roomy.loadBinary(b);
    expect(roomy.binaryCacheBytes).toBe(bufA.byteLength + bufB.byteLength);
  });

  it('组内文件缺失 → 组记为失败并 reject；该组条目与地图检查随之回退', async () => {
    const m = JSON.parse(await readFile(join(PACK, 'manifest.json'), 'utf8'));
    const skinPath = `/pack/${m.files[m.maps.test.skin].path}`;
    const c = new PackClient({ fetch: diskFetch({ [skinPath]: () => json({ ok: false }, 404) }) });
    await c.loadManifest();
    await expect(c.loadGroup('map.test')).rejects.toBeInstanceOf(HttpError);
    expect(c.failedGroups.has('map.test')).toBe(true);
    expect(c.checkMap(mapOf('test')).status).toBe('group-missing');
    expect(c.usableEntry('map.test.house.1')).toBeNull();
    await expect(c.loadGroup('nope')).rejects.toThrow(/没有组/);
  });

  it('manifest 已改写（校验失败）→ absent invalid；force 重新请求', async () => {
    let body = JSON.parse(await readFile(join(PACK, 'manifest.json'), 'utf8'));
    body.packId = '0000000000000000';
    const f = diskFetch({ '/pack/manifest.json': () => json(body) });
    const c = new PackClient({ fetch: f });
    expect(await c.loadManifest()).toMatchObject({ status: 'absent', reason: 'invalid' });
    body = JSON.parse(await readFile(join(PACK, 'manifest.json'), 'utf8'));
    expect((await c.loadManifest({ force: true })).status).toBe('ready');
  });
});

describe('PackClient：没有素材包与门禁', () => {
  const cases: [string, Handler, string][] = [
    ['404 JSON', () => json({ ok: false, error: { code: 'BAD_REQUEST' } }, 404), 'not-found'],
    ['204', () => new Response(null, { status: 204 }), 'no-content'],
    [
      'SPA 页面（旧服务器）',
      () => new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      'not-json',
    ],
    [
      '坏 JSON',
      () => new Response('{oops', { status: 200, headers: { 'content-type': 'application/json' } }),
      'not-json',
    ],
    ['不是 manifest 的 JSON', () => json({ ok: true, data: {} }), 'invalid'],
    ['500', () => json({ ok: false }, 500), 'http'],
    [
      '网络错误',
      () => {
        throw new TypeError('Failed to fetch');
      },
      'network',
    ],
  ];
  for (const [name, h, reason] of cases) {
    it(`${name} → absent ${reason}`, async () => {
      const c = new PackClient({ fetch: diskFetch({ '/pack/manifest.json': h }) });
      const s = await c.loadManifest();
      expect(s).toMatchObject({ status: 'absent', reason });
      expect(c.manifest).toBeNull();
      expect(c.fileUrl('x')).toBeNull();
    });
  }

  it('manifest 401 → access-required 并通知门禁页；响应头里的门禁模式', async () => {
    const onAccessRequired = vi.fn();
    const onAccessMode = vi.fn();
    const c = new PackClient({
      fetch: diskFetch({
        '/pack/manifest.json': () =>
          json({ ok: false, error: { code: 'ACCESS_REQUIRED' } }, 401, { 'x-rich4-access': 'passcode' }),
      }),
      onAccessRequired,
      onAccessMode,
    });
    expect((await c.loadManifest()).status).toBe('access-required');
    expect(onAccessRequired).toHaveBeenCalledWith('manifest');
    expect(onAccessMode).toHaveBeenCalledWith('passcode');
  });

  it('文件 401 → HttpError（accessRequired）并通知门禁页', async () => {
    const onAccessRequired = vi.fn();
    const m = JSON.parse(await readFile(join(PACK, 'manifest.json'), 'utf8'));
    const skinPath = `/pack/${m.files[m.maps.test.skin].path}`;
    const c = new PackClient({
      fetch: diskFetch({ [skinPath]: () => json({ ok: false, error: { code: 'ACCESS_REQUIRED' } }, 401) }),
      onAccessRequired,
    });
    await c.loadManifest();
    const err = await c.loadMapSkin('test').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).accessRequired).toBe(true);
    expect((err as HttpError).code).toBe('ACCESS_REQUIRED');
    expect(onAccessRequired).toHaveBeenCalledWith('file');
  });
});

describe('PackClient：FLC 与音频条目', () => {
  /** 合成 manifest（shared 的形状参考）改成 8×6×3 帧的 FLC，文件由内存提供 */
  function flcPack(frames = 3) {
    const draft = syntheticManifestDraft();
    const e = draft.entries['fx.fireworks'];
    if (e?.type !== 'flic') throw new Error('synthetic manifest changed');
    draft.entries['fx.fireworks'] = { ...e, w: 8, h: 6, frames: 3, frameMs: 42, durationMs: 126 };
    const m = withPackId(draft);
    const pal = randomPalette(4);
    const bytes = buildFlc({
      width: 8,
      height: 6,
      speed: 42,
      frames: Array.from({ length: frames }, (_, i) => ({
        pixels: new Uint8Array(48).fill(i + 1),
        ...(i === 0 ? { palette: pal } : {}),
        encoding: i === 0 ? ('byterun' as const) : ('delta' as const),
      })),
    });
    const url = `/pack/${m.files['flic/data/482.flc']!.path}`;
    const fetch = diskFetch({
      '/pack/manifest.json': () => json(m),
      [url]: () =>
        new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'application/octet-stream' } }),
    });
    return { fetch, m };
  }

  it('loadFlic：下载并解析，头部与条目一致', async () => {
    const { fetch } = flcPack();
    const c = new PackClient({ fetch });
    await c.loadManifest();
    const { entry, flc } = await c.loadFlic('fx.fireworks');
    expect(entry.sfx).toBe('sfx.090');
    expect([flc.width, flc.height, flc.frames]).toEqual([8, 6, 3]);
    await expect(c.loadFlic('sfx.090')).rejects.toThrow(/不是 FLIC/);
  });

  it('loadFlicPlayer：按条目的透明规则建播放器（缓存同一份字节）', async () => {
    const { fetch } = flcPack();
    const c = new PackClient({ fetch });
    await c.loadManifest();
    const frames: number[] = [];
    const sink = { present: (_rgba: Uint8ClampedArray, _w: number, _h: number, f: number) => void frames.push(f) };
    const { entry, player } = await loadFlicPlayer(c, 'fx.fireworks', { clock: new AnimClock(), sink });
    expect(entry.transparency).toBe('index0');
    expect(player.opaque).toBe(false);
    expect([player.width, player.height, player.frames, player.frameMs]).toEqual([8, 6, 3, 42]);
    player.show(2);
    expect(frames).toEqual([2]);
    expect(fetch.urls.filter((u) => u.endsWith('.flc'))).toHaveLength(1);
    await loadFlicPlayer(c, 'fx.fireworks', { clock: new AnimClock(), sink });
    expect(fetch.urls.filter((u) => u.endsWith('.flc'))).toHaveLength(1);
  });

  it('loadFlic：头部与条目不符时报错', async () => {
    const { fetch } = flcPack(4);
    const c = new PackClient({ fetch });
    await c.loadManifest();
    await expect(c.loadFlic('fx.fireworks')).rejects.toThrow(/不符/);
  });

  it('audioFile：opus 优先，不支持时退到 m4a', async () => {
    const { fetch, m } = flcPack();
    const opus = new PackClient({ fetch, canPlayType: () => 'probably' });
    const aac = new PackClient({ fetch, canPlayType: (t) => (t.startsWith('audio/mp4') ? 'maybe' : '') });
    const e = m.entries['sfx.090'];
    if (e?.type !== 'audio') throw new Error('synthetic manifest changed');
    expect(opus.audioFile(e)).toBe('audio/sfx/090.opus');
    expect(aac.audioFile(e)).toBe('audio/sfx/090.m4a');
  });
});
