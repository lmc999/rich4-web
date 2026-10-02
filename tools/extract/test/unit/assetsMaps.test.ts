/**
 * 原版皮肤 A2 多图：合成的 MapDat（两张环路图，gm 0 / 1）+ map.mkf（两块地面、住宅、设施与企业/景观精灵）→ buildPack：
 * - 每张有地面的图各生成一份皮肤，绑定各自的原版资源哈希与几何摘要，精灵集合按资源目录的 maps 逐项核对；
 * - 缺 MapDef 的图只跳过皮肤并告警（verify 同样只告警），strict 时失败（exit 2）；MapDef 的 id / gm 不符时失败；
 * - --map-data 的目录 / 旧单文件（只作为台湾）两种用法。
 * 只用合成数据（数值、名称、坐标与原版无关）与临时目录；不读原版文件、不需要 ffmpeg。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EXACT_TABLE_SPAN, type MapSkinV1, mapSkinBindingOf, parseMapSkin } from '@rich4/shared/assets';
import type { MapDef } from '@rich4/shared/data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPack, mapDefPath, parseParts } from '../../src/assets/build';
import {
  type Catalog,
  type CatalogItem,
  FACILITY_KINDS,
  landmarkGroup,
  type OriginalMap,
} from '../../src/assets/catalog.v206';
import type { ViewTablesInput } from '../../src/assets/skin';
import { verifyPack } from '../../src/assets/verify';
import { mapDataOption } from '../../src/commands/assets';
import { ExtractContext, realpathLoose } from '../../src/context';
import { buildMapDef } from '../../src/map/build';
import { parseOverrides } from '../../src/map/overrides';
import { parseMapRaw } from '../../src/map/parseRaw';
import type { RawSource } from '../../src/map/rawTypes';
import { buildGnd, buildSpr } from '../helpers/buildGfx';
import { buildMapResource, type MapSpec } from '../helpers/buildMapResource';
import { buildMkf } from '../helpers/buildMkf';
import { ringMapSpec } from '../helpers/syntheticMap';

const quiet = { out: () => {}, err: () => {} };

// ───────────────────────── 合成原版 ─────────────────────────

/** 两张合成图：精灵资源号（spriteRes + 26）刻意让 71、72 两图共用 */
const MAPS: readonly OriginalMap[] = [
  { mapId: 'aa', gm: 0, label: '甲', companies: [70, 71], scenery: [72, 73, 74] },
  { mapId: 'bb', gm: 1, label: '乙', companies: [71, 75], scenery: [72, 76, 77] },
];
const MAP_RES = 78;
const GND_BLOCKS = 26;

function specFor(m: OriginalMap, w: number): MapSpec {
  const spec = ringMapSpec({ w, h: 9, cut: true, amp: 6 });
  spec.companies = spec.companies!.map((c, i) => ({ ...c, spriteRes: m.companies[i]! - 26 }));
  spec.landscapes = spec.landscapes!.map((l, i) => ({ ...l, spriteRes: m.scenery[i]! - 26 }));
  return spec;
}
const RESOURCES = [buildMapResource(specFor(MAPS[0]!, 10)), buildMapResource(specFor(MAPS[1]!, 11))];

function palette(): number[] {
  const p = Array.from({ length: 256 }, (_, i) => ((i & 31) << 10) | (((i >> 2) & 31) << 5));
  p[255] = 0x7c1f;
  return p;
}

/** 8 帧 3×3 的 SPR（中间一点为主人色 255） */
function spr8(): Uint8Array {
  return buildSpr(
    Array.from({ length: 8 }, (_, f) => ({ w: 3, h: 3, ax: 1, ay: 2, pixels: [0, 1 + f, 0, 2, 255, 2, 0, 3, 0] })),
    palette(),
  );
}

function gnd(seed: number): Uint8Array {
  const n = GND_BLOCKS * GND_BLOCKS;
  const tiles = Array.from({ length: n }, (_, i) => new Uint8Array(1024).fill(1 + ((i + seed) % 7)));
  return buildGnd(GND_BLOCKS, GND_BLOCKS, palette(), tiles);
}

