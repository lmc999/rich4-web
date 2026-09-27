import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findUnsourced, hasPrimarySource } from '../source';
import {
  decodeTrend,
  FATE_TABLE,
  MAGIC_CONDITIONS,
  MAGIC_EFFECTS,
  MAGIC_FLOW,
  NEWS_TABLE,
  swapFateByVehicle,
  TABLES,
} from './index';

/**
 * 新闻 / 命运 / 魔法屋数据表（docs/research/events-from-exe.md）。
 * 与 exe 抽取结果对照：读 .cache/extract/tables.v206.json 的 news / fate / magic 字段（派生数据，gitignore）；
 * 文件不存在时跳过对照，但保留规则测试。
 */
const CACHE = resolve(__dirname, '../../../../../.cache/extract/tables.v206.json');
const extracted: null | {
  news: Record<string, { effect: string; category: number; params: Record<string, number> }>;
  fate: Record<
    string,
    {
      effect: string;
      params: Record<string, number>;
      fortune: { class: string; handlesDouble: boolean } | null;
      variants: { group: number; slot: number; days: number }[];
      calls: string[];
    }
  >;
  magic: {
    conditions: { id: number; effect: string }[];
    effects: { id: number; effect: string; params: Record<string, number>; calls: string[] }[];
    flow: Record<string, number>;
  };
} = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : null;

const CJK = /[㐀-鿿]/;

describe('新闻表（36 条）', () => {
  it('36 条，编号连续；每条都有非 verify 的出处与 v2.06 VA；文案只存 i18n key', () => {
    expect(NEWS_TABLE).toHaveLength(36);
    NEWS_TABLE.forEach((n, i) => {
      expect(n.id).toBe(i);
      expect(n.textKey).toBe(`news:${i}`);
      expect(hasPrimarySource(n)).toBe(true);
      expect(n.src.some((s) => 'exe' in s && s.exe === '2.06')).toBe(true);
      expect(n.src).toContainEqual({ research: 'docs/research/events-from-exe.md §1、§4' });
    });
    expect(findUnsourced(NEWS_TABLE)).toEqual([]);
    expect(CJK.test(JSON.stringify(NEWS_TABLE.map(({ src: _src, ...rest }) => rest)))).toBe(false);
  });

  it('按 events-from-exe §4 修正：9 取最少（含 0 块）、15 收紧可行性、27 写 15 天、35 的阈值与除数', () => {
    expect(NEWS_TABLE[9]).toMatchObject({ effect: 'subsidyFewest', params: { subsidy: 5000 } });
    expect(NEWS_TABLE[15]!.feasible).toBe('builtLand');
    expect(NEWS_TABLE[27]!.params).toEqual({ days: 15, pick: 12 });
    expect(NEWS_TABLE[35]!.params).toEqual({ threshold: 10000, divisor: 10000 });
    expect(decodeTrend(NEWS_TABLE[24]!.params.trend!)).toEqual({ up: 0, down: 1 });
    expect(decodeTrend(NEWS_TABLE[25]!.params.trend!)).toEqual({ up: 1, down: 0 });
    expect(decodeTrend(NEWS_TABLE[31]!.params.trend!)).toEqual({ up: 3, down: 0 });
    expect(decodeTrend(NEWS_TABLE[32]!.params.trend!)).toEqual({ up: 0, down: 4 });
    // 新闻不查加持（PROGRAM）；MANUAL 的 blessingOnNews 只对奖金、税、坐牢等个人新闻生效
    expect(NEWS_TABLE.filter((n) => n.blessing === 'reward').map((n) => n.id)).toEqual([8, 9, 10, 23]);
    expect(NEWS_TABLE.filter((n) => n.blessing === 'penalty').map((n) => n.id)).toEqual([11, 12, 13]);
  });

  it.skipIf(extracted === null)('效果键、分类与参数逐条与 exe 抽取结果一致（v2.06）', () => {
    for (const n of NEWS_TABLE) {
      const x = extracted!.news[String(n.id)]!;
      expect(n.effect, `news ${n.id}`).toBe(x.effect);
      expect(n.category, `news ${n.id}`).toBe(x.category);
      expect(n.params, `news ${n.id}`).toEqual(x.params);
    }
  });
});

