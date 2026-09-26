/** 需要用户正版文件（original/）；文件不存在时整组 skip。台湾 MapDef 的构建结果核对（股票与节日来自 v2.06 exe）。 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { computeMapDataHash, MapDefSchema } from '@rich4/shared/data';
import { describe, expect, it } from 'vitest';
import { ExitCode, ExtractContext } from '../../src/context';
import { extractEditions } from '../../src/exe/extract';
import { companyStockChecks, holidaysForMap, stocksForMap } from '../../src/exe/mapData';
import { loadKnownFiles } from '../../src/fingerprint/identify';
import { canonicalJson } from '../../src/io/writeCanonicalJson';
import { type BuildResult, buildMapDef } from '../../src/map/build';
import { parseOverrides } from '../../src/map/overrides';
import { loadRawSource, RAW_SOURCES, sourceDef } from '../../src/map/sources';
import { runTaiwanSamples } from '../../src/verify/samples';

const ctx = new ExtractContext({ logger: { out: () => {}, err: () => {} } });
const REQUIRED = ['Game/MapDat.MKF', 'Game/map.mkf', 'MultiverseJourney/map.mkf', 'Game/rich4.exe'];
const available = REQUIRED.every((p) => existsSync(path.join(ctx.srcDir, p)));
const OVERRIDES = path.join(ctx.packageDir, 'maps', 'taiwan.overrides.json');

describe.skipIf(!available)('台湾 MapDef 构建（本机原版文件）', () => {
  const ov = parseOverrides(JSON.parse(readFileSync(OVERRIDES, 'utf8')));
  let cached: BuildResult | null = null;
  const build = async (): Promise<BuildResult> => {
    const known = await loadKnownFiles(ctx.packageDir);
    const { raw } = await loadRawSource(ctx, sourceDef(ov.source.id), 0, known);
    const t = (await extractEditions(ctx, ['v206'])).v206!;
    return buildMapDef(raw, ov, {
      mapKey: 'taiwan',
      strict4: true,
      stocks: stocksForMap(t, 0),
      holidays: holidaysForMap(t, 0).holidays,
    });
  };
  const once = async () => {
    cached ??= await build();
    return cached;
  };

  it('构建成功（exit 0），几何无 error，MapDef 通过 zod', async () => {
    const r = await once();
    expect(r.exitCode).toBe(ExitCode.OK);
    expect(r.geometry.report.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(MapDefSchema.safeParse(r.def).success).toBe(true);
    expect(computeMapDataHash(r.def)).toBe(r.def.meta.dataHash);
  });

  it('validateMap（strict4）ok：无 error、无 pending；企业远端百货格只报 W_COMPANY_REMOTE_FRONT；没有对角 link', async () => {
    const r = await once();
    expect(r.validation.ok).toBe(true);
    expect(r.classified.filter((i) => i.class !== 'warn')).toEqual([]);
    expect(r.semantic.pending).toEqual([]);
    const remote = r.classified.filter((i) => i.code === 'W_COMPANY_REMOTE_FRONT');
    expect(remote.map((i) => i.tiles)).toEqual([[15]]);
    expect(r.validation.issues.some((i) => i.code === 'W_DIAGONAL_LINK')).toBe(false);
  });

  it('股票 12 支（名称去空格、整数分）、节日 23 条（停用槽 12 不输出）；企业 ↔ 股票同名', async () => {
    const r = await once();
    const tw = r.def.strings['zh-TW'];
    expect(r.def.stocks.map((s) => [tw[s.nameKey], s.initPriceCents / 100, s.volatility])).toEqual([
      ['中國信託', 100, 1],
      ['臺灣人壽', 40, 0.6],
      ['大宇百貨', 25, 1.5],
      ['台積電', 180, 1.6],
      ['大宇資訊', 80, 1.2],
      ['台灣塑膠', 60, 1],
      ['裕隆汽車', 60, 1.4],
      ['遠東紡織', 27, 0.9],
      ['統一超商', 310, 0.7],
      ['震旦行', 66, 1],
      ['萊爾富', 171, 1.4],
      ['聯合報', 280, 0.8],
    ]);
    expect(r.def.stocks.filter((s) => s.hasCompany).map((s) => s.index)).toEqual([0, 1, 2]);
    expect(r.def.stocks[1]!.float).toBe(5000);
    expect(r.def.holidays).toHaveLength(23);
    expect(r.def.holidays.map((h) => h.slot)).not.toContain(12);
    expect(r.def.holidays.find((h) => h.month === 12 && h.day === 25 && !h.lunar)).toMatchObject({
      closed: true,
      giveCard: true,
      bgm: true,
    });
    expect(r.def.holidays.filter((h) => h.lunar)).toHaveLength(8);
    expect(companyStockChecks(r.def).every((c) => c.ok)).toBe(true);
  });

  it('计数 103/50/4/3/21，恰好 2 处静态封路，关押格双向引用', async () => {
    const r = await once();
    expect(r.def.meta.counts).toEqual({ nodes: 103, lands: 50, facilities: 4, companies: 3, landscapes: 21 });
    const blocked = r.def.tiles.flatMap((t) => t.links.filter((l) => l.blocked).map((l) => `${t.id}->${l.to}`));
    expect(blocked).toEqual(['12->76', '16->70']);
    for (const kind of ['hospital', 'jail'] as const) {
      const lm = r.def.landmarks.find((m) => m.kind === kind)!;
      expect(r.def.tiles.find((t) => t.id === lm.holdTile)).toMatchObject({ holdFor: kind, ref: { landmark: lm.id } });
    }
  });

  it('§10.1 样本在三个来源上都通过', async () => {
    const known = await loadKnownFiles(ctx.packageDir);
    for (const def of RAW_SOURCES) {
      const { raw } = await loadRawSource(ctx, def, 0, known);
      expect(
        runTaiwanSamples(raw).filter((s) => s.status === 'fail'),
        def.id,
      ).toEqual([]);
    }
  });

  it('住宅地全部在 facing 所指一侧；两次构建字节一致', async () => {
    const r = await once();
    expect(r.geometry.report.facing.enabled).toBe(true);
    expect(r.geometry.report.landsOffSide).toEqual([]);
    const again = await build();
    expect(canonicalJson(again.def)).toBe(canonicalJson(r.def));
  });
});
