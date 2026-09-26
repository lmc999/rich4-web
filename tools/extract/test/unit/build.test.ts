import { computeMapDataHash, MapDefSchema, type StockDef, validateMap } from '@rich4/shared/data';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ExitCode, ExtractError } from '../../src/context';
import { canonicalJson } from '../../src/io/writeCanonicalJson';
import { buildMapDef, classifyIssues } from '../../src/map/build';
import { emptyOverrides, parseOverrides } from '../../src/map/overrides';
import { manifestEntry } from '../../src/map/pack';
import { parseMapRaw } from '../../src/map/parseRaw';
import type { MapDataRaw, RawSource } from '../../src/map/rawTypes';
import { buildMapResource, type MapSpec } from '../helpers/buildMapResource';
import { type RingOptions, ringMapSpec } from '../helpers/syntheticMap';

const SOURCE: Omit<RawSource, 'byteLength' | 'resourceSha256'> = {
  id: 'v206-mapdat',
  edition: 'v206',
  file: 'Game/MapDat.mkf',
  fileSha256: '0'.repeat(64),
  knownFileId: null,
  container: 'MapDat.mkf',
  resource: 0,
  compressed: false,
};
const rawOf = (spec: MapSpec): MapDataRaw => parseMapRaw(buildMapResource(spec), SOURCE, 0);

/** 虚构股票（仅测试用：D2 起由 exe 表提供） */
const STOCKS: { stock: Omit<StockDef, 'nameKey'>; name: string }[] = [0, 1, 2].map((index) => ({
  stock: {
    index,
    hasCompany: index < 2,
    float: 10000,
    initPriceCents: 1000 * (index + 1),
    volatility: 1,
    volatilityF32: '3f800000',
  },
  name: `測試股${index}`,
}));

const ov = (extra: Record<string, unknown> = {}) =>
  parseOverrides({ mapKey: 't', source: { id: 'v206-mapdat' }, ...extra });

function build(opt: RingOptions, extra: Record<string, unknown> = {}, stocks = true) {
  return buildMapDef(rawOf(ringMapSpec(opt)), ov(extra), {
    mapKey: 't',
    strict4: true,
    ...(stocks ? { stocks: STOCKS } : {}),
  });
}

