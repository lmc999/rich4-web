/**
 * 原版皮肤 A2（本机，需要用户正版文件；缺文件时整组 skip）：
 * 1. 在真实文件上构建一个子集素材包（棋盘 + 抽样条目，输出到 <仓库>/.cache/test-tmp/ 下的临时目录），核对地图皮肤的计数与投影拟合、
 *    按条目回读 PNG/FLC 与调研样图（.cache/assets-research/samples）的 RGBA 哈希；
 * 2. 四张原版地图（rich4-data/maps 下有 china/japan/usa 的 MapDef 时）：每张图的皮肤绑定计数、景观与快艇节点、
 *    共用精灵分组；台湾 MapDef 仍是基线（sha256 14ef91e8…）时，台湾皮肤 JSON 必须与多图改造前逐字节相同；
 * 3. 已构建的完整素材包（rich4-assets/manifest.json 存在时）：条目计数、逐文件 sha256 复算、manifest.maps 与数据包一致；
 * 4. 仓库守卫：把素材包文件改名拷进一个临时 git 仓库（同样建在 .cache/test-tmp/ 下），check-no-original 必须拦下
 *    （派生标记 + manifest 哈希禁单）。
 * 只读原版文件与调研产物；派生物只写 .cache/test-tmp/（已被 git 忽略），不写系统临时目录。
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type MapSkinV1, type PackManifestV1, parseAtlas, parseMapSkin, spriteFrameName } from '@rich4/shared/assets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPack, parseParts } from '../../src/assets/build';
import {
  catalogV206,
  FATE_ART_TABLE,
  HOLIDAY_ART_BASE,
  ORIGINAL_MAPS,
  SHARED_LANDMARKS,
} from '../../src/assets/catalog.v206';
import { normalizeTransparent, readPng } from '../../src/assets/pngRead';
import { verifyPack } from '../../src/assets/verify';
import { decodeFlcFrames, flcFrameToRgba, parseFlc } from '../../src/gfx/flc';
import { hashHex } from '../../src/io/hash';
import { parsePe, vaToOffset } from '../../src/pe/pe';
import { originalAvailable, originalCtx, originalPath, researchPath } from '../helpers/originalMkf';
import { makeRepoTmpDir, REPO_TEST_TMP, repoIgnores } from '../helpers/repoTmp';

const quiet = { out: () => {}, err: () => {} };
const REPO = originalCtx.root;
/** 数据包目录：默认 <仓库>/rich4-data，可用 RICH4_DATA_DIR 指向别处（与服务器同名变量） */
const MAP_DIR = path.join(path.resolve(REPO, process.env.RICH4_DATA_DIR ?? 'rich4-data'), 'maps');
const MAP_DATA = path.join(MAP_DIR, 'taiwan.map.json');
const available =
  originalAvailable([
    'Game/Data.mkf',
    'Game/Panel.mkf',
    'Game/jump.mkf',
    'Game/map.mkf',
    'Game/MapDat.MKF',
    'Game/rich4.exe',
  ]) &&
  existsSync(MAP_DATA) &&
  existsSync(researchPath('samples', 'Data', '88_0.png'));

/** 抽检条目（与 A1 本机测试用同一批调研样图） */
const SPRITE_SAMPLES: [key: string, frames: number[]][] = [
  ['char.0.walk', [0, 9, 17, 36, 71]],
  ['ui.cursor', [0, 5, 42]],
  ['ui.common', [0]],
  ['object.smallWealth', [0, 7]],
  ['ui.sidebar', [0, 5]],
  ['ui.diceFaces', [0, 17]],
  ['ui.dicePicker', [0, 6]],
  ['title.sidewalk.0.walk', [0, 19]],
  ['map.taiwan.minimap', [0, 1]],
  ['board.ownerMark', [0, 11]],
  ['map.taiwan.house.1', [0, 7]],
];
const IMAGE_SAMPLES = ['illustration.holiday.0', 'illustration.news.0', 'title.loading', 'title.setup.bg', 'card.1'];
const FLIC_SAMPLES: [key: string, frames: number[]][] = [
  ['fx.god.smallWealth', [0, 10, 20]],
  ['ui.dice.roll1', [0, 16, 35]],
];
const SKIN_GROUPS = ['map.taiwan', 'board.landmarks', 'board.common', 'board.buildings'];

