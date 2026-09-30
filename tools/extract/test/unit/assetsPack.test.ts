/**
 * 原版皮肤 A2：素材包构建（合成 MKF → buildPack → manifest 校验）、确定性、旧产物清理、输出目录守卫。
 * 只用合成数据与临时目录；不读原版文件、不需要 ffmpeg。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hashedPath, parseAtlas, parsePackManifest } from '@rich4/shared/assets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPack, parseParts } from '../../src/assets/build';
import type { Catalog, CatalogItem } from '../../src/assets/catalog.v206';
import type { FlicDef } from '../../src/assets/data/flic';
import { resolvePackOutputDir } from '../../src/assets/manifest';
import { readPng } from '../../src/assets/pngRead';
import { verifyPack } from '../../src/assets/verify';
import { ExtractContext, ExtractError, realpathLoose } from '../../src/context';
import { buildFlc, buildSmp, buildSpr, flcByteRun, flcColor256 } from '../helpers/buildGfx';
import { buildMkf } from '../helpers/buildMkf';
import { lzhufCompress } from '../helpers/lzhufEncode';

const quiet = { out: () => {}, err: () => {} };

// ───────────────────────── 合成资源 ─────────────────────────

/** RGB555 调色板：索引 i → 一个可区分的颜色；255 = 洋红（主人色占位） */
function palette(): number[] {
  const p = Array.from({ length: 256 }, (_, i) => ((i & 31) << 10) | (((i >> 2) & 31) << 5) | ((31 - (i & 31)) & 31));
  p[0] = 0x7c00; // 纯红：只有按索引判透明时底色才不会露出来
  p[255] = 0x7c1f;
  return p;
}

function sprFrames(n: number, w: number, h: number, owner = false) {
  return Array.from({ length: n }, (_, f) => ({
    w,
    h,
    ax: w >> 1,
    ay: h - 1,
    pixels: Array.from({ length: w * h }, (_, i) => {
      const x = i % w;
      const y = Math.trunc(i / w);
      if (x === 0) return 0; // 左列透明
      if (owner && y === 0) return 255;
      return 1 + ((f * 7 + i) % 200);
    }),
  }));
}

function raw16(w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 2);
  for (let i = 0; i < w * h; i++) {
    const x = i % w;
    const y = Math.trunc(i / w);
    const corner = (x < 2 || x >= w - 2) && (y < 2 || y >= h - 2);
    const v = corner ? 0 : 0x0421 * ((x + y) % 31) + 1;
    out[2 * i] = v & 0xff;
    out[2 * i + 1] = v >> 8;
  }
  return out;
}

const FLC_W = 8;
const FLC_H = 6;
function flc(): Uint8Array {
  const f0 = Uint8Array.from({ length: FLC_W * FLC_H }, (_, i) => (i % 3 === 0 ? 0 : 1 + (i % 5)));
  const f1 = Uint8Array.from({ length: FLC_W * FLC_H }, (_, i) => (i % 4 === 0 ? 0 : 2 + (i % 3)));
  const rgb = Uint8Array.from({ length: 256 * 3 }, (_, i) => (i * 37) & 255);
  return buildFlc({
    w: FLC_W,
    h: FLC_H,
    speed: 70,
    frames: [
      { subs: [flcColor256(0, rgb), flcByteRun(f0, FLC_W, FLC_H)] },
      { subs: [flcByteRun(f1, FLC_W, FLC_H)] },
      { subs: [flcByteRun(f0, FLC_W, FLC_H)] },
    ],
  });
}

const FLIC_DEF: FlicDef = {
  mkf: 'Data',
  res: 3,
  w: FLC_W,
  h: FLC_H,
  frames: 2,
  frameMs: 70,
  opaque: false,
  use: 'fx.test',
  desc: '合成 FLIC',
  sfx: 90,
  confidence: 'exe',
  evidence: 'synthetic',
};

