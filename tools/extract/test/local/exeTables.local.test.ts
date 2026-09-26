/** 需要用户正版文件（original/ 下两个 rich4.exe）；不存在时整组 skip。exe 固定表抽取与两版对比。 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExtractContext } from '../../src/context';
import { extractEditions } from '../../src/exe/extract';
import { EXPECT_CASH_RATIOS, EXPECT_TAIWAN_STOCKS, EXPECT_TOOL_PRICES_1_8 } from '../../src/exe/locate';
import { holidaysForMap, stocksForMap } from '../../src/exe/mapData';
import type { ExeEdition, ExtractedTables } from '../../src/exe/types';
import { canonicalJson } from '../../src/io/writeCanonicalJson';
import { diffExeTables } from '../../src/report/versionDiff';

const ctx = new ExtractContext({ logger: { out: () => {}, err: () => {} } });
const available = ['Game/rich4.exe', 'MultiverseJourney/rich4.exe'].every((p) => existsSync(path.join(ctx.srcDir, p)));
/** 抽取含第二阶段（常量、新闻/命运/魔法屋）约数秒 */
const T = { timeout: 120_000 };

describe.skipIf(!available)('exe 固定表（本机原版 exe）', () => {
  let cached: Partial<Record<ExeEdition, ExtractedTables>> | null = null;
  const both = async () => {
    cached ??= await extractEditions(ctx, ['v311', 'v206']);
    return cached as Record<ExeEdition, ExtractedTables>;
  };

  it('两版都是已登记的 Steam exe；每张表唯一定位，v3.11 与参考 VA 一致，v2.06 的 xref 与签名一致', T, async () => {
    const { v206, v311 } = await both();
    expect(v311.exe.knownFileId).toBe('steam.mj.exe');
    expect(v206.exe.knownFileId).toBe('steam.game.exe');
    expect(v311.locate.cards.va).toBe('0x47fdf2');
    expect(v311.locate.tools.va).toBe('0x47fee2');
    expect(v311.locate.characters.va).toBe('0x47e80c');
    expect(v311.locate.stocks.va).toBe('0x47f072');
    expect(v311.locate.holidays.va).toBe('0x47ff4a');
    expect(v311.locate.facilityLevels.va).toBe('0x474940');
    expect(v206.locate.stocks.va).toBe('0x47ce92');
    expect(v206.locate.cards.fileOffset).toBe('0x7c152');
    for (const [id, l] of Object.entries(v206.locate)) {
      if (id === 'lunar') continue;
      const xr = l.candidates.find((c) => c.method === 'xref');
      expect(xr?.accepted, id).toBe(true);
      expect(xr?.va, id).toBe(l.va);
    }
  });

  for (const ed of ['v206', 'v311'] as const) {
    it(`${ed}：卡表 30 项、初始张数和 100；道具前 8 种价格；角色现金比例；台湾股票样本；事实核对全过`, T, async () => {
      const t = (await both())[ed];
      expect(t.cards).toHaveLength(30);
      expect(t.cards.reduce((s, c) => s + c.initCount, 0)).toBe(100);
      expect(t.tools.slice(0, 8).map((r) => r.price)).toEqual([...EXPECT_TOOL_PRICES_1_8]);
      expect(t.characters.map((c) => c.cashRatio)).toEqual([...EXPECT_CASH_RATIOS]);
      const tw = t.stocks.rows.filter((r) => r.mapId === 0);
      expect(tw.map((r) => [r.nameNorm, r.price, r.volatility])).toEqual(EXPECT_TAIWAN_STOCKS.map((x) => [...x]));
      expect(tw.every((r) => Number.isInteger(r.initPriceCents))).toBe(true);
      expect(t.facts.filter((f) => !f.ok && f.level === 'error')).toEqual([]);
      expect(t.setup.defaults.funds).toMatchObject({ index: 1, value: 200000 });
      expect(t.facilityLevels.max).toEqual([1, 5, 5, 1, 5]);
      expect(t.holidays.rows.filter((r) => r.mapId === 0 && !r.empty)).toHaveLength(24);
    });
  }

  it(
    '版本对比：v2.06 4 张图、v3.11 8 张图；卡/道具/角色/开局/设施/农历一致；共有地图的股票一致、节日只差图片资源号',
    T,
    async () => {
      const { v206, v311 } = await both();
      expect(v206.stocks.maps).toBe(4);
      expect(v311.stocks.maps).toBe(8);
      const d = diffExeTables(v206, v311);
      const status = Object.fromEntries(d.map((x) => [x.table, x.status]));
      expect(status).toEqual({
        cards: 'same',
        tools: 'same',
        characters: 'same',
        stocks: 'superset',
        holidays: 'superset',
        setup: 'same',
        facilityLevels: 'same',
        lunar: 'same',
      });
      expect(canonicalJson(stocksForMap(v206, 0))).toBe(canonicalJson(stocksForMap(v311, 0)));
      expect(canonicalJson(holidaysForMap(v206, 0))).toBe(canonicalJson(holidaysForMap(v311, 0)));
    },
  );
});
