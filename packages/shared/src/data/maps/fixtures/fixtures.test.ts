import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../../util/canonicalJson';
import { DataError } from '../../errors';
import { kindForLandingCode, slotOfStep, TILE_KINDS } from '../kinds';
import { parseMapDef } from '../schema';
import type { MapDef } from '../types';
import { validateMap } from '../validate';
import { type AsciiMapSpec, buildAsciiMap } from './ascii';
import {
  buildFixtureMaps,
  buildTestMap,
  buildTestMapAllKinds,
  buildTestMapIndustries,
  buildTestOnlyFixtureMaps,
  FIXTURE_FILES,
  fixtureJson,
  TEST_MAP_SPEC,
} from './testMap';

// 动态导入 + 最小类型，避免把 @types/node 引入 shared 的类型检查
const { readFileSync } = (await import(/* @vite-ignore */ 'node:fs' as string)) as {
  readFileSync(path: object, encoding: 'utf8'): string;
};
const URLCtor = (globalThis as unknown as { URL: new (url: string, base: string) => object }).URL;
const here = (import.meta as unknown as { url: string }).url;

function readFixture(id: string): string {
  return readFileSync(new URLCtor(`./${FIXTURE_FILES[id]}`, here), 'utf8');
}

describe('入库的 fixture JSON', () => {
  it('与生成器输出逐字节一致（否则请运行 npm run fixtures）', () => {
    for (const def of [...buildFixtureMaps(), ...buildTestOnlyFixtureMaps()]) {
      expect(readFixture(def.id)).toBe(fixtureJson(def));
    }
  });

  it('能通过 zod 结构校验并与生成器输出相等', () => {
    for (const def of [...buildFixtureMaps(), ...buildTestOnlyFixtureMaps()]) {
      const parsed = parseMapDef(JSON.parse(readFixture(def.id)));
      expect(parsed).toEqual(def);
    }
  });

  it('生成器确定：重复构建结果相同', () => {
    expect(canonicalJson(buildTestMapAllKinds())).toBe(canonicalJson(buildTestMapAllKinds()));
    expect(fixtureJson(buildTestMap())).toBe(fixtureJson(buildTestMap()));
  });
});

describe('schema', () => {
  const mutateJson = (f: (d: Record<string, unknown> & MapDef) => void) => {
    const d = JSON.parse(fixtureJson(buildTestMap()));
    f(d);
    return () => parseMapDef(d);
  };
  it('拒绝未知键、非法槽号、非法地块 id', () => {
    expect(
      mutateJson((d) => {
        d.extra = 1;
      }),
    ).toThrow(DataError);
    expect(
      mutateJson((d) => {
        (d.tiles[0]!.links[0] as { slot: number }).slot = 4;
      }),
    ).toThrow(DataError);
    expect(
      mutateJson((d) => {
        d.tiles[0]!.ref = { lot: 'X1' as 'L1' };
      }),
    ).toThrow(DataError);
    expect(
      mutateJson((d) => {
        d.tiles[0]!.ref = { lot: 'L0' };
      }),
    ).toThrow(DataError);
    expect(
      mutateJson((d) => {
        d.meta.dataHash = 'abc';
      }),
    ).toThrow(DataError);
    expect(mutateJson(() => {})).not.toThrow();
  });
});