function writeOriginal(root: string): void {
  const game = path.join(root, 'original', 'Game');
  mkdirSync(game, { recursive: true });
  writeFileSync(path.join(game, 'MapDat.mkf'), buildMkf(RESOURCES.map((body) => ({ body }))));
  const map = Array.from({ length: MAP_RES }, (_, i) => ({ body: i === 0 ? gnd(0) : i === 2 ? gnd(3) : spr8() }));
  writeFileSync(path.join(game, 'map.mkf'), buildMkf(map));
}

const SOURCE: Omit<RawSource, 'byteLength' | 'resourceSha256' | 'resource'> = {
  id: 'v206-mapdat',
  edition: 'v206',
  file: 'Game/MapDat.mkf',
  fileSha256: '0'.repeat(64),
  knownFileId: null,
  container: 'MapDat.mkf',
  compressed: false,
};

/** 与 map build 同一流程生成 MapDef（meta.source.resourceSha256 与 MapDat 里的资源一致） */
function mapDefOf(m: OriginalMap): MapDef {
  const raw = parseMapRaw(RESOURCES[m.gm]!, { ...SOURCE, resource: m.gm }, m.gm);
  const ov = parseOverrides({ mapKey: m.mapId, source: { id: 'v206-mapdat' } });
  return buildMapDef(raw, ov, { mapKey: m.mapId, strict4: true }).def;
}

// ───────────────────────── 资源目录 ─────────────────────────

function spr(key: string, res: number, group: string, dirs: 1 | 8, ownerMask: boolean): CatalogItem {
  return {
    type: 'sprite',
    kind: 'SPR',
    key,
    mkf: 'map',
    res,
    group,
    token: 'board',
    confidence: 'exe',
    src: ['synthetic'],
    desc: key,
    frames: 8,
    dirs,
    frameRule: dirs === 8 ? 'building-8' : 'decor',
    transparency: 'index0',
    ownerMask,
    anchor: 'frame',
  };
}

function testCatalog(maps: readonly OriginalMap[] = MAPS): Catalog {
  const items: CatalogItem[] = [];
  for (const m of maps) {
    items.push({
      type: 'ground',
      kind: 'GND',
      key: `map.${m.mapId}.ground`,
      mkf: 'map',
      res: 2 * m.gm,
      group: `map.${m.mapId}`,
      token: 'board',
      confidence: 'exe',
      src: [],
      desc: '合成地面',
      mapId: m.mapId,
      cols: 2,
      rows: 2,
    });
    for (let L = 1; L <= 5; L++) {
      items.push(spr(`map.${m.mapId}.house.${L}`, 27 + 5 * m.gm + L - 1, `map.${m.mapId}`, 8, true));
    }
  }
  items.push(
    spr('board.decor', 12, 'board.common', 1, false),
    spr('board.ownerMark', 13, 'board.common', 1, false),
    spr('board.lotHighlight', 14, 'board.common', 1, false),
    spr('board.chain', 47, 'board.buildings', 8, true),
    spr('board.facility.park', 48, 'board.buildings', 8, true),
  );
  FACILITY_KINDS.forEach((kind, i) => {
    for (let L = 1; L <= 5; L++)
      items.push(spr(`board.facility.${kind}.${L}`, 48 + i * 5 + L, 'board.buildings', 8, true));
  });
  const companies = new Set(maps.flatMap((m) => m.companies));
  for (const res of [...new Set(maps.flatMap((m) => [...m.companies, ...m.scenery]))].sort((a, b) => a - b)) {
    items.push(spr(`board.landmark.${res}`, res, landmarkGroup(res, maps), 8, companies.has(res)));
  }
  items.sort((a, b) => a.res - b.res);
  return {
    edition: 'v206',
    items,
    exclusions: [],
    counts: { Data: 0, Panel: 0, jump: 0, map: MAP_RES, help: 0 },
    maps,
  };
}

