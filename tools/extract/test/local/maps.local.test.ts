/**
 * 需要用户正版文件（original/）；文件不存在时整组 skip。
 * 大陆（gm 1）、日本（gm 2）、美国（gm 3）三张图的来源、构建结果与冻结的 dataHash，外加台湾的逐字节回归。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { computeMapDataHash, MapDefSchema } from '@rich4/shared/data';
import { describe, expect, it } from 'vitest';
import { ExitCode, ExtractContext } from '../../src/context';
import { extractEditions } from '../../src/exe/extract';
import { companyStockChecks, holidaysForMap, stocksForMap } from '../../src/exe/mapData';
import type { ExtractedTables } from '../../src/exe/types';
import { loadKnownFiles } from '../../src/fingerprint/identify';
import { sha256Hex } from '../../src/io/hash';
import { canonicalJson } from '../../src/io/writeCanonicalJson';
import { type BuildResult, buildMapDef } from '../../src/map/build';
import { parseOverrides } from '../../src/map/overrides';
import { failedChecks } from '../../src/map/parseRaw';
import { ACCEPTED_RULE_DIFFS, acceptRuleDiffs, diffExitCode, diffRaw } from '../../src/map/rawDiff';
import type { MapDataRaw } from '../../src/map/rawTypes';
import { loadRawSource, RAW_SOURCES, sourceDef } from '../../src/map/sources';
import { MAP_SAMPLES, runMapSamples } from '../../src/verify/samples';

const ctx = new ExtractContext({ logger: { out: () => {}, err: () => {} } });
const REQUIRED = ['Game/MapDat.MKF', 'Game/map.mkf', 'MultiverseJourney/map.mkf', 'Game/rich4.exe'];
const available = REQUIRED.every((p) => existsSync(path.join(ctx.srcDir, p)));
/** 首次构建含 exe 抽取，给足时间 */
const T = { timeout: 120_000 };

/**
 * 冻结的几何决定对应的 dataHash（tools/extract/maps/<key>.overrides.json）。
 * 变化意味着 MapDef 变了：原版皮肤素材包（rich4-assets/）与该图的 golden 都要重建，并跑 assets verify。
 */
const FROZEN: Record<string, { gm: number; dataHash: string }> = {
  china: { gm: 1, dataHash: 'a36d1285be25c4c71aa5fe2fc8c8c4359fce18706738152ec54930680e8e4363' },
  japan: { gm: 2, dataHash: '0fc7c82a5d02fdd085bf9187dbb6fccbb10f310c56ac430cc9f1949527695a48' },
  usa: { gm: 3, dataHash: '52a0d97ced7404343a611ec17d4c75b6c31ff52901ffa526701197c6a2c35ed2' },
};
/** 台湾：已部署的数据包与旧存档依赖它，必须逐字节不变 */
const TAIWAN_SHA256 = '14ef91e8429d48da04d317be63e9cb01131aa6a6c72511fd6bab9146302a6c10';
const TAIWAN_DATA_HASH = '3c2f31eb596b101b2989768ffbec27d11ecf82c9fe3c248b48041336ef41a551';

/** 允许的告警码（其余告警码出现即失败）；原因见各图 overrides 的 notes */
const ALLOWED_WARN: Record<string, string[]> = {
  china: ['W_LINK_ONEWAY', 'W_DEADEND', 'W_COMPANY_REMOTE_FRONT'],
  japan: ['W_LINK_ONEWAY', 'W_DEADEND', 'W_COMPANY_REMOTE_FRONT', 'W_NAME_EMPTY'],
  usa: ['W_COMPANY_REMOTE_FRONT', 'W_NAME_EMPTY'],
};

const EXPECT = {
  china: {
    counts: { nodes: 144, lands: 73, facilities: 8, companies: 4, landscapes: 26 },
    stocks: [
      '上海銀行',
      '中國人壽',
      '王府井百貨',
      '中國石油',
      '聯想科技',
      '頂新食品',
      '東方實業',
      '匯豐證券',
      '大慶石油',
      '長城電機',
      '長江建設',
      '大眾軟件',
    ],
    hasCompany: [0, 1, 2, 3],
    holidays: 19,
    kind2: 0,
    lunar: 8,
    blocked: ['28->136'],
    noItems: [] as number[],
    hold: { hospital: 63, jail: 144 },
    rule: ['companies#4.name'],
    groups: [['v206-mapdat'], ['v206-mapmkf'], ['v311-mapmkf']],
  },
  japan: {
    counts: { nodes: 110, lands: 49, facilities: 5, companies: 6, landscapes: 16 },
    stocks: [
      '富士銀行',
      '三井生命',
      '三越百貨',
      '日產建設',
      'ＳＥＧＡ',
      '豐田汽車',
      '松下電機',
      '日立機電',
      'ＳＯＮＹ',
      '三菱工業',
      '任天堂',
      '德間書店',
    ],
    hasCompany: [0, 1, 2, 3, 4, 5],
    holidays: 19,
    kind2: 0,
    lunar: 0,
    blocked: ['78->79'],
    noItems: [23, 24, 25, 26, 27, 28, 29],
    hold: { hospital: 55, jail: 84 },
    rule: ['lands#17.rent'],
    groups: [['v206-mapdat'], ['v206-mapmkf'], ['v311-mapmkf']],
  },
  usa: {
    counts: { nodes: 118, lands: 55, facilities: 8, companies: 6, landscapes: 16 },
    stocks: [
      '花旗銀行',
      '喬治亞人壽',
      '環球百貨',
      '聯合航空',
      '福特汽車',
      'ＩＢＭ',
      '德州儀器',
      '摩扥羅拉',
      '迪士尼',
      '可口可樂',
      '麥當勞',
      '百事可樂',
    ],
    hasCompany: [0, 1, 2, 3, 4, 5],
    holidays: 20,
    kind2: 6,
    lunar: 0,
    blocked: [] as string[],
    noItems: [] as number[],
    hold: { hospital: 85, jail: 118 },
    rule: [] as string[],
    groups: [['v206-mapdat', 'v206-mapmkf'], ['v311-mapmkf']],
  },
} as const;