describe('build：合成小地图 semantic → normalize → MapDef', () => {
  const r = build({ w: 10, h: 9, cut: true, amp: 6 });

  it('validateMap（strict4）ok，只有预期的警告', () => {
    expect(r.validation.ok).toBe(true);
    const codes = new Set(r.validation.issues.map((i) => i.code));
    for (const c of codes) expect(['W_LINK_ONEWAY', 'W_DEADEND']).toContain(c);
    expect(r.exitCode).toBe(ExitCode.OK);
    expect(r.geometry.report.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('结构满足 zod schema；dataHash 可复算；计数与 raw 一致', () => {
    expect(MapDefSchema.safeParse(r.def).success).toBe(true);
    expect(computeMapDataHash(r.def)).toBe(r.def.meta.dataHash);
    expect(r.def.meta.counts).toEqual(r.semantic.counts);
    expect(r.def.meta.source).toEqual({
      id: 'v206-mapdat',
      fileSha256: '0'.repeat(64),
      resourceSha256: r.semantic.source.resourceSha256,
    });
  });

  it('对角边用 L 形 via；via 在 roadCells 中且两端互为镜像', () => {
    expect(r.geometry.report.routes.diagonal).toBeGreaterThan(0);
    const road = new Set(r.def.roadCells.map((c) => `${c.x},${c.y}`));
    const byId = new Map(r.def.tiles.map((t) => [t.id, t]));
    for (const t of r.def.tiles) {
      for (const l of t.links) {
        const back = byId.get(l.to)!.links.find((b) => b.to === t.id)!;
        expect(l.via ?? []).toEqual([...(back.via ?? [])].reverse());
        for (const c of l.via ?? []) expect(road.has(`${c.x},${c.y}`)).toBe(true);
      }
    }
  });

  it('TileDef/LotBase/CompanyDef 带世界坐标 world；文案有 zh-TW 与 zh-CN', () => {
    const t = r.def.tiles[0]!;
    expect(t.world).toEqual(r.semantic.tiles[0]!.world);
    expect(r.def.lots.every((l) => typeof l.world.x === 'number')).toBe(true);
    expect(r.def.companies.every((c) => typeof c.world.y === 'number')).toBe(true);
    expect(r.def.strings['zh-TW']['map.t.company.C1']).toBe('銀行');
    expect(r.def.strings['zh-CN']['map.t.company.C1']).toBe('银行');
    expect(r.def.strings['zh-CN']['map.t.landmark.2']).toBe('绿岛');
  });

  it('关押格与地标双向引用；封路保留为 blocked', () => {
    const jail = r.def.landmarks.find((m) => m.kind === 'jail')!;
    const hold = r.def.tiles.find((t) => t.id === jail.holdTile)!;
    expect(hold).toMatchObject({ holdFor: 'jail', ref: { landmark: jail.id } });
    expect(
      r.def.tiles
        .filter((t) => t.links.some((l) => l.blocked))
        .map((t) => t.landingCode)
        .sort(),
    ).toEqual([4, 5]);
  });

  it('确定性：两次构建逐字节一致', () => {
    const again = build({ w: 10, h: 9, cut: true, amp: 6 });
    expect(canonicalJson(again.def)).toBe(canonicalJson(r.def));
  });
});

describe('build：待补数据与契约缺口的分类', () => {
  it('stocks 为空 → 企业 stockIndex 悬空归为 pending，exit 0', () => {
    const r = build({ w: 10, h: 9 }, {}, false);
    expect(r.validation.ok).toBe(false);
    const errs = r.classified.filter((i) => i.severity === 'error');
    expect(errs.length).toBe(2);
    expect(errs.every((i) => i.class === 'pending')).toBe(true);
    expect(r.exitCode).toBe(ExitCode.OK);
  });

  it('企业的远端银行/百货格（落点码 14/15）不相邻 → W_COMPANY_REMOTE_FRONT（warn）；普通前沿格不相邻仍是 error', () => {
    const r = build({ w: 10, h: 9 });
    const def = structuredClone(r.def);
    const c1 = def.companies.find((c) => c.id === 'C1')!;
    const far = def.tiles.find((t) => t.landingCode === 16)!;
    // 让一个魔法屋格也挂到 C1 上：它不相邻，且落点码不是 14/15 → error
    far.ref = { lot: 'C1' };
    c1.frontTiles.push(far.id);
    const cls = classifyIssues(def, validateMap(def).issues, []);
    expect(cls.find((i) => i.code === 'E_LOT_FRONT_NOT_ADJ')?.class).toBe('error');
    far.landingCode = 15;
    far.kind = 'shop';
    far.src = { flags: 15 };
    const cls2 = classifyIssues(def, validateMap(def).issues, []);
    expect(cls2.find((i) => i.code === 'E_LOT_FRONT_NOT_ADJ')).toBeUndefined();
    expect(cls2.find((i) => i.code === 'W_COMPANY_REMOTE_FRONT')?.class).toBe('warn');
    expect(cls2.every((i) => i.class !== 'error')).toBe(true);
  });

  it('pack 的 manifest 条目：hash 与 sha256、pending；未分类错误拒绝打包', () => {
    const r = build({ w: 10, h: 9 }, {}, false);
    const text = canonicalJson(r.def);
    const { entry } = manifestEntry(text, r.semantic.pending);
    expect(entry).toMatchObject({ id: 't', mapHash: r.def.meta.dataHash, pending: ['stocks', 'holidays'] });
    expect(entry.validation.issues.pending).toBe(2);
    const broken = structuredClone(r.def);
    broken.lots[0]!.rect = { x: 0, y: 0, w: 1, h: 1 };
    broken.meta.dataHash = computeMapDataHash(broken);
    expect(() => manifestEntry(canonicalJson(broken), [])).toThrow(ExtractError);
    expect(() => manifestEntry(text.replace(r.def.meta.dataHash, 'f'.repeat(64)), [])).toThrow(/dataHash/);
  });
});

describe('build：overrides', () => {
  it('nodeCell override 生效；引用不存在的节点 → exit 5', () => {
    const base = build({ w: 10, h: 9 });
    expect(base.geometry.report.lattice.tile).toBe(48);
    // 节点 1 原本的格点坐标 = 最终坐标 − shift；把它向外挪一格，仍能连通
    const s0 = base.geometry.report.bounds.shift;
    const c0 = base.def.tiles[0]!.cell;
    const target: [number, number] = [c0.x - s0.x - 1, c0.y - s0.y];
    const moved = build({ w: 10, h: 9 }, { nodeCell: { '1': target } });
    const s1 = moved.geometry.report.bounds.shift;
    expect(moved.def.tiles[0]!.cell).toEqual({ x: target[0] + s1.x, y: target[1] + s1.y });
    expect(moved.validation.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(moved.geometry.report.overrides).toBe(1);
    expect(() => build({ w: 10, h: 9 }, { nodeCell: { '999': [0, 0] } })).toThrow(
      expect.objectContaining({ exitCode: ExitCode.OVERRIDE }),
    );
  });

  it('expectResourceSha256 与输入不符 → exit 5（旧 override 作废）', () => {
    expect(() =>
      build({ w: 10, h: 9 }, { source: { id: 'v206-mapdat', expectResourceSha256: 'a'.repeat(64) } }),
    ).toThrow(expect.objectContaining({ exitCode: ExitCode.OVERRIDE }));
  });

  it('override 指定的格被占用 → 几何 error，exit 5', () => {
    const r = build({ w: 10, h: 9 }, { lot: { L1: { cell: [1, 0] } } });
    expect(r.geometry.report.issues.some((i) => i.code === 'E_OVERRIDE_RECT')).toBe(true);
    expect(r.exitCode).toBe(ExitCode.OVERRIDE);
  });

  it('schema：未知键、错误的键格式都拒绝', () => {
    expect(() => parseOverrides({ mapKey: 't', source: { id: 'v206-mapdat' }, bogus: 1 })).toThrow(ExtractError);
    expect(() => parseOverrides({ mapKey: 't', source: { id: 'v206-mapdat' }, edgeRoute: { '2-x': [] } })).toThrow();
    expect(emptyOverrides('t', 'v311-mapmkf')).toMatchObject({ compact: false, nodeCell: {}, lattice: {} });
  });

  it('transform 与 compact 仍得到合法地图', () => {
    for (const transform of ['rot90', 'flipY'] as const) {
      const r = build({ w: 10, h: 9, cut: true, amp: 5 }, { lattice: { transform }, compact: true });
      expect(r.validation.ok, transform).toBe(true);
    }
  });
});

describe('build：随机环路（fast-check）', () => {
  it('normalize 后 validateMap 必过、输出确定', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 9, max: 16 }),
        fc.integer({ min: 9, max: 14 }),
        fc.boolean(),
        fc.integer({ min: 0, max: 8 }),
        fc.integer({ min: 0, max: 3 }),
        (w, h, cut, amp, landMod) => {
          const opt: RingOptions = {
            w,
            h,
            cut,
            amp,
            landAt: (i, p) => (p.y === 0 || p.y === h - 1) && p.x > 0 && p.x < w - 1 && i % 4 !== landMod,
          };
          const a = build(opt);
          const errs = a.validation.issues.filter((i) => i.severity === 'error');
          expect(errs).toEqual([]);
          expect(a.exitCode).toBe(ExitCode.OK);
          const b = build(opt);
          expect(b.def.meta.dataHash).toBe(a.def.meta.dataHash);
        },
      ),
      { numRuns: 40, seed: 20260927 },
    );
  });
});

describe('overrides schema 文件', () => {
  it('tools/extract/maps/overrides.schema.json 与 zod 导出一致；taiwan.overrides.json 可解析', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const { PACKAGE_DIR } = await import('../../src/context');
    const { overridesJsonSchema, OVERRIDES_SCHEMA_FILE } = await import('../../src/map/overrides');
    const file = readFileSync(path.join(PACKAGE_DIR, 'maps', OVERRIDES_SCHEMA_FILE), 'utf8');
    expect(file).toBe(canonicalJson(overridesJsonSchema()));
    const tw = parseOverrides(
      JSON.parse(readFileSync(path.join(PACKAGE_DIR, 'maps', 'taiwan.overrides.json'), 'utf8')),
    );
    expect(tw).toMatchObject({ mapKey: 'taiwan', source: { id: 'v206-mapdat' }, lattice: { tile: 48 } });
  });
});
