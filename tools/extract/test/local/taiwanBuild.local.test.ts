/** 需要用户正版文件（original/）；文件不存在时整组 skip。台湾 MapDef 的构建结果核对。 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { computeMapDataHash, MapDefSchema, validateMap } from '@rich4/shared/data';
import { describe, expect, it } from 'vitest';
import { ExitCode, ExtractContext } from '../../src/context';
import { loadKnownFiles } from '../../src/fingerprint/identify';
import { canonicalJson } from '../../src/io/writeCanonicalJson';
import { type BuildResult, buildMapDef } from '../../src/map/build';
import { parseOverrides } from '../../src/map/overrides';
import { loadRawSource, RAW_SOURCES, sourceDef } from '../../src/map/sources';
import { runTaiwanSamples } from '../../src/verify/samples';

const ctx = new ExtractContext({ logger: { out: () => {}, err: () => {} } });
const REQUIRED = ['Game/MapDat.MKF', 'Game/map.mkf', 'MultiverseJourney/map.mkf'];
const available = REQUIRED.every((p) => existsSync(path.join(ctx.srcDir, p)));
const OVERRIDES = path.join(ctx.packageDir, 'maps', 'taiwan.overrides.json');

describe.skipIf(!available)('台湾 MapDef 构建（本机原版文件）', () => {
  const ov = parseOverrides(JSON.parse(readFileSync(OVERRIDES, 'utf8')));
  let cached: BuildResult | null = null;
  const build = async (): Promise<BuildResult> => {
    const known = await loadKnownFiles(ctx.packageDir);
    const { raw } = await loadRawSource(ctx, sourceDef(ov.source.id), 0, known);
    return buildMapDef(raw, ov, { mapKey: 'taiwan', strict4: true });
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

  it('validateMap（strict4）：错误只有「待 D2 股票」与「企业远端百货格」两类，没有对角 link', async () => {
    const r = await once();
    expect(r.classified.filter((i) => i.class === 'error')).toEqual([]);
    expect(r.classified.filter((i) => i.class === 'pending').map((i) => i.path)).toEqual([
      'companies[0].stockIndex',
      'companies[1].stockIndex',
      'companies[2].stockIndex',
    ]);
    const contract = r.classified.filter((i) => i.class === 'contract');
    expect(contract.map((i) => i.tiles)).toEqual([[15]]);
    expect(r.validation.issues.some((i) => i.code === 'W_DIAGONAL_LINK')).toBe(false);
    // 去掉股票依赖后（仅本测试内补虚构股票）只剩契约缺口
    const withStocks = validateMap(
      { ...r.def, stocks: [0, 1, 2].map((index) => ({ ...fakeStock(index) })) },
      { strict4: true },
    );
    expect(withStocks.issues.filter((i) => i.severity === 'error').map((i) => i.code)).toEqual(['E_LOT_FRONT_NOT_ADJ']);
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

function fakeStock(index: number) {
  return {
    index,
    nameKey: 'map.taiwan.name',
    hasCompany: true,
    float: 10000,
    initPriceCents: 100,
    volatility: 1,
    volatilityF32: '3f800000',
  };
}
