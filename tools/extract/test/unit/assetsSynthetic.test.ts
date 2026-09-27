/**
 * 原版皮肤 A2：fixture 地图的合成素材包（CI 覆盖原版渲染路径；审查修正 6）与 assets CLI（synth / verify / ls）。
 * 合成包不含任何原版字节；输出到临时目录（不入库）。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkMapSkinBinding, mapSkinBindingOf, parseMapSkin, parsePackManifest } from '@rich4/shared/assets';
import { buildFixtureMaps } from '@rich4/shared/data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { catalogV206 } from '../../src/assets/catalog.v206';
import { readPng } from '../../src/assets/pngRead';
import { buildSyntheticPack, synthGnd } from '../../src/assets/synthetic';
import {
  encodeFlc,
  GO_REGION,
  GO_SLOT,
  SYNTH_UI_FLICS,
  SYNTH_UI_SPRITES,
  synthGoMask,
} from '../../src/assets/syntheticUi';
import { main } from '../../src/cli';
import { ExitCode, ExtractContext, realpathLoose } from '../../src/context';
import { decodeFlcFrames, parseFlc } from '../../src/gfx/flc';
import { parseGnd } from '../../src/gfx/gnd';
import { isDerivedPng } from '../../src/gfx/png';

let root: string;
let out: string[];
const logger = { out: (l: string) => out.push(l), err: (l: string) => out.push(l) };
const run = (...args: string[]) => main([...args, '--root', root], { logger, cwd: root });

beforeAll(() => {
  root = realpathLoose(mkdtempSync(path.join(tmpdir(), 'rich4-synth-')));
  out = [];
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('合成素材包', () => {
  it('assets synth → exit 0；两张 fixture 地图的皮肤绑定 fixture 身份，棋盘类条目与原版包同键', async () => {
    const dir = path.join(root, '.cache', 'synthetic-pack');
    expect(await run('assets', 'synth', '--out', dir)).toBe(ExitCode.OK);
    const m = parsePackManifest(JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')));
    expect(m.generator).toBe('rich4-extract/synthetic@1');
    expect(m.source).toEqual({ files: {}, exeSha256: null });
    expect(m.features.board).toBe(true);
    for (const def of buildFixtureMaps()) {
      const mp = m.maps[def.id]!;
      expect(mp.binding).toEqual(mapSkinBindingOf(def));
      const skin = parseMapSkin(JSON.parse(readFileSync(path.join(dir, m.files[mp.skin]!.path), 'utf8')));
      expect(checkMapSkinBinding(skin, def)).toEqual([]);
      expect(skin.world).toEqual({ w: def.grid.w * 32, h: def.grid.h * 32 });
      expect(skin.ground.chunks).toHaveLength(4);
    }
    const boardKeys = catalogV206()
      .items.filter((it) => it.type === 'sprite' && it.token === 'board' && !it.group.startsWith('map.'))
      .map((it) => it.key);
    for (const k of boardKeys) expect(m.entries[k]?.type, k).toBe('sprite');
    const walk = m.entries['char.0.walk']!;
    expect(walk.type === 'sprite' && [walk.frames.count, walk.dirs]).toEqual([72, 8]);
    for (const g of Object.values(m.groups)) expect(g.provenance).toBe('synthetic');
    // 合成内容不是原版派生：PNG 不写派生标记
    const png = Object.values(m.files).find((f) => f.contentType === 'image/png')!;
    expect(isDerivedPng(new Uint8Array(readFileSync(path.join(dir, png.path))))).toBe(false);
  }, 60_000);

  it('assets verify --full 通过；assets ls 能列出分组内的构建结果', async () => {
    const dir = path.join(root, '.cache', 'synthetic-pack');
    out = [];
    expect(await run('assets', 'verify', '--out', dir, '--full')).toBe(ExitCode.OK);
    expect(out.some((l) => l.includes('0 处不符'))).toBe(true);
    out = [];
    expect(await run('assets', 'ls', '--out', dir, '--group', 'char.0', '--json')).toBe(ExitCode.OK);
    const rows = JSON.parse(out.join('\n')) as { key: string; built: boolean }[];
    const sprites = rows.filter((r) => r.key.startsWith('char.0.') && !/emote|parachute/.test(r.key));
    expect(sprites).toHaveLength(21);
    expect(sprites.every((r) => r.built)).toBe(true);
  }, 60_000);

  it('确定性：同输入两次生成的 manifest 字节相同', async () => {
    const ctx = new ExtractContext({ root, logger: { out: () => {}, err: () => {} } });
    const a = await buildSyntheticPack({ ctx, outDir: path.join(root, '.cache', 'synth-a') });
    const b = await buildSyntheticPack({ ctx, outDir: path.join(root, '.cache', 'synth-b') });
    expect(a.manifestSha256).toBe(b.manifestSha256);
  }, 60_000);

  it('经典外壳 UI 条目：与原版包同键同组同帧数；GO 掩膜区号语义同原版；月历页烘焙太阳 / 月亮；滚骰 FLC 可解析', () => {
    const dir = path.join(root, '.cache', 'synthetic-pack');
    const m = parsePackManifest(JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')));
    expect(m.features.ui).toBe(true);
    const cat = new Map(catalogV206().items.map((it) => [it.key, it]));
    for (const k of SYNTH_UI_SPRITES) {
      const e = m.entries[k]!;
      const it = cat.get(k)!;
      expect(e.type, k).toBe('sprite');
      expect(e.group, k).toBe(it.group);
      if (e.type === 'sprite' && it.type === 'sprite') expect(e.frames.count, k).toBe(it.frames);
    }
    const read = (lp: string) => readPng(new Uint8Array(readFileSync(path.join(dir, m.files[lp]!.path))), lp);
    const atlasOf = (key: string) => {
      const e = m.entries[key]!;
      if (e.type !== 'sprite') throw new Error(key);
      return JSON.parse(readFileSync(path.join(dir, m.files[e.atlas[0]!]!.path), 'utf8')) as {
        frames: Record<string, { frame: { x: number; y: number; w: number; h: number } }>;
        meta: { image: string; r4: { anchorsPx: Record<string, [number, number]> } };
      };
    };
    // 客户端布局依赖的帧尺寸与锚点
    const go = atlasOf('ui.goButton');
    expect(go.frames['S#ui.goButton/0']!.frame).toMatchObject({ w: 72, h: 67 });
    for (let i = 6; i < 12; i++) expect(go.frames[`S#ui.goButton/${i}`]!.frame).toMatchObject({ w: 15, h: 15 });
    const cal = atlasOf('ui.calendar');
    expect(cal.frames['S#ui.calendar/8']!.frame).toMatchObject({ w: 24, h: 23 });
    expect(cal.meta.r4.anchorsPx['S#ui.calendar/8']).toEqual([12, 11]);
    expect(cal.frames['S#ui.calendar/10']!.frame).toMatchObject({ w: 20, h: 20 });
    expect(cal.meta.r4.anchorsPx['S#ui.calendar/10']).toEqual([10, 10]);
    const common = atlasOf('ui.common');
    expect(common.frames['S#ui.common/5']!.frame).toMatchObject({ w: 195, h: 133 });
    for (let i = 18; i < 22; i++) expect(common.frames[`S#ui.common/${i}`]!.frame).toMatchObject({ w: 25, h: 26 });
    // 月历页（图4）在 (10,9) 画着未选中的太阳（图9）
    const calPage = read(
      Object.keys(m.files).find((lp) => m.files[lp]!.path.endsWith('.png') && lp.includes('ui.calendar'))!,
    );
    const px = (img: typeof calPage, x: number, y: number) => [
      ...img.rgba.slice((y * img.w + x) * 4, (y * img.w + x) * 4 + 4),
    ];
    const p4 = cal.frames['S#ui.calendar/4']!.frame;
    const s9 = cal.frames['S#ui.calendar/9']!.frame;
    expect(px(calPage, p4.x + 10 + 12, p4.y + 9 + 11)).toEqual(px(calPage, s9.x + 12, s9.y + 11));
    // GO 掩膜：1 竖槽、2 边框、3 钮面、4 四角
    const mk = m.entries['ui.goButton.mask']!;
    expect(mk.type === 'mask' && [mk.w, mk.h, mk.regions]).toEqual([72, 67, 4]);
    const mask = read(mk.type === 'mask' ? mk.file : '');
    const at = (x: number, y: number) => mask.gray![y * 72 + x];
    expect(at(0, 0)).toBe(GO_REGION.outside);
    expect(at(71, 66)).toBe(GO_REGION.outside);
    expect(at(GO_SLOT.x0, GO_SLOT.y0)).toBe(GO_REGION.slot);
    expect(at(GO_SLOT.x1, GO_SLOT.y1)).toBe(GO_REGION.slot);
    expect(at(45, 33)).toBe(GO_REGION.face);
    expect(at(25, 3)).toBe(GO_REGION.rim);
    expect(new Set(synthGoMask())).toEqual(new Set([1, 2, 3, 4]));
    // 滚骰 FLC：头部与条目一致，逐帧可解
    for (const k of SYNTH_UI_FLICS) {
      const e = m.entries[k]!;
      if (e.type !== 'flic') throw new Error(k);
      const flc = parseFlc(new Uint8Array(readFileSync(path.join(dir, m.files[e.file]!.path))), k);
      expect([flc.width, flc.height, flc.frames, flc.speed]).toEqual([e.w, e.h, e.frames, e.frameMs]);
      const frames = decodeFlcFrames(flc);
      expect(frames).toHaveLength(e.frames);
      expect(frames[0]!.pixels.some((v) => v !== 0)).toBe(true);
    }
  });

  it('自写 FLC 编码器：BYTE_RUN 往返无损（长段、短段、行尾）', () => {
    const w = 300;
    const h = 3;
    const a = new Uint8Array(w * h);
    for (let i = 0; i < a.length; i++) a[i] = i % 7 === 0 ? 5 : i < 200 ? 1 : (i * 13) & 0xff;
    const pal = new Uint8Array(768).map((_, i) => i & 0xff);
    const flc = parseFlc(encodeFlc(w, h, 20, [a, a.map((v) => 255 - v)], pal), 't');
    const frames = decodeFlcFrames(flc);
    expect([...frames[0]!.pixels]).toEqual([...a]);
    expect([...frames[1]!.pixels]).toEqual([...a.map((v) => 255 - v)]);
    expect([...frames[0]!.palette]).toEqual([...pal]);
  });

  it('合成 GND 与原版格式相同（头、恒等排布、2304 以外的任意尺寸）', () => {
    for (const def of buildFixtureMaps()) {
      const g = parseGnd(synthGnd(def), def.id);
      expect([g.cols, g.rows, g.identityLayout]).toEqual([def.grid.w, def.grid.h, true]);
    }
  });

  it('输出目录不在 rich4-assets/ 或 .cache/ 下时拒绝（git 不可用时只放行这两处）', async () => {
    out = [];
    expect(await run('assets', 'synth', '--out', path.join(root, 'src', 'pack'))).toBe(ExitCode.STRUCTURE);
    expect(out.join('\n')).toMatch(/E_ASSETS_OUT_NOT_IGNORED/);
  });
});
