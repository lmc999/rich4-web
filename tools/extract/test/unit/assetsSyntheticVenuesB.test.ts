/**
 * 合成素材包里场所屏第二组（ui/classic/venues/b）的条目：魔法屋（图集、13 区掩膜、施法 FLC）、拍卖厅、12 个 Q 版小人待机帧、
 * 公佈欄、监狱 / 恶人 / 医院。与原版包同键同组同帧数、帧尺寸与锚点同原版；掩膜区位与原版一致（12 个效果图标点落在区 e+1），
 * 监狱底图的 8 个窗洞是透明孔。输出到临时目录（不入库）。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type PackManifestV1, parsePackManifest } from '@rich4/shared/assets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { catalogV206 } from '../../src/assets/catalog.v206';
import { readPng } from '../../src/assets/pngRead';
import { buildSyntheticPack } from '../../src/assets/synthetic';
import {
  AUCTION_DIMS,
  BULLETIN_DIMS,
  CHIBI_IDLE_DIMS,
  HOSPITAL_DIMS,
  JAIL_DIMS,
  JAIL_WINDOWS,
  MAGIC_DIMS,
  MAGIC_ICON_AT,
  SYNTH_UI_MASKS,
  SYNTH_UI_SPRITES,
  SYNTH_VENUES_B,
  synthMagicMask,
  VILLAIN_DIMS,
} from '../../src/assets/syntheticUi';
import { ExtractContext, realpathLoose } from '../../src/context';
import { decodeFlcFrames, parseFlc } from '../../src/gfx/flc';

let root: string;
let dir: string;
let m: PackManifestV1;

interface AtlasJson {
  frames: Record<string, { frame: { x: number; y: number; w: number; h: number } }>;
  meta: { image: string; r4: { anchorsPx: Record<string, [number, number]> } };
}

const atlasOf = (key: string): { json: AtlasJson; dir: string } => {
  const e = m.entries[key]!;
  if (e.type !== 'sprite') throw new Error(key);
  const p = m.files[e.atlas[0]!]!.path;
  return { json: JSON.parse(readFileSync(path.join(dir, p), 'utf8')) as AtlasJson, dir: path.dirname(p) };
};

beforeAll(async () => {
  root = realpathLoose(mkdtempSync(path.join(tmpdir(), 'rich4-synth-venues-b-')));
  dir = path.join(root, '.cache', 'synthetic-pack');
  const ctx = new ExtractContext({ root, logger: { out: () => {}, err: () => {} } });
  await buildSyntheticPack({ ctx, outDir: dir });
  m = parsePackManifest(JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')));
}, 90_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const DIMS: Readonly<Record<string, readonly (readonly [number, number, number, number])[]>> = {
  'venue.magic.screen': MAGIC_DIMS,
  'venue.auction.screen': AUCTION_DIMS,
  'venue.bulletin.screen': BULLETIN_DIMS,
  'venue.jail.screen': JAIL_DIMS,
  'venue.jail.villains': VILLAIN_DIMS,
  'venue.hospital.screen': HOSPITAL_DIMS,
  ...Object.fromEntries(CHIBI_IDLE_DIMS.map((d, c) => [`venue.chibi.${c}.1`, [d]])),
};

describe('合成包：场所屏第二组', () => {
  it('精灵条目与原版包同键同组同帧数、置信度不是 guess', () => {
    const cat = new Map(catalogV206().items.map((it) => [it.key, it]));
    expect(SYNTH_VENUES_B.sprites.sort()).toEqual(Object.keys(DIMS).sort());
    for (const k of SYNTH_VENUES_B.sprites) {
      expect(SYNTH_UI_SPRITES, k).toContain(k);
      const e = m.entries[k]!;
      const it = cat.get(k)!;
      expect(e.type, k).toBe('sprite');
      expect(e.group, k).toBe(it.group);
      expect(e.confidence, k).not.toBe('guess');
      if (e.type === 'sprite' && it.type === 'sprite') {
        expect(e.frames.count, k).toBe(it.frames);
        expect(DIMS[k]!.length, k).toBe(it.frames);
      }
    }
  });

  it('每一帧的尺寸与锚点同原版', () => {
    for (const [k, dims] of Object.entries(DIMS)) {
      const { json } = atlasOf(k);
      for (const [f, [w, h, ax, ay]] of dims.entries()) {
        const name = `S#${k}/${f}`;
        const fr = json.frames[name]?.frame;
        expect(fr && [fr.w, fr.h], name).toEqual([w, h]);
        expect(json.meta.r4.anchorsPx[name], name).toEqual([ax, ay]);
      }
    }
  });

  it('魔法屋掩膜：640×480、13 区；12 个效果图标点落在区 e+1，女巫站的中心是区 13', () => {
    expect(Object.keys(SYNTH_UI_MASKS)).toContain('venue.magic.mask');
    const e = m.entries['venue.magic.mask']!;
    expect(e.type === 'mask' && [e.w, e.h, e.regions, e.group]).toEqual([640, 480, 13, 'venue.magic']);
    const png = readPng(new Uint8Array(readFileSync(path.join(dir, m.files[e.type === 'mask' ? e.file : '']!.path))));
    const data = synthMagicMask();
    expect(png.gray).toEqual(data);
    for (const [i, [x, y]] of MAGIC_ICON_AT.entries()) expect(data[y * 640 + x], `effect ${i}`).toBe(i + 1);
    expect(data[240 * 640 + 320]).toBe(13);
    expect(data[5 * 640 + 5]).toBe(0);
    expect(new Set(data)).toEqual(new Set(Array.from({ length: 14 }, (_, i) => i)));
  });

  it('魔法屋施法 FLC：640×480×25、71ms、不透明，可解码', () => {
    const e = m.entries['venue.magic.cast']!;
    expect(e.type === 'flic' && [e.w, e.h, e.frames, e.frameMs, e.transparency, e.group]).toEqual([
      640,
      480,
      25,
      71,
      'opaque',
      'venue.magic',
    ]);
    const flc = parseFlc(new Uint8Array(readFileSync(path.join(dir, m.files[e.type === 'flic' ? e.file : '']!.path))));
    expect(decodeFlcFrames(flc)).toHaveLength(25);
  });

  it('监狱底图：8 个窗洞是透明孔（窗洞中心 alpha 为 0，墙上不透明）', () => {
    const { json, dir: d } = atlasOf('venue.jail.screen');
    const fr = json.frames['S#venue.jail.screen/0']!.frame;
    const png = readPng(new Uint8Array(readFileSync(path.join(dir, d, json.meta.image))));
    const alpha = (x: number, y: number): number => png.rgba[((fr.y + y) * png.w + fr.x + x) * 4 + 3]!;
    for (const [x, y, w, h] of JAIL_WINDOWS) expect(alpha(x + (w >> 1), y + (h >> 1))).toBe(0);
    expect(alpha(10, 10)).toBe(255);
  });
});