let tables: ExtractedTables | null = null;
const v206 = async (): Promise<ExtractedTables> => {
  tables ??= (await extractEditions(ctx, ['v206'])).v206!;
  return tables;
};

async function loadAll(gm: number): Promise<MapDataRaw[]> {
  const known = await loadKnownFiles(ctx.packageDir);
  const out: MapDataRaw[] = [];
  for (const def of RAW_SOURCES) out.push((await loadRawSource(ctx, def, gm, known)).raw);
  return out;
}

async function build(key: string, gm: number): Promise<BuildResult> {
  const ov = parseOverrides(
    JSON.parse(readFileSync(path.join(ctx.packageDir, 'maps', `${key}.overrides.json`), 'utf8')),
  );
  const known = await loadKnownFiles(ctx.packageDir);
  const { raw } = await loadRawSource(ctx, sourceDef(ov.source.id), gm, known);
  const t = await v206();
  return buildMapDef(raw, ov, {
    mapKey: key,
    strict4: true,
    stocks: stocksForMap(t, gm),
    holidays: holidaysForMap(t, gm).holidays,
  });
}

describe.skipIf(!available)('大陆 / 日本 / 美国（本机原版文件）', () => {
  const cache = new Map<string, BuildResult>();
  const once = async (key: keyof typeof EXPECT) => {
    const hit = cache.get(key);
    if (hit) return hit;
    const r = await build(key, FROZEN[key]!.gm);
    cache.set(key, r);
    return r;
  };

  for (const key of ['china', 'japan', 'usa'] as const) {
    const { gm, dataHash } = FROZEN[key]!;
    const e = EXPECT[key];

    describe(`${key}（gm ${gm}）`, () => {
      it('三个来源都能解析、未压缩、结构不变量无错误；§10.1 样本在三个来源上都通过', T, async () => {
        const raws = await loadAll(gm);
        expect(raws.map((r) => r.source.id)).toEqual(['v206-mapdat', 'v206-mapmkf', 'v311-mapmkf']);
        for (const r of raws) {
          expect(r.source.compressed, r.source.id).toBe(false);
          expect(r.source.knownFileId, r.source.id).not.toBeNull();
          expect(failedChecks(r, 'error'), r.source.id).toEqual([]);
          expect(
            runMapSamples(r, MAP_SAMPLES[key]!).filter((s) => s.status === 'fail'),
            r.source.id,
          ).toEqual([]);
        }
      });

      it('rawDiff：规则相关差异只有已登记的一项（或没有），字节分组符合预期', T, async () => {
        const d = diffRaw(await loadAll(gm));
        expect(d.rule.map((it) => `${it.table}#${it.id}.${it.field}`)).toEqual([...e.rule]);
        expect(diffExitCode(d)).toBe(e.rule.length > 0 ? ExitCode.RULE_DIFF : ExitCode.OK);
        // all 子命令的已知差异清单与这里登记的一致，真实数据上放行
        expect([...(ACCEPTED_RULE_DIFFS[gm]?.keys ?? [])]).toEqual([...e.rule]);
        if (e.rule.length > 0) expect(acceptRuleDiffs(d, 'v206-mapdat').ok).toBe(true);
        expect(d.identicalGroups).toEqual(e.groups.map((g) => [...g]));
        const where = new Set(d.presentation.flatMap((it) => it.byteOffsets.map((b) => `${it.table}+${b}`)));
        for (const w of where)
          expect(['nodes+0x22', 'companies+0x20', 'landscapes+0x1a', 'landscapes+0x1b']).toContain(w);
      });

      it('构建 exit 0、strict4 ok、没有 pending；告警码不超出允许清单；dataHash 与冻结值一致', T, async () => {
        const r = await once(key);
        expect(r.exitCode).toBe(ExitCode.OK);
        expect(MapDefSchema.safeParse(r.def).success).toBe(true);
        expect(computeMapDataHash(r.def)).toBe(r.def.meta.dataHash);
        expect(r.validation.ok).toBe(true);
        expect(r.classified.filter((i) => i.class !== 'warn')).toEqual([]);
        expect(r.semantic.pending).toEqual([]);
        expect(r.semantic.issues.filter((i) => i.severity === 'error')).toEqual([]);
        const g = r.geometry.report;
        expect(g.issues.filter((i) => i.severity === 'error')).toEqual([]);
        const warnCodes = new Set([
          ...r.classified.map((i) => i.code),
          ...g.issues.filter((i) => i.severity === 'warn').map((i) => i.code),
          ...r.semantic.issues.map((i) => i.code),
        ]);
        for (const c of warnCodes) expect(ALLOWED_WARN[key], c).toContain(c);
        expect(r.def.meta.counts).toEqual(e.counts);
        expect(r.def.meta.dataHash).toBe(dataHash);
      });

      it('几何：住宅地全部在 facing 一侧、没有 W_TILES_TOUCH、企业都不小于 2×2', T, async () => {
        const g = (await once(key)).geometry.report;
        expect(g.facing.enabled).toBe(true);
        expect(g.landsOffSide).toEqual([]);
        expect(g.unlinkedAdjacent).toEqual([]);
        expect(g.issues.filter((i) => i.code === 'I_LAND_FAR')).toEqual([]);
        expect(g.lattice).toMatchObject({ tile: 48, transform: 'identity' });
        expect(g.lattice.score.collisions).toBe(0);
        for (const c of (await once(key)).def.companies) expect(c.rect.w * c.rect.h, c.id).toBeGreaterThanOrEqual(4);
      });

      it('股票名与 hasCompany 下标；企业 ↔ 股票核对（大陆 C4 为已知不一致）；节日条数', T, async () => {
        const r = await once(key);
        const tw = r.def.strings['zh-TW'];
        expect(r.def.stocks.map((s) => tw[s.nameKey])).toEqual([...e.stocks]);
        expect(r.def.stocks.filter((s) => s.hasCompany).map((s) => s.index)).toEqual([...e.hasCompany]);
        const checks = companyStockChecks(r.def);
        expect(checks.filter((c) => c.status === 'BAD')).toEqual([]);
        expect(checks.filter((c) => c.status === 'KNOWN').map((c) => c.company)).toEqual(key === 'china' ? ['C4'] : []);
        expect(r.def.holidays).toHaveLength(e.holidays);
        expect(r.def.holidays.filter((h) => h.kind === 2)).toHaveLength(e.kind2);
        expect(r.def.holidays.filter((h) => h.kind === 2).every((h) => h.weekday !== undefined)).toBe(true);
        expect(r.def.holidays.filter((h) => h.lunar)).toHaveLength(e.lunar);
      });

      it('静态封路、禁放物件、关押格与景观双向引用；地图名', T, async () => {
        const r = await once(key);
        const blocked = r.def.tiles.flatMap((t) => t.links.filter((l) => l.blocked).map((l) => `${t.id}->${l.to}`));
        expect(blocked).toEqual([...e.blocked]);
        expect(r.def.tiles.filter((t) => t.noItems).map((t) => t.id)).toEqual([...e.noItems]);
        for (const kind of ['hospital', 'jail'] as const) {
          const lm = r.def.landmarks.find((m) => m.kind === kind)!;
          expect(lm.holdTile).toBe(e.hold[kind]);
          expect(r.def.tiles.find((t) => t.id === lm.holdTile)).toMatchObject({
            holdFor: kind,
            ref: { landmark: lm.id },
          });
        }
        expect(r.def.globalMapId).toBe(gm);
        const names = { china: ['中國大陸', '中国大陆'], japan: ['日本', '日本'], usa: ['美國', '美国'] }[key];
        expect([r.def.strings['zh-TW'][r.def.nameKey], r.def.strings['zh-CN'][r.def.nameKey]]).toEqual(names);
      });

      it('两次构建字节一致', T, async () => {
        const r = await once(key);
        const again = await build(key, gm);
        expect(canonicalJson(again.def)).toBe(canonicalJson(r.def));
      });
    });
  }

  it('台湾回归：MapDef 逐字节不变（sha256 14ef91e8…、dataHash 3c2f31eb…），住宅地没有走放宽', T, async () => {
    const r = await build('taiwan', 0);
    expect(r.exitCode).toBe(ExitCode.OK);
    expect(r.def.meta.dataHash).toBe(TAIWAN_DATA_HASH);
    expect(sha256Hex(new TextEncoder().encode(canonicalJson(r.def)))).toBe(TAIWAN_SHA256);
    expect(r.geometry.report.landsRelaxed).toEqual([]);
    // bit31 禁放物件节点：台湾 17 个（快艇格数 17/0/7/0 中的台湾项；台湾样本规格不加这一条，保持 samples.map0.json 不变）
    expect(r.def.tiles.filter((t) => t.noItems)).toHaveLength(17);
    expect(r.geometry.report.issues.filter((i) => i.code.startsWith('I_LAND'))).toEqual([]);
  });
});