describe('命运表（37 条）', () => {
  it('37 条；加持覆盖 33 条（0、1、4、5 不查）；不处理加倍的是 3、8、9、10、11、32', () => {
    expect(FATE_TABLE).toHaveLength(37);
    expect(findUnsourced(FATE_TABLE)).toEqual([]);
    expect(FATE_TABLE.filter((f) => f.blessing === null).map((f) => f.id)).toEqual([0, 1, 4, 5]);
    expect(FATE_TABLE.filter((f) => f.blessing && !f.blessing.handlesDouble).map((f) => f.id)).toEqual([
      3, 8, 9, 10, 11, 32,
    ]);
    // 罚金类的保险赔付（events-from-exe §4）
    expect(FATE_TABLE.filter((f) => f.insured).map((f) => f.id)).toEqual([2, 14, 15, 16, 17, 18, 19, 23, 24, 26, 30]);
    // 免罪 → 嫁祸（g_villains §6 的 7 个调用点中的命运部分）
    expect(FATE_TABLE.filter((f) => f.passive).map((f) => f.id)).toEqual([6, 7, 12, 13, 33, 34, 35, 36]);
    expect(CJK.test(JSON.stringify(FATE_TABLE.map(({ src: _src, ...rest }) => rest)))).toBe(false);
  });

  it('按座驾替换：10↔11、12↔13、14/15/16；地图组变体 37..48 天数相同（v2.06 恒可）', () => {
    expect(swapFateByVehicle(10, 'car')).toBe(11);
    expect(swapFateByVehicle(11, 'moto')).toBe(10);
    expect(swapFateByVehicle(10, 'walk')).toBe(10);
    expect(swapFateByVehicle(13, 'walk')).toBe(12);
    expect(swapFateByVehicle(12, 'moto')).toBe(13);
    expect(swapFateByVehicle(14, 'car')).toBe(16);
    expect(swapFateByVehicle(16, 'moto')).toBe(15);
    expect(swapFateByVehicle(15, 'walk')).toBe(14);
    expect(swapFateByVehicle(20, 'car')).toBe(20);
    expect(FATE_TABLE[33]!.variants).toEqual([
      { group: 1, slot: 37, days: 3 },
      { group: 2, slot: 41, days: 3 },
      { group: 3, slot: 45, days: 3 },
    ]);
    expect(FATE_TABLE[36]!.variants.map((v) => v.slot)).toEqual([40, 44, 48]);
    expect(FATE_TABLE.slice(33).every((f) => f.feasible === 'always')).toBe(true);
  });

  it.skipIf(extracted === null)('效果键、参数、加持类别与变体逐条与 exe 抽取结果一致（v2.06）', () => {
    for (const f of FATE_TABLE) {
      const x = extracted!.fate[String(f.id)]!;
      expect(f.effect, `fate ${f.id}`).toBe(x.effect);
      expect(f.params, `fate ${f.id}`).toEqual(x.params);
      if (x.fortune === null) expect(f.blessing, `fate ${f.id}`).toBeNull();
      else
        expect(f.blessing, `fate ${f.id}`).toEqual({
          category: x.fortune.class,
          handlesDouble: x.fortune.handlesDouble,
        });
      expect(f.variants, `fate ${f.id}`).toEqual(
        x.variants.map((v) => ({ group: v.group, slot: v.slot, days: v.days })),
      );
      expect(f.insured, `fate ${f.id}`).toBe(x.calls.includes('insurance'));
      expect(f.passive, `fate ${f.id}`).toBe(x.calls.includes('cardCheck'));
    }
  });
});

describe('魔法屋表', () => {
  it('12 个条件、12 种效果；2 / 10 敌意 90 × PI、3 天；5、7、9、11 跳过受困', () => {
    expect(MAGIC_CONDITIONS).toHaveLength(12);
    expect(MAGIC_EFFECTS).toHaveLength(12);
    expect(findUnsourced(MAGIC_CONDITIONS)).toEqual([]);
    expect(findUnsourced(MAGIC_EFFECTS)).toEqual([]);
    expect(MAGIC_EFFECTS[2]!.params).toEqual({ days: 3, hate: 90 });
    expect(MAGIC_EFFECTS[10]!.params).toEqual({ days: 3, hate: 90 });
    expect(MAGIC_EFFECTS.filter((e) => e.skipConfined).map((e) => e.id)).toEqual([5, 7, 9, 11]);
    expect(MAGIC_EFFECTS.filter((e) => e.passive).map((e) => e.id)).toEqual([2, 10]);
    expect(MAGIC_CONDITIONS.filter((c) => c.zeroCounts).map((c) => c.id)).toEqual([0]);
    expect(Object.fromEntries(Object.entries(MAGIC_FLOW).map(([k, v]) => [k, v.value]))).toEqual({
      condPickHuman: 12,
      condPickAi: 12,
      aiSelfEffect: 6,
      aiEffectPick: 11,
    });
  });

  it.skipIf(extracted === null)('条件键、效果键、参数与流程常量与 exe 抽取结果一致（v2.06）', () => {
    const m = extracted!.magic;
    expect(MAGIC_CONDITIONS.map((c) => c.key)).toEqual(m.conditions.map((c) => c.effect));
    expect(MAGIC_EFFECTS.map((e) => e.key)).toEqual(m.effects.map((e) => e.effect));
    for (const e of MAGIC_EFFECTS) {
      expect(e.params, `magic ${e.id}`).toEqual(m.effects[e.id]!.params);
      expect(e.passive, `magic ${e.id}`).toBe(m.effects[e.id]!.calls.includes('cardCheck'));
    }
    expect(Object.fromEntries(Object.entries(MAGIC_FLOW).map(([k, v]) => [k, v.value]))).toEqual(m.flow);
  });
});

describe('TABLES', () => {
  it('news / fate / magic 进入 TABLES（tablesHash 覆盖）', () => {
    expect(TABLES.news).toBe(NEWS_TABLE);
    expect(TABLES.fate).toBe(FATE_TABLE);
    expect(TABLES.magic.effects).toBe(MAGIC_EFFECTS);
  });
});
