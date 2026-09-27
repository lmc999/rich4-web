import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../util/canonicalJson';
import { fnv1a64 } from '../../util/hash';
import { computeTablesHash } from '../maps/registry';
import { findUnsourced } from '../source';
import {
  CARDS,
  CHARACTERS,
  CMB,
  COMBAT,
  cardDef,
  DECK_TOTAL,
  ECON,
  ECONOMY,
  GODS,
  INITIAL_FUND_TABLE,
  ITEMS,
  initialDeck,
  initialItemPool,
  itemDef,
  resolveTraits,
  START_ITEMS,
  TABLES,
  TENURE_MONTHS,
  tablesHash,
  VEHICLE_MAX_DICE,
} from './index';

describe('卡片表（g_arbitration §1、r_references §2.1）', () => {
  it('30 张，牌堆合计 100，被动卡为 18..21', () => {
    expect(CARDS).toHaveLength(30);
    expect(DECK_TOTAL).toBe(100);
    expect(initialDeck()).toHaveLength(31);
    expect(initialDeck()[0]).toBe(0);
    expect(CARDS.filter((c) => c.passive).map((c) => c.id)).toEqual([18, 19, 20, 21]);
  });

  it('点券价 / 初始张数 / f7 与调研表逐条一致（Fandom 的 4 处冲突按 exe 值）', () => {
    const want: [number, number, number][] = [
      [200, 1, 2],
      [200, 2, 2],
      [35, 4, 1],
      [25, 4, 0],
      [20, 4, 0],
      [20, 3, 0],
      [15, 8, 0],
      [20, 3, 1],
      [160, 2, 0],
      [180, 1, 2],
      [60, 2, 2],
      [15, 5, 1],
      [25, 4, 2],
      [20, 4, 0],
      [100, 2, 2],
      [25, 4, 1],
      [20, 4, 2],
      [20, 4, 0],
      [40, 4, 0],
      [25, 4, 0],
      [25, 4, 0],
      [10, 3, 0],
      [20, 3, 0],
      [50, 3, 0],
      [30, 3, 1],
      [35, 4, 1],
      [35, 3, 0],
      [35, 3, 1],
      [40, 2, 0],
      [70, 3, 0],
    ];
    expect(CARDS.map((c) => [c.price, c.deckCount, c.f7])).toEqual(want);
    expect(cardDef(19).price).toBe(40);
    expect(cardDef(24).price).toBe(50);
    expect(cardDef(27).price).toBe(35);
    expect(cardDef(29).price).toBe(40);
    expect(cardDef(13).key).toBe('rob');
  });

  it('每条都有非 verify 的出处，并带 exe 表地址', () => {
    expect(findUnsourced(CARDS)).toEqual([]);
    expect(CARDS[0]!.src).toContainEqual({ exe: '3.11', va: '0x47fdf2' });
    expect(CARDS[29]!.src).toContainEqual({ exe: '3.11', va: `0x${(0x47fdf2 + 29 * 8).toString(16)}` });
  });
});