/** 线性视角表（[view][dy+14][dx+14] → (sy, sx)），与 exe 表同一轴序 */
function viewTables(): ViewTablesInput {
  const half = (EXACT_TABLE_SPAN - 1) / 2;
  const data: [number, number][][] = [];
  for (let v = 0; v < 8; v++) {
    const t: [number, number][] = [];
    for (let dy = -half; dy <= half; dy++)
      for (let dx = -half; dx <= half; dx++) t.push([-10 * dx + 25 * dy + v, 36 * dx + 15 * dy]);
    data.push(t);
  }
  return {
    cellScreen: { va: '0xtest', data },
    subcell: { va: '0xtest', data: Array.from({ length: 8 }, () => [0, 0, 0, 0]) },
  };
}

// ───────────────────────── 测试 ─────────────────────────

let root: string;
let ctx: ExtractContext;
const DEFS = MAPS.map(mapDefOf);

function writeDefs(dir: string, defs: readonly MapDef[]): string {
  const abs = path.join(root, dir);
  mkdirSync(abs, { recursive: true });
  for (const d of defs) writeFileSync(path.join(abs, `${d.id}.map.json`), JSON.stringify(d));
  return abs;
}

const build = (out: string, opts: Partial<Parameters<typeof buildPack>[0]> = {}) =>
  buildPack({
    ctx,
    outDir: path.join(root, '.cache', out),
    only: parseParts('board'),
    catalog: testCatalog(),
    allowUnknown: true,
    viewTables: viewTables(),
    reportDir: path.join(root, '.cache', 'report'),
    log: quiet,
    ...opts,
  });

beforeAll(() => {
  root = realpathLoose(mkdtempSync(path.join(tmpdir(), 'rich4-assets-maps-')));
  writeOriginal(root);
  ctx = new ExtractContext({ root, logger: quiet });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('多图地图皮肤（合成 MapDat + map.mkf）', () => {
  it('合成 MapDef 可用：两张图 validateMap strict4 通过，gm 与 id 对上', () => {
    expect(DEFS.map((d) => [d.id, d.globalMapId])).toEqual([
      ['aa', 0],
      ['bb', 1],
    ]);
    expect(DEFS[0]!.tiles.length).not.toBe(DEFS[1]!.tiles.length);
  });

  it('每张图各一份皮肤：绑定各自的资源哈希与几何，住宅键按 mapId，企业/景观精灵按 spriteRes+26', async () => {
    const dir = writeDefs('data-all', DEFS);
    const r = await build('pack-all', { mapDataDir: dir });
    expect(r.mapsBuilt).toEqual(['aa', 'bb']);
    expect(r.mapsSkipped).toEqual([]);
    const m = r.manifest;
    const skins: MapSkinV1[] = [];
    for (const d of DEFS) {
      const mp = m.maps[d.id]!;
      expect(mp.group).toBe(`map.${d.id}`);
      expect(mp.binding).toEqual(mapSkinBindingOf(d));
      const skin = parseMapSkin(JSON.parse(readFileSync(path.join(r.outDir, m.files[mp.skin]!.path), 'utf8')));
      skins.push(skin);
      expect(skin.buildings.house.levels).toEqual([1, 2, 3, 4, 5].map((L) => `map.${d.id}.house.${L}`));
      expect(skin.ground.chunks.every((c) => c.file.startsWith(`ground/${d.id}/`))).toBe(true);
      expect(skin.minimap).toBeNull();
    }
    expect(skins[0]!.buildings.companies.map((c) => c.sprite)).toEqual(['board.landmark.70', 'board.landmark.71']);
    expect(skins[1]!.buildings.companies.map((c) => c.sprite)).toEqual(['board.landmark.71', 'board.landmark.75']);
    expect(skins[1]!.scenery.map((s) => s.sprite)).toEqual([
      'board.landmark.72',
      'board.landmark.76',
      'board.landmark.77',
    ]);
    // 共用精灵进 board.landmarks，专属精灵进各自的图分组
    expect(m.entries['board.landmark.71']!.group).toBe('board.landmarks');
    expect(m.entries['board.landmark.72']!.group).toBe('board.landmarks');
    expect(m.entries['board.landmark.70']!.group).toBe('map.aa');
    expect(m.entries['board.landmark.77']!.group).toBe('map.bb');
    const v = await verifyPack({ ctx, packDir: r.outDir, full: true, catalog: testCatalog(), log: quiet });
    expect(v.issues).toEqual([]);
    expect(v.warnings.filter((w) => w.includes('manifest.maps'))).toEqual([]);
  });

  it('缺某张图的 MapDef：只跳过它的皮肤并告警（地面照常入包），verify 也只告警；strict 时 exit 2', async () => {
    const dir = writeDefs('data-aa', [DEFS[0]!]);
    const r = await build('pack-aa', { mapDataDir: dir });
    expect(r.mapsBuilt).toEqual(['aa']);
    expect(r.mapsSkipped).toEqual(['bb']);
    expect(r.warnings.some((w) => w.includes('bb') && w.includes('跳过'))).toBe(true);
    expect(Object.keys(r.manifest.maps)).toEqual(['aa']);
    expect(r.manifest.groups['map.bb']!.files.some((f) => f.startsWith('ground/bb/'))).toBe(true);
    const report = JSON.parse(readFileSync(path.join(root, '.cache', 'report', 'build.v206.json'), 'utf8')) as {
      maps: { built: string[]; skipped: string[] };
    };
    expect(report.maps).toMatchObject({ built: ['aa'], skipped: ['bb'] });
    const v = await verifyPack({ ctx, packDir: r.outDir, catalog: testCatalog(), log: quiet });
    expect(v.ok).toBe(true);
    expect(v.warnings.some((w) => w.includes('manifest.maps 没有 bb'))).toBe(true);
    await expect(build('pack-strict', { mapDataDir: dir, strict: true })).rejects.toMatchObject({
      code: 'E_ASSETS_SOURCE_MISSING',
      exitCode: 2,
    });
  });

  it('MapDef 的 id 或 gm 与资源目录不符时失败；raw 引用的精灵集合与目录不符时失败', async () => {
    const dir = path.join(root, 'data-swapped');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'aa.map.json'), JSON.stringify(DEFS[1]));
    await expect(build('pack-swapped', { mapDataDir: dir })).rejects.toThrow(/E_ASSETS_MAP|id=bb/);
    const all = writeDefs('data-all2', DEFS);
    const wrong = MAPS.map((m) => (m.mapId === 'bb' ? { ...m, scenery: [72, 76] } : m));
    await expect(build('pack-wrong', { mapDataDir: all, catalog: { ...testCatalog(), maps: wrong } })).rejects.toThrow(
      /E_SKIN_MISMATCH|与资源目录不符/,
    );
  });

  it('两次构建（不同目录）manifest 相同', async () => {
    const dir = writeDefs('data-det', DEFS);
    const a = await build('pack-det-a', { mapDataDir: dir });
    const b = await build('pack-det-b', { mapDataDir: dir });
    expect(a.manifestSha256).toBe(b.manifestSha256);
  });
});