function writeOriginal(root: string): void {
  const game = path.join(root, 'original', 'Game');
  mkdirSync(game, { recursive: true });
  const card = raw16(165, 256);
  const bombSpr = buildSpr(sprFrames(8, 5, 6), palette());
  const packed = lzhufCompress(bombSpr).bytes;
  writeFileSync(
    path.join(game, 'Data.mkf'),
    buildMkf([
      { body: buildSpr(sprFrames(16, 6, 7), palette()) },
      {
        body: buildSmp([
          { w: 3, h: 2, ax: 1, ay: 1, pixels: [0, 0x7fff, 0x001f, 0x03e0, 0, 0x7c00] },
          { w: 2, h: 2, pixels: [0x1234, 0, 0, 0x4321] },
        ]),
      },
      { body: card, imageOffset: 4, imageSize: card.length - 4 },
      { body: flc() },
      { body: packed, rawSize: bombSpr.length },
    ]),
  );
  const go = Uint8Array.from({ length: 72 * 67 }, (_, i) => 1 + (i % 4));
  writeFileSync(path.join(game, 'Panel.mkf'), buildMkf([{ body: go }]));
  writeFileSync(path.join(game, 'map.mkf'), buildMkf([{ body: buildSpr(sprFrames(8, 7, 8, true), palette()) }]));
}

function sprite(
  key: string,
  mkf: CatalogItem['mkf'],
  res: number,
  group: string,
  token: CatalogItem['token'],
  frames: number | 'x8',
  dirs: 1 | 8,
  kind: 'SPR' | 'SMP' = 'SPR',
  ownerMask = false,
): CatalogItem {
  return {
    type: 'sprite',
    kind,
    key,
    mkf,
    res,
    group,
    token,
    confidence: 'exe',
    src: ['synthetic'],
    desc: key,
    frames,
    dirs,
    frameRule: dirs === 8 ? 'actor-8dir' : 'ui-parts',
    transparency: kind === 'SPR' ? 'index0' : 'rgb0',
    ownerMask,
    anchor: 'frame',
  };
}

function testCatalog(over: Partial<Record<string, Partial<CatalogItem>>> = {}): Catalog {
  const items: CatalogItem[] = [
    sprite('char.0.walk', 'Data', 0, 'char.0', 'board', 'x8', 8),
    sprite('ui.cursor', 'Data', 1, 'ui.hud', 'ui', 2, 1, 'SMP'),
    {
      type: 'image',
      kind: 'RAW16',
      key: 'card.1',
      mkf: 'Data',
      res: 2,
      group: 'card',
      token: 'ui',
      confidence: 'visual',
      src: [],
      desc: '合成卡片',
      w: 165,
      h: 256,
      // 卡片插画不透明（与 catalog.v206 一致：exe 0x440c95 不透明拷贝）
      transparency: 'opaque',
    },
    {
      type: 'flic',
      kind: 'FLIC',
      key: 'fx.test',
      mkf: 'Data',
      res: 3,
      group: 'fx.board',
      token: 'fx',
      confidence: 'exe',
      src: [],
      desc: '合成 FLIC',
      def: FLIC_DEF,
    },
    sprite('object.bomb', 'Data', 4, 'object', 'board', 8, 8),
    {
      type: 'mask',
      kind: 'DATA',
      key: 'ui.goButton.mask',
      mkf: 'Panel',
      res: 0,
      group: 'ui.hud',
      token: 'ui',
      confidence: 'visual',
      src: [],
      desc: '合成掩膜',
      w: 72,
      h: 67,
      regions: 4,
    },
    sprite('board.chain', 'map', 0, 'board.buildings', 'board', 8, 8, 'SPR', true),
  ].map((it) => ({ ...it, ...(over[it.key] ?? {}) }) as CatalogItem);
  return { edition: 'v206', items, exclusions: [], counts: { Data: 5, Panel: 1, jump: 0, map: 1, help: 0 } };
}

let root: string;
let ctx: ExtractContext;
const IMAGES = parseParts('board,ui,fx,minigame');