describe('fixture 内容', () => {
  it('test：20 格、13 种特殊落点', () => {
    const d = buildTestMap();
    expect(d.tiles.length).toBe(20);
    expect(d.grid).toEqual({ w: 12, h: 9 });
    const special = new Set(d.tiles.map((t) => t.landingCode).filter((c) => c !== 0));
    expect([...special].sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 11, 13, 14, 15, 16]);
    expect(d.tiles.find((t) => t.id === 20)!.kind).toBe('xicong');
  });

  it('test-allkinds：26 格，覆盖全部 17 类落点码与 18 种 kind', () => {
    const d = buildTestMapAllKinds();
    expect(d.tiles.length).toBe(26);
    expect(new Set(d.tiles.map((t) => t.landingCode)).size).toBe(17);
    expect(new Set(d.tiles.map((t) => t.kind))).toEqual(new Set(TILE_KINDS));
    expect(d.roadCells).toEqual([
      { x: 11, y: 3 },
      { x: 12, y: 3 },
    ]);
    const c3 = d.companies.find((c) => c.id === 'C3')!;
    expect(c3.frontTiles).toEqual([24, 25]);
    expect(c3.industryKey).toBe('insurance');
  });

  it('world = cell×32，槽号 N=0/E=1/S=2/W=3，kind 与落点码一致', () => {
    for (const d of buildFixtureMaps()) {
      const byId = new Map(d.tiles.map((t) => [t.id, t]));
      for (const t of d.tiles) {
        expect(t.world).toEqual({ x: t.cell.x * 32, y: t.cell.y * 32 });
        expect(t.kind).toBe(kindForLandingCode(t.landingCode, t.ref?.lot !== undefined));
        for (const l of t.links) {
          const first = l.via?.[0] ?? byId.get(l.to)!.cell;
          expect(slotOfStep(t.cell, first)).toBe(l.slot);
        }
      }
      for (const l of [...d.lots, ...d.companies]) {
        if (l.rect.w === 1 && l.rect.h === 1) expect(l.world).toEqual({ x: l.rect.x * 32, y: l.rect.y * 32 });
      }
    }
  });

  it('只有 04→19 被封', () => {
    for (const d of buildFixtureMaps()) {
      const blocked = d.tiles.flatMap((t) => t.links.filter((l) => l.blocked).map((l) => `${t.id}>${l.to}`));
      expect(blocked).toEqual(['4>19']);
    }
  });

  it('股票、节日与双语文案', () => {
    for (const d of buildFixtureMaps()) {
      expect(d.stocks.length).toBe(12);
      expect(d.stocks.map((s) => s.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      expect(d.stocks.every((s) => /^[0-9a-f]{8}$/.test(s.volatilityF32))).toBe(true);
      expect(d.stocks[0]!.volatilityF32).toBe('3f8ccccd'); // f32(1.1)
      expect(d.holidays.map((h) => [h.month, h.day])).toEqual([
        [1, 1],
        [12, 25],
      ]);
      const tw = Object.keys(d.strings['zh-TW']);
      expect(Object.keys(d.strings['zh-CN'])).toEqual(tw);
      expect(tw.every((k) => d.strings['zh-TW'][k] !== '' && d.strings['zh-CN'][k] !== '')).toBe(true);
      expect(d.meta.source).toEqual({ fixture: true });
    }
    expect(
      buildTestMap()
        .stocks.filter((s) => s.hasCompany)
        .map((s) => s.index),
    ).toEqual([0, 2]);
    expect(
      buildTestMapAllKinds()
        .stocks.filter((s) => s.hasCompany)
        .map((s) => s.index),
    ).toEqual([0, 1, 2]);
  });
});

describe('fixture test-industries（只给测试用）', () => {
  it('不在服务器注册的 fixture 里；strict4 校验无错误，警告只有支线封路与死路', () => {
    expect(buildFixtureMaps().map((d) => d.id)).not.toContain('test-industries');
    expect(buildTestOnlyFixtureMaps().map((d) => d.id)).toEqual(['test-industries']);
    const d = buildTestMapIndustries();
    const r = validateMap(d, { strict4: true, expect: { nodes: 26, lands: 4, facilities: 0, companies: 5 } });
    expect(r.ok).toBe(true);
    expect(r.issues.map((i) => i.code).sort()).toEqual(['W_DEADEND', 'W_LINK_ONEWAY']);
  });

  it('五种新行业的企业：航空 / 电子 / 汽车 / 石油 / 建设，前沿格为落点码 0 + lot 引用', () => {
    const d = buildTestMapIndustries();
    expect(d.companies.map((c) => [c.id, c.industry, c.industryKey, c.stockIndex, c.frontTiles])).toEqual([
      ['C1', 1, 'airline', 0, [6, 7]],
      ['C2', 3, 'electronics', 1, [10, 11]],
      ['C3', 5, 'auto', 2, [14, 15]],
      ['C4', 6, 'oil', 3, [17, 18]],
      ['C5', 11, 'construction', 4, [22, 23]],
    ]);
    const byId = new Map(d.tiles.map((t) => [t.id, t]));
    for (const c of d.companies) {
      for (const f of c.frontTiles) expect(byId.get(f)).toMatchObject({ landingCode: 0, ref: { lot: c.id } });
    }
    expect(d.stocks.filter((s) => s.hasCompany).map((s) => s.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it('两种关押结构：环路式医院（20 = 保释格 = 关押格）与台湾式监狱（16 保释、16→25 封路、26 支线尽头关押）', () => {
    const d = buildTestMapIndustries();
    const byId = new Map(d.tiles.map((t) => [t.id, t]));
    expect(byId.get(20)).toMatchObject({ kind: 'hospital', landingCode: 5, holdFor: 'hospital' });
    expect(byId.get(20)!.links.map((l) => l.to)).toEqual([19, 21]);
    expect(byId.get(16)).toMatchObject({ kind: 'jail', landingCode: 4 });
    expect(byId.get(16)!.holdFor).toBeUndefined();
    expect(byId.get(26)).toMatchObject({ holdFor: 'jail', noItems: true, ref: { landmark: '2' } });
    expect(byId.get(26)!.links.map((l) => l.to)).toEqual([25]);
    const blocked = d.tiles.flatMap((t) => t.links.filter((l) => l.blocked).map((l) => `${t.id}>${l.to}`));
    expect(blocked).toEqual(['16>25']);
    expect(d.landmarks.map((m) => [m.id, m.kind, m.holdTile])).toEqual([
      ['1', 'hospital', 20],
      ['2', 'jail', 26],
    ]);
  });
});

describe('buildAsciiMap 的输入检查', () => {
  const withSpec = (patch: Partial<AsciiMapSpec>) => () => buildAsciiMap({ ...TEST_MAP_SPEC, ...patch });
  it('未知符号、非矩形地块、缺少声明、via 不合法都会抛错', () => {
    const layout = [...TEST_MAP_SPEC.layout];
    expect(withSpec({ layout: layout.map((r, y) => (y === 0 ? r.replace('.', 'Q') : r)) })).toThrow(/unknown symbol/);
    expect(withSpec({ layout: layout.map((r, y) => (y === 0 ? r.replace('.', 'B') : r)) })).toThrow(/filled rectangle/);
    expect(withSpec({ tiles: TEST_MAP_SPEC.tiles.slice(1) })).toThrow(/declaration/);
    expect(withSpec({ viaLinks: [{ a: 1, b: 7, via: [{ x: 3, y: 1 }] }] })).toThrow(/via/);
    expect(withSpec({ blocked: [[1, 7]] })).toThrow(/not a link/);
    expect(withSpec({ decorations: [{ kind: 'tree', cell: { x: 2, y: 2 }, variant: 0 }] })).toThrow(/decoration/);
    expect(withSpec({})).not.toThrow();
  });
  it('noLink 取消自动连边', () => {
    const d = buildAsciiMap({ ...TEST_MAP_SPEC, noLink: [[16, 17]] });
    expect(d.tiles.find((t) => t.id === 16)!.links.map((l) => l.to)).toEqual([15]);
  });
});