describe('MapDef 位置：--map-data 目录或旧单文件', () => {
  it('mapDefPath：目录下的 <mapId>.map.json；旧单文件只作为台湾，其他图仍按目录找；默认 rich4-data/maps', () => {
    const r = '/repo';
    expect(mapDefPath(r, 'china')).toBe(path.resolve(r, 'rich4-data', 'maps', 'china.map.json'));
    expect(mapDefPath(r, 'taiwan', { mapDataDir: 'x/maps' })).toBe(path.resolve(r, 'x', 'maps', 'taiwan.map.json'));
    expect(mapDefPath(r, 'taiwan', { mapData: 'tw.json' })).toBe(path.resolve(r, 'tw.json'));
    expect(mapDefPath(r, 'usa', { mapData: 'tw.json', mapDataDir: 'd' })).toBe(path.resolve(r, 'd', 'usa.map.json'));
  });

  it('mapDataOption：目录 → mapDataDir，文件 → mapData（台湾），都不是 → E_ARGS', async () => {
    const dir = writeDefs('data-opt', [DEFS[0]!]);
    expect(await mapDataOption(ctx, undefined)).toEqual({});
    expect(await mapDataOption(ctx, dir)).toEqual({ mapDataDir: dir });
    const file = path.join(dir, 'aa.map.json');
    expect(await mapDataOption(ctx, file)).toEqual({ mapData: file });
    await expect(mapDataOption(ctx, path.join(root, 'nope'))).rejects.toMatchObject({ code: 'E_ARGS' });
  });
});