beforeAll(() => {
  root = realpathLoose(mkdtempSync(path.join(tmpdir(), 'rich4-assets-a2-')));
  writeOriginal(root);
  ctx = new ExtractContext({ root, logger: quiet });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const build = (out: string, catalog = testCatalog()) =>
  buildPack({
    ctx,
    outDir: out,
    only: IMAGES,
    catalog,
    allowUnknown: true,
    reportDir: path.join(root, '.cache', 'report'),
  });

describe('assets build（合成 MKF）', () => {
  it('写出合契约的 manifest：精灵图集、RAW16 整图、FLC（带预压缩）、掩膜、主人色掩膜页', async () => {
    const r = await build(path.join(root, 'rich4-assets'));
    const m = parsePackManifest(JSON.parse(readFileSync(path.join(r.outDir, 'manifest.json'), 'utf8')));
    expect(m.packId).toBe(r.manifest.packId);
    expect(m.license).toBe('private-personal-use');
    expect(m.features).toMatchObject({ board: true, ui: true, fx: true, minigames: false, audio: false, video: false });
    expect(Object.keys(m.entries).sort()).toEqual(
      [
        'board.chain',
        'card.1',
        'char.0.walk',
        'data.flic-map',
        'fx.test',
        'object.bomb',
        'ui.cursor',
        'ui.goButton.mask',
      ].sort(),
    );
    const walk = m.entries['char.0.walk']!;
    expect(walk.type === 'sprite' && [walk.frames.count, walk.dirs, walk.frames.base]).toEqual([16, 8, 'Data#0']);
    const fx = m.entries['fx.test']!;
    // 没构建音频时，同步音效置空（契约要求 sfx 指向存在的 audio 条目）
    expect(fx.type === 'flic' && [fx.sfx, fx.durationMs, fx.transparency]).toEqual([null, 140, 'index0']);
    expect(m.files['flic/data/3.flc']!.variants?.gzip).toBeDefined();
    expect(m.entries['ui.goButton.mask']).toMatchObject({ type: 'mask', regions: 4 });
    expect(m.groups['board.buildings']).toMatchObject({ category: 'board', provenance: 'original' });
    // 文件名带内容哈希；主人色掩膜页与图集在同一组
    for (const [lp, f] of Object.entries(m.files)) expect(f.path).toBe(hashedPath(lp, f.sha256));
    expect(m.groups['board.buildings']!.files).toContain('sprites/map/0.mask.png');
    const atlas = parseAtlas(
      JSON.parse(readFileSync(path.join(r.outDir, m.files['sprites/map/0.json']!.path), 'utf8')),
    );
    expect(atlas.meta.r4.mask).toBe(path.basename(m.files['sprites/map/0.mask.png']!.path));
    // 覆盖率报告写在 .cache
    expect(existsSync(path.join(root, '.cache', 'report', 'coverage.v206.json'))).toBe(true);
    const v = await verifyPack({ ctx, packDir: r.outDir, full: true, catalog: testCatalog(), log: quiet });
    expect(v.issues).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('索引色图集页：索引 0 透明（即使 palette[0] 是纯红），其余像素颜色来自调色板；PNG 带派生标记', async () => {
    const r = await build(path.join(root, 'rich4-assets'));
    const m = r.manifest;
    const atlas = parseAtlas(
      JSON.parse(readFileSync(path.join(r.outDir, m.files['sprites/data/0.json']!.path), 'utf8')),
    );
    const png = readPng(new Uint8Array(readFileSync(path.join(r.outDir, m.files['sprites/data/0.png']!.path))));
    expect(png.colorType).toBe(3);
    expect(png.text['rich4:derived']).toBe('private');
    const f = atlas.frames['Data#0/0']!.frame;
    const px = (x: number, y: number) =>
      Array.from(png.rgba.subarray(((f.y + y) * png.w + f.x + x) * 4, ((f.y + y) * png.w + f.x + x) * 4 + 4));
    expect(px(0, 0)[3]).toBe(0);
    expect(px(1, 0)[3]).toBe(255);
    expect(atlas.meta.r4.anchorsPx['Data#0/0']).toEqual([3, 6]);
    // 主人色：底图里索引 255 透明，掩膜页为白
    const ma = parseAtlas(JSON.parse(readFileSync(path.join(r.outDir, m.files['sprites/map/0.json']!.path), 'utf8')));
    const base = readPng(new Uint8Array(readFileSync(path.join(r.outDir, m.files['sprites/map/0.png']!.path))));
    const mask = readPng(new Uint8Array(readFileSync(path.join(r.outDir, m.files['sprites/map/0.mask.png']!.path))));
    const g = ma.frames['map#0/0']!.frame;
    expect(base.rgba[((g.y + 0) * base.w + g.x + 1) * 4 + 3]).toBe(0);
    expect(mask.gray![(g.y + 0) * mask.w + g.x + 1]).toBe(255);
    expect(mask.gray![(g.y + 1) * mask.w + g.x + 1]).toBe(0);
  });

  it('确定性：两次构建（不同目录）manifest 与全部文件逐字节相同', async () => {
    const a = await build(path.join(root, '.cache', 'pack-a'));
    const b = await build(path.join(root, '.cache', 'pack-b'));
    expect(a.manifestSha256).toBe(b.manifestSha256);
    for (const f of Object.values(a.manifest.files)) {
      expect(readFileSync(path.join(a.outDir, f.path)).equals(readFileSync(path.join(b.outDir, f.path)))).toBe(true);
    }
  });

  it('重建时清理不再引用的旧产物（只删带哈希命名的文件）', async () => {
    const out = path.join(root, '.cache', 'pack-prune');
    await build(out);
    const stale = path.join(out, 'sprites', 'data', '99.deadbeef.png');
    const keep = path.join(out, 'sprites', 'data', 'README.txt');
    writeFileSync(stale, 'x');
    writeFileSync(keep, 'x');
    const r = await build(out);
    expect(r.pruned).toEqual(['sprites/data/99.deadbeef.png']);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(keep)).toBe(true);
    const v = await verifyPack({ ctx, packDir: out, catalog: testCatalog(), log: quiet });
    expect(v.orphans).toEqual(['sprites/data/README.txt']);
  });

  it('verify 能发现被篡改或缺失的文件', async () => {
    const out = path.join(root, '.cache', 'pack-tamper');
    const r = await build(out);
    const f = r.manifest.files['images/data/2.png']!;
    const p = path.join(out, f.path);
    const bytes = readFileSync(p);
    bytes[bytes.length - 20] ^= 0xff;
    writeFileSync(p, bytes);
    rmSync(path.join(out, r.manifest.files['flic/data/3.flc']!.path));
    const v = await verifyPack({ ctx, packDir: out, catalog: testCatalog(), log: quiet });
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => i.startsWith('images/data/2.png: sha256'))).toBe(true);
    expect(v.issues.some((i) => i.startsWith('flic/data/3.flc: 缺少文件'))).toBe(true);
  });

  it('帧数或类型与目录不符时失败（exit 1），不写 manifest', async () => {
    const out = path.join(root, '.cache', 'pack-bad');
    await expect(build(out, testCatalog({ 'board.chain': { frames: 16 } as Partial<CatalogItem> }))).rejects.toThrow(
      /E_ASSETS_FRAMES/,
    );
    await expect(build(out, testCatalog({ 'ui.cursor': { kind: 'SPR' } as Partial<CatalogItem> }))).rejects.toThrow(
      /E_ASSETS_KIND/,
    );
    expect(existsSync(path.join(out, 'manifest.json'))).toBe(false);
  });

  it('--only 解析：默认不含 video；别名 minigames/voice；未知值报错', () => {
    expect(parseParts(undefined)).toEqual(['board', 'ui', 'fx', 'minigame', 'audio', 'music']);
    expect(parseParts(undefined, true)).toContain('video');
    expect(parseParts('minigames,voice')).toEqual(['minigame', 'audio']);
    expect(() => parseParts('board,bogus')).toThrow(ExtractError);
  });
});

describe('指纹前置检查', () => {
  it('没有 exe 时 exit 2；exe 指纹未登记时 exit 3（可用 allowUnknown 放行）', async () => {
    const r2 = realpathLoose(mkdtempSync(path.join(tmpdir(), 'rich4-assets-fp-')));
    try {
      writeOriginal(r2);
      const c2 = new ExtractContext({ root: r2, logger: quiet });
      const opts = { ctx: c2, outDir: path.join(r2, 'rich4-assets'), only: IMAGES, catalog: testCatalog() };
      await expect(buildPack(opts)).rejects.toMatchObject({ exitCode: 2 });
      writeFileSync(path.join(r2, 'original', 'Game', 'RICH4.EXE'), Uint8Array.from([0x4d, 0x5a, 1, 2, 3]));
      await expect(buildPack(opts)).rejects.toMatchObject({ code: 'E_ASSETS_FINGERPRINT', exitCode: 3 });
      const ok = await buildPack({ ...opts, allowUnknown: true, reportDir: path.join(r2, '.cache', 'r') });
      expect(ok.warnings.some((w) => w.startsWith('exe 指纹未登记'))).toBe(true);
      expect(ok.manifest.source.exeSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(Object.keys(ok.manifest.source.files)).toContain('Game/RICH4.EXE');
    } finally {
      rmSync(r2, { recursive: true, force: true });
    }
  });
});

describe('素材输出目录守卫（git check-ignore）', () => {
  let repo: string;
  let rctx: ExtractContext;
  beforeAll(() => {
    repo = realpathLoose(mkdtempSync(path.join(tmpdir(), 'rich4-assets-guard-')));
    const g = spawnSync('git', ['init', '-q'], { cwd: repo });
    if (g.status !== 0) throw new Error('git init 失败');
    writeFileSync(path.join(repo, '.gitignore'), 'rich4-assets/\n.cache/\nother-ignored/\napps/client/public/pack/\n');
    mkdirSync(path.join(repo, 'original'), { recursive: true });
    rctx = new ExtractContext({ root: repo, logger: quiet });
  });
  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('允许 rich4-assets/ 与 .cache/ 下（已被忽略）', () => {
    expect(resolvePackOutputDir(rctx, 'rich4-assets')).toBe(path.join(repo, 'rich4-assets'));
    expect(resolvePackOutputDir(rctx, '.cache/rich4-assets')).toBe(path.join(repo, '.cache', 'rich4-assets'));
  });

  it('拒绝未被 git 忽略的路径、apps/*/public/**、仓库根、original/，以及被忽略但不在 rich4-assets/.cache 下的目录', () => {
    const code = (dir: string): string => {
      try {
        resolvePackOutputDir(rctx, dir);
        return 'ok';
      } catch (e) {
        return e instanceof ExtractError ? e.code : String(e);
      }
    };
    expect(code('src/out')).toBe('E_ASSETS_OUT_NOT_IGNORED');
    expect(code('apps/client/public/pack')).toBe('E_ASSETS_OUT_PUBLIC');
    expect(code('.')).toBe('E_ASSETS_OUT_ROOT');
    expect(code('original/x')).toBe('E_READONLY_SOURCE');
    expect(code('other-ignored/x')).toBe('E_ASSETS_OUT_POLICY');
  });

  it('buildPack 在写任何文件之前就拒绝非忽略路径', async () => {
    await expect(
      buildPack({ ctx: rctx, outDir: 'src/out', only: IMAGES, catalog: testCatalog(), allowUnknown: true }),
    ).rejects.toThrow(/E_ASSETS_OUT_NOT_IGNORED/);
    expect(existsSync(path.join(repo, 'src'))).toBe(false);
  });
});