const rgbaSha = (rgba: Uint8Array) => hashHex(normalizeTransparent(rgba), 'sha256');

function sample(mkfRes: string, frame: number): { w: number; h: number; rgba: Uint8Array } {
  const [mkf, res] = mkfRes.split('#') as [string, string];
  const p = readPng(new Uint8Array(readFileSync(researchPath('samples', mkf, `${res}_${frame}.png`))));
  return { w: p.w, h: p.h, rgba: p.rgba };
}

describe.skipIf(!available)('素材包子集构建（本机原版文件）', () => {
  let dir: string;
  let m: PackManifestV1;
  let skin: MapSkinV1;
  const file = (lp: string) => new Uint8Array(readFileSync(path.join(dir, m.files[lp]!.path)));

  beforeAll(async () => {
    expect(repoIgnores(path.join(REPO_TEST_TMP, 'probe'))).not.toBe(false);
    dir = makeRepoTmpDir('rich4-a2-local-');
    const full = catalogV206();
    const keys = new Set([...SPRITE_SAMPLES.map((s) => s[0]), ...IMAGE_SAMPLES, ...FLIC_SAMPLES.map((s) => s[0])]);
    const catalog = { ...full, items: full.items.filter((it) => keys.has(it.key) || SKIN_GROUPS.includes(it.group)) };
    const r = await buildPack({
      ctx: originalCtx,
      outDir: dir,
      only: parseParts('board,ui,fx'),
      catalog,
      mapDataDir: MAP_DIR,
      reportDir: path.join(dir, '.report'),
      log: quiet,
    });
    m = r.manifest;
    skin = parseMapSkin(JSON.parse(Buffer.from(file(m.maps.taiwan!.skin)).toString('utf8')));
  }, 180_000);

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('台湾皮肤：103 节点的装饰、21 景观、3 企业、17 个快艇节点；绑定原版资源哈希', () => {
    const def = JSON.parse(readFileSync(MAP_DATA, 'utf8')) as { meta: { source: { resourceSha256: string } } };
    expect(skin.binding.resourceSha256).toBe(def.meta.source.resourceSha256);
    expect(skin.binding.counts).toEqual({ tiles: 103, lots: 54, companies: 3 });
    expect(skin.world).toEqual({ w: 2304, h: 2304 });
    expect(skin.ground.chunks.map((c) => [c.x, c.y, c.w, c.h])).toEqual([
      [0, 0, 1153, 1153],
      [1152, 0, 1152, 1153],
      [0, 1152, 1153, 1152],
      [1152, 1152, 1152, 1152],
    ]);
    expect(skin.scenery).toHaveLength(21);
    expect(skin.scenery.find((s) => s.spriteId === 61)).toMatchObject({ sprite: 'board.landmark.87', landmark: '1' });
    expect(skin.buildings.companies.map((c) => c.sprite)).toEqual([
      'board.landmark.75',
      'board.landmark.80',
      'board.landmark.84',
    ]);
    expect(skin.boatTiles).toEqual([1, 2, 3, 4, 25, 26, 27, 28, 29, 32, 33, 34, 99, 100, 101, 102, 103]);
    expect(skin.decor.nodes.length).toBeGreaterThan(40);
    expect(skin.decor.nodes.every((n) => n.frame >= 0 && n.frame < 17)).toBe(true);
  });

  it('投影拟合与调研 projection-fit.v206.json 一致（系数差 < 1e-3），格点最大误差 ≤ 2.1 px', () => {
    const fit = JSON.parse(readFileSync(researchPath('render', 'projection-fit.v206.json'), 'utf8')) as {
      views: {
        sx: { dx: number; dy: number; c: number };
        sy: { dx: number; dy: number; c: number };
        maxErrPx: number;
      }[];
    };
    skin.projection.views.forEach((v, i) => {
      const f = fit.views[i]!;
      expect(Math.abs(v.a * 32 - f.sx.dx)).toBeLessThan(1e-3);
      expect(Math.abs(v.c * 32 - f.sx.dy)).toBeLessThan(1e-3);
      expect(Math.abs(v.b * 32 - f.sy.dx)).toBeLessThan(1e-3);
      expect(Math.abs(v.d * 32 - f.sy.dy)).toBeLessThan(1e-3);
      expect(Math.abs(v.tx - f.sx.c)).toBeLessThan(1e-3);
      expect(Math.abs(v.ty - f.sy.c)).toBeLessThan(1e-3);
      expect(Math.abs(v.maxErrPx! - f.maxErrPx)).toBeLessThanOrEqual(0.001);
      expect(v.maxErrPx).toBeLessThanOrEqual(2.1);
    });
    expect(skin.projection.exact?.cellScreen.slice(0, 2)).toEqual([-211, -714]);
  });

  it('精灵帧（从图集页回读）与调研样图 RGBA 一致；主人色像素在底图透明、在掩膜页为白', () => {
    for (const [key, frames] of SPRITE_SAMPLES) {
      const e = m.entries[key]!;
      if (e.type !== 'sprite') throw new Error(key);
      for (const f of frames) {
        const name = spriteFrameName(e.frames.base, f);
        const lp = e.atlas.find((a) => parseAtlas(JSON.parse(Buffer.from(file(a)).toString('utf8'))).frames[name]);
        const atlas = parseAtlas(JSON.parse(Buffer.from(file(lp!)).toString('utf8')));
        const dirOf = m.files[lp!]!.path.slice(0, m.files[lp!]!.path.lastIndexOf('/') + 1);
        const pageLp = Object.keys(m.files).find((k) => m.files[k]!.path === dirOf + atlas.meta.image)!;
        const page = readPng(file(pageLp));
        const r = atlas.frames[name]!.frame;
        const crop = new Uint8Array(r.w * r.h * 4);
        for (let y = 0; y < r.h; y++)
          crop.set(
            page.rgba.subarray(((r.y + y) * page.w + r.x) * 4, ((r.y + y) * page.w + r.x + r.w) * 4),
            y * r.w * 4,
          );
        const ref = sample(e.src[0]!, f);
        expect([r.w, r.h], `${key}:${f}`).toEqual([ref.w, ref.h]);
        if (e.ownerMask) {
          const maskLp = Object.keys(m.files).find((k) => m.files[k]!.path === dirOf + atlas.meta.r4.mask)!;
          const mask = readPng(file(maskLp));
          let owners = 0;
          for (let y = 0; y < r.h; y++) {
            for (let x = 0; x < r.w; x++) {
              if (mask.gray![(r.y + y) * mask.w + r.x + x] !== 255) continue;
              owners++;
              expect(crop[(y * r.w + x) * 4 + 3]).toBe(0);
              ref.rgba.fill(0, (y * r.w + x) * 4, (y * r.w + x) * 4 + 4);
            }
          }
          expect(owners, `${key}:${f} 主人色像素`).toBeGreaterThan(0);
        }
        expect(rgbaSha(crop), `${key}:${f}`).toBe(rgbaSha(ref.rgba));
      }
    }
  });

  it('RAW16 整图与调研样图一致（全部不透明，卡片插画也是：exe 0x440c95 不透明拷贝）', () => {
    for (const key of IMAGE_SAMPLES) {
      const e = m.entries[key]!;
      if (e.type !== 'image') throw new Error(key);
      const png = readPng(file(e.file));
      const ref = sample(e.src[0]!, 0);
      expect([png.w, png.h]).toEqual([ref.w, ref.h]);
      if (key.startsWith('card.')) {
        // 卡片插画：不透明整图，黑色卡框与回纹角照原样保留（旧版四角泛洪会抠掉 1948–9749 个像素）
        expect(e.transparency).toBe('opaque');
        let clear = 0;
        for (let i = 0; i < png.w * png.h; i++) if (png.rgba[i * 4 + 3] !== 255) clear++;
        expect(clear).toBe(0);
      }
      if (e.transparency === 'corner-rgb0') {
        let clear = 0;
        for (let i = 0; i < png.w * png.h; i++) {
          if (png.rgba[i * 4 + 3] === 0) {
            clear++;
            ref.rgba.fill(0, i * 4, i * 4 + 4);
          }
        }
        expect(png.rgba[3]).toBe(0);
        expect(clear).toBeLessThan(png.w * png.h * 0.05);
      }
      expect(rgbaSha(png.rgba), key).toBe(rgbaSha(ref.rgba));
    }
  });

  it('FLC 原样保存：回读解码的帧与调研样图一致，预压缩变体齐全', () => {
    for (const [key, frames] of FLIC_SAMPLES) {
      const e = m.entries[key]!;
      if (e.type !== 'flic') throw new Error(key);
      const flc = parseFlc(file(e.file), key);
      const decoded = decodeFlcFrames(flc);
      for (const f of frames) {
        const img = flcFrameToRgba(decoded[f]!, flc.width, flc.height);
        expect(rgbaSha(img.rgba), `${key}:${f}`).toBe(rgbaSha(sample(e.src[0]!, f).rgba));
      }
      expect(m.files[e.file]!.variants?.br).toBeDefined();
      expect(m.files[e.file]!.variants?.gzip).toBeDefined();
    }
    expect(m.entries['fx.god.smallWealth']).toMatchObject({ frames: 21, frameMs: 100, durationMs: 2100 });
  });

  it('地面：2×2 切块（带 1px 重叠）拼回 2304² 与调研导出的 GND 底图一致', () => {
    const full = new Uint8Array(2304 * 2304 * 4);
    for (const c of skin.ground.chunks) {
      const p = readPng(file(c.file));
      expect([p.w, p.h]).toEqual([c.w, c.h]);
      for (let y = 0; y < c.h; y++)
        full.set(p.rgba.subarray(y * c.w * 4, (y + 1) * c.w * 4), ((c.y + y) * 2304 + c.x) * 4);
    }
    expect(rgbaSha(full)).toBe(rgbaSha(sample('map#0', 0).rgba));
  });

  it('check-no-original 拦下改名拷进仓库的素材包文件（派生标记 + manifest 哈希禁单）', () => {
    const repo = makeRepoTmpDir('rich4-a2-guard-');
    try {
      expect(spawnSync('git', ['init', '-q'], { cwd: repo }).status).toBe(0);
      mkdirSync(path.join(repo, 'assets'), { recursive: true });
      copyFileSync(path.join(dir, m.files[skin.ground.chunks[0]!.file]!.path), path.join(repo, 'assets', 'bg.bin'));
      copyFileSync(path.join(dir, m.files['flic/data/499.flc']!.path), path.join(repo, 'assets', 'anim.dat'));
      writeFileSync(path.join(repo, 'README.md'), '# ok\n');
      const r = spawnSync('npx', ['tsx', path.join(REPO, 'scripts', 'check-no-original.ts'), '--root', repo], {
        cwd: REPO,
        encoding: 'utf8',
        env: { ...process.env, RICH4_ASSETS_DIR: dir },
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/assets\/bg\.bin.*派生 PNG/);
      expect(r.stderr).toMatch(/assets\/bg\.bin.*禁单/);
      expect(r.stderr).toMatch(/assets\/anim\.dat.*FLIC/);
      expect(r.stderr).not.toMatch(/README/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 60_000);
});

// ───────────────────────── 四张原版地图 ─────────────────────────

describe.skipIf(!originalAvailable(['Game/rich4.exe']))('资源目录里按地图的常量与 v2.06 exe 表一致', () => {
  it('节日插画基址 0x473098 = (4,28,47,67)；命运插图表 0x473dd8 u16[49]；FLY 指针表 0x472f78', () => {
    const bytes = new Uint8Array(readFileSync(originalPath('Game/rich4.exe')));
    const pe = parsePe(bytes, 'rich4.exe');
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const off = (va: number) => vaToOffset(pe, va)!;
    const u16s = (va: number, n: number) => Array.from({ length: n }, (_, i) => dv.getUint16(off(va) + 2 * i, true));
    expect(u16s(0x473098, 4)).toEqual([...HOLIDAY_ART_BASE]);
    expect(u16s(0x473dd8, 49)).toEqual([...FATE_ART_TABLE]);
    const names = Array.from({ length: 4 }, (_, i) => {
      const o = off(dv.getUint32(off(0x472f78) + 4 * i, true));
      let e = o;
      while (bytes[e] !== 0) e++;
      return Buffer.from(bytes.subarray(o, e)).toString('latin1');
    });
    expect(names).toEqual(['FLYTW.AVI', 'FLYCHINA.AVI', 'FLYJP.AVI', 'FLYUS.AVI']);
  });
});

/** 台湾数据包基线（rich4-data/maps/taiwan.map.json）与它对应的台湾皮肤 JSON（多图改造前的 rich4-assets） */
const TAIWAN_MAP_SHA256 = '14ef91e8429d48da04d317be63e9cb01131aa6a6c72511fd6bab9146302a6c10';
const TAIWAN_SKIN_SHA256 = 'ca179eee372922da1adbd5fbe06dbf36dd9dc64bce16c0f94f65a76b787d31cd';
/** 企业 / 地块 / 节点（MapDef 计数）、景观数、快艇节点 */
const MAP_EXPECT: Record<string, { counts: [number, number, number]; scenery: number; boat: number[] }> = {
  taiwan: {
    counts: [3, 54, 103],
    scenery: 21,
    boat: [1, 2, 3, 4, 25, 26, 27, 28, 29, 32, 33, 34, 99, 100, 101, 102, 103],
  },
  china: { counts: [4, 81, 144], scenery: 26, boat: [] },
  japan: { counts: [6, 54, 110], scenery: 16, boat: [23, 24, 25, 26, 27, 28, 29] },
  usa: { counts: [6, 63, 118], scenery: 16, boat: [] },
};
const allMaps = available && ORIGINAL_MAPS.every((mm) => existsSync(path.join(MAP_DIR, `${mm.mapId}.map.json`)));

describe.skipIf(!allMaps)('四张原版地图的皮肤（本机原版文件 + rich4-data/maps）', () => {
  let dir: string;
  let m: PackManifestV1;
  const file = (lp: string) => new Uint8Array(readFileSync(path.join(dir, m.files[lp]!.path)));
  const skinOf = (id: string) => parseMapSkin(JSON.parse(Buffer.from(file(m.maps[id]!.skin)).toString('utf8')));

  beforeAll(async () => {
    dir = makeRepoTmpDir('rich4-a2-maps-');
    const full = catalogV206();
    const catalog = {
      ...full,
      items: full.items.filter(
        (it) =>
          it.group.startsWith('map.') || ['board.landmarks', 'board.common', 'board.buildings'].includes(it.group),
      ),
    };
    const r = await buildPack({
      ctx: originalCtx,
      outDir: dir,
      only: parseParts('board'),
      catalog,
      mapDataDir: MAP_DIR,
      strict: true,
      reportDir: path.join(dir, '.report'),
      log: quiet,
    });
    m = r.manifest;
  }, 300_000);

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('manifest.maps 有四张图；绑定计数（企业/地块/节点）、景观数、快艇节点按图核对', () => {
    expect(Object.keys(m.maps)).toEqual(['china', 'japan', 'taiwan', 'usa']);
    for (const mm of ORIGINAL_MAPS) {
      const want = MAP_EXPECT[mm.mapId]!;
      const mp = m.maps[mm.mapId]!;
      expect(mp.group).toBe(`map.${mm.mapId}`);
      const c = mp.binding.counts;
      expect([c.companies, c.lots, c.tiles], mm.mapId).toEqual(want.counts);
      const skin = skinOf(mm.mapId);
      expect(skin.world, mm.mapId).toEqual({ w: 2304, h: 2304 });
      expect(skin.scenery, mm.mapId).toHaveLength(want.scenery);
      expect(skin.boatTiles, mm.mapId).toEqual(want.boat);
      expect(skin.minimap?.sprite, mm.mapId).toBe(`map.${mm.mapId}.minimap`);
      expect(skin.buildings.house.levels, mm.mapId).toEqual([1, 2, 3, 4, 5].map((L) => `map.${mm.mapId}.house.${L}`));
    }
  });

  it('台湾 MapDef 仍是基线时，台湾皮肤 JSON 与多图改造前逐字节相同', () => {
    if (hashHex(readFileSync(MAP_DATA), 'sha256') !== TAIWAN_MAP_SHA256) return;
    expect(m.files['maps/taiwan.skin.json']!.sha256).toBe(TAIWAN_SKIN_SHA256);
  });

  it('共用精灵在 board.landmarks，其余企业/景观精灵在唯一引用它的图的分组', () => {
    for (const res of SHARED_LANDMARKS) expect(m.entries[`board.landmark.${res}`]!.group).toBe('board.landmarks');
    expect(m.entries['board.landmark.85']!.group).toBe('map.china');
    expect(m.entries['board.landmark.149']!.group).toBe('map.taiwan');
    expect(m.groups['board.landmarks']!.category).toBe('board');
  });
});

// ───────────────────────── 已构建的完整素材包 ─────────────────────────

const PACK = path.join(REPO, 'rich4-assets');
const packBuilt = existsSync(path.join(PACK, 'manifest.json'));

describe.skipIf(!packBuilt)('已构建的完整素材包（rich4-assets/）', () => {
  it('条目计数：图像按资源目录全收录，语音 1374、音效 99、音乐 25、FLIC 105；逐文件 sha256 一致', async () => {
    const r = await verifyPack({ ctx: originalCtx, packDir: PACK, log: quiet });
    expect(r.issues).toEqual([]);
    const m = JSON.parse(readFileSync(path.join(PACK, 'manifest.json'), 'utf8')) as PackManifestV1;
    const count = (pred: (k: string, e: PackManifestV1['entries'][string]) => boolean) =>
      Object.entries(m.entries).filter(([k, e]) => pred(k, e)).length;
    const cat = catalogV206();
    if (m.features.board && m.features.ui && m.features.fx && m.features.minigames) {
      for (const t of ['sprite', 'image', 'mask', 'flic'] as const) {
        expect(
          count((_, e) => e.type === t),
          t,
        ).toBe(cat.items.filter((it) => it.type === t).length);
      }
      expect(count((_, e) => e.type === 'flic')).toBe(105);
      expect(count((k) => k.startsWith('illustration.holiday.'))).toBe(82);
      expect(count((k) => k.startsWith('title.setup.bg'))).toBe(4);
      // manifest.maps 与数据包一致：rich4-data/maps 里有 MapDef 的原版地图都有皮肤（数据包更新后须重建素材包）
      const withData = ORIGINAL_MAPS.filter((mm) => existsSync(path.join(MAP_DIR, `${mm.mapId}.map.json`)));
      expect(Object.keys(m.maps).sort()).toEqual(withData.map((mm) => mm.mapId).sort());
    }
    if (m.features.voice) expect(count((k) => k.startsWith('voice.'))).toBe(1374);
    if (m.features.audio) expect(count((k) => k.startsWith('sfx.'))).toBe(99);
    if (m.features.music) expect(count((k) => k.startsWith('music.'))).toBe(25);
    if (m.features.video) {
      expect(count((k) => k.startsWith('video.'))).toBe(7);
      for (const k of ['video.flytw', 'video.flychina', 'video.flyjp', 'video.flyus'])
        expect(m.entries[k]?.type, k).toBe('video');
    }
    expect(m.license).toBe('private-personal-use');
  }, 180_000);
});