describe('道具表', () => {
  it('13 种；1..8 库存 10 且有售；9..13 为研究所 1..5 级产物', () => {
    expect(ITEMS).toHaveLength(13);
    expect(ITEMS.map((i) => i.price)).toEqual([15, 30, 25, 25, 80, 150, 100, 30, 30, 40, 95, 150, 250]);
    expect(ITEMS.filter((i) => i.shopSellable).map((i) => i.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(initialItemPool()).toEqual([0, 10, 10, 10, 10, 10, 10, 10, 10, 0, 0, 0, 0, 0]);
    expect(itemDef(9).research).toBe(1);
    expect(itemDef(13).research).toBe(5);
    expect(itemDef(8).research).toBeNull();
    expect(findUnsourced(ITEMS)).toEqual([]);
  });
});

describe('角色表与 resolveTraits（r_minigames_chars §2.2）', () => {
  it('12 名，现金比例 50/40/70/60/40/70/50/40/60/50/55/80', () => {
    expect(CHARACTERS).toHaveLength(12);
    expect(CHARACTERS.map((c) => c.cashRatio)).toEqual([50, 40, 70, 60, 40, 70, 50, 40, 60, 50, 55, 80]);
    expect(CHARACTERS.map((c) => c.personality)).toEqual([2, 1, 2, 2, 1, 1, 1, 0, 0, 0, 1, 2]);
    expect(CHARACTERS.map((c) => c.loanRatio)).toEqual([60, 100, 0, 100, 50, 75, 100, 0, 0, 50, 30, 80]);
    expect(CHARACTERS.map((c) => c.stockRatio)).toEqual([30, 45, 0, 30, 25, 30, 20, 35, 20, 0, 15, 0]);
    expect(CHARACTERS.filter((c) => c.gender === 'f').map((c) => c.id)).toEqual([3, 5, 7, 8, 9, 11]);
    for (const c of CHARACTERS) expect(c.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(findUnsourced(CHARACTERS)).toEqual([]);
  });

  it('预设只覆盖个性；overrides 逐项覆盖，非法值忽略', () => {
    expect(resolveTraits(4)).toEqual({
      personality: 1,
      useCards: true,
      useItems: true,
      loanRatio: 50,
      cashRatio: 40,
      stockRatio: 25,
    });
    expect(resolveTraits(4, { preset: 'character' }).personality).toBe(1);
    expect(resolveTraits(4, { preset: 'cunning' }).personality).toBe(2);
    expect(resolveTraits(0, { preset: 'gentle' })).toMatchObject({ personality: 0, cashRatio: 50 });
    const t = resolveTraits(9, { preset: 'normal', overrides: { cashRatio: 70, useCards: false, stockRatio: 101 } });
    expect(t).toMatchObject({ personality: 1, cashRatio: 70, useCards: false, stockRatio: 0 });
  });
});

describe('常数、开局表与 TABLES', () => {
  it('常数都有出处', () => {
    expect(findUnsourced(Object.values(ECONOMY))).toEqual([]);
    expect(ECON.CHAIN_TOLL).toBe(2000);
    expect(ECON.HAND_MAX).toBe(15);
    expect(ECON.ITEM_MAX).toBe(9);
    expect(ECON.COUNTER_PENDING).toBe(0x80);
  });

  it('开局：默认总资金 200000；地契按月；交通工具骰子上限；开局道具 1,2,3,4,8,9', () => {
    expect(INITIAL_FUND_TABLE.options[INITIAL_FUND_TABLE.defaultIndex]).toBe(200000);
    expect(TENURE_MONTHS).toEqual({ unlimited: 0, '2y': 24, '1y': 12, '6m': 6, '3m': 3, '1m': 1 });
    expect(VEHICLE_MAX_DICE).toEqual({ walk: 1, moto: 2, car: 3, engineer: 1 });
    expect(START_ITEMS.items).toEqual([1, 2, 3, 4, 8, 9]);
  });

  it('M6 对抗常数与神明表都有出处，并进入 TABLES（tablesHash 覆盖）', () => {
    expect(findUnsourced(Object.values(COMBAT))).toEqual([]);
    expect(findUnsourced(Object.values(GODS))).toEqual([]);
    expect([CMB.FRAME_DAYS, CMB.FRAME_SELF_DAYS, CMB.STAY_SELF, CMB.STAY_OTHER]).toEqual([5, 4, 0x80, 1]);
    expect([CMB.TORTOISE_SELF, CMB.TORTOISE_OTHER, CMB.BOMB_HOSPITAL_DAYS, CMB.RESPAWN_TRIES]).toEqual([2, 3, 5, 64]);
    expect([ECON.BOMB_FUSE, ECON.DOLL_STEPS, ECON.MISSILE_HALF, ECON.NUKE_HALF, ECON.RESPAWN_DIST]).toEqual([
      38, 9, 100, 220, 300,
    ]);
    expect(TABLES.combat).toBe(COMBAT);
    expect(TABLES.gods).toBe(GODS);
  });

  it('tablesHash = FNV-1a 64(规范化 TABLES)，与 registry 的算法一致', () => {
    expect(tablesHash).toMatch(/^[0-9a-f]{16}$/);
    expect(tablesHash).toBe(fnv1a64(canonicalJson(TABLES)));
    expect(tablesHash).toBe(computeTablesHash(TABLES));
  });
});
