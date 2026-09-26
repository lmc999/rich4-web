import { describe, expect, it } from 'vitest';
import { buildAsciiMap } from '../../data/maps/fixtures/ascii';
import { TEST_MAP_SPEC } from '../../data/maps/fixtures/testMap';
import { createRegistry, fixtureRegistry } from '../../data/maps/registry';
import type { Rent6 } from '../../data/maps/types';
import { engineMap } from '../core/mapCache';
import { editState, makeConfig, makeSetups, testEngine } from '../testing/builders';
import type { GameState } from '../types/state';
import { landBuyPrice, landUpgradeCost } from './purchase';
import { landRentBase, quoteLandToll } from './toll';

function selectTollOf(s: GameState, em: ReturnType<typeof engineMap>, landIdx: number, payer: 0 | 1): number {
  const r = quoteLandToll(s, em, landIdx, payer);
  return r.kind === 'toll' ? r.q.amount : 0;
}

/** 台南样本：4 块同名地，地价 1500，房价 300（第一块 500，原版数据瑕疵） @source docs/research/r_rules_map.md §11.2 */
const TAINAN_RENT: Rent6 = [300, 750, 2000, 4800, 10000, 18000];
const tainanMap = buildAsciiMap({
  ...TEST_MAP_SPEC,
  id: 'tainan',
  areas: TEST_MAP_SPEC.areas.map((a) => {
    if (a.kind !== 'land') return a;
    if (a.id === 'L5') return a;
    return { ...a, streetId: 'S01', landPrice: 1500, housePrice: a.id === 'L1' ? 500 : 300, rent: TAINAN_RENT };
  }),
});
const tainanReg = createRegistry([tainanMap]);

function tainanGame(): GameState {
  const e = testEngine({ registry: tainanReg });
  return e.createGame(makeConfig({ map: 'tainan' }), makeSetups(['human', 'human']), 'c0ffee');
}

describe('住宅过路费（design/engine.md §16.1 toll）', () => {
  const em = engineMap(tainanReg.getMap('tainan'));

  it('台南 4 块同属一个地主，等级 [1,3,0,0] → (750+4800+300+300)×PI', () => {
    const levels = [1, 3, 0, 0] as const;
    for (const pi of [1, 3]) {
      const s = editState(tainanGame(), (d) => {
        d.econ.priceIndex = pi;
        levels.forEach((lv, i) => {
          d.lands[i]!.owner = 0;
          d.lands[i]!.level = lv;
        });
      });
      expect(em.streetOf(0)).toEqual([0, 1, 2, 3]);
      expect(landRentBase(s, em, 0).base).toBe(6150);
      const r = quoteLandToll(s, em, 2, 1);
      expect(r.kind).toBe('toll');
      if (r.kind === 'toll') {
        expect(r.q.amount).toBe(6150 * pi);
        expect(r.q.lots).toEqual(['L1', 'L2', 'L3', 'L4']);
        expect(r.q.mods).toContain('street');
      }
    }
  });

  it('只累加同一地主的同名地；别人的、别街的不算', () => {
    const s = editState(tainanGame(), (d) => {
      d.lands[0]!.owner = 0;
      d.lands[0]!.level = 2;
      d.lands[1]!.owner = 1;
      d.lands[1]!.level = 5;
      d.lands[4]!.owner = 0; // L5 在另一条街
      d.lands[4]!.level = 5;
    });
    expect(quoteLandToll(s, em, 0, 1)).toMatchObject({ kind: 'toll', q: { amount: 2000, owner: 0 } });
    expect(quoteLandToll(s, em, 1, 0)).toMatchObject({ kind: 'toll', q: { amount: 18000, owner: 1 } });
    expect(quoteLandToll(s, em, 0, 0)).toEqual({ kind: 'none' });
    expect(quoteLandToll(s, em, 2, 1)).toEqual({ kind: 'none' });
  });

  it('连锁店：2000 × 地主全图连锁店数 × PI；连锁店不参与同街累加', () => {
    const s = editState(tainanGame(), (d) => {
      d.econ.priceIndex = 2;
      for (const i of [0, 1]) {
        d.lands[i]!.owner = 0;
        d.lands[i]!.chain = true;
        d.lands[i]!.level = 1;
      }
      d.lands[4]!.owner = 0;
      d.lands[4]!.chain = true;
      d.lands[4]!.level = 0;
      d.lands[2]!.owner = 0;
      d.lands[2]!.level = 2;
    });
    const chain = quoteLandToll(s, em, 0, 1);
    expect(chain).toMatchObject({ kind: 'toll', q: { amount: 2000 * 3 * 2, lots: ['L1', 'L2', 'L5'] } });
    // L3 所在街：L1、L2 是连锁店，不计；只剩 L3 自己（2 级）
    expect(quoteLandToll(s, em, 2, 1)).toMatchObject({ kind: 'toll', q: { amount: 2000 * 2, lots: ['L3'] } });
  });

  it('涨价只翻倍；查封与九种免收按顺序判定', () => {
    const base = editState(tainanGame(), (d) => {
      d.lands[0]!.owner = 0;
      d.lands[0]!.level = 1;
    });
    const raised = editState(base, (d) => {
      d.lands[0]!.mark = { kind: 'raise', days: 5 };
    });
    expect(quoteLandToll(raised, em, 0, 1)).toMatchObject({ kind: 'toll', q: { amount: 1500 } });
    const cases: [(d: GameState) => void, string][] = [
      [(d) => (d.lands[0]!.mark = { kind: 'seal', days: 5 }), 'sealed'],
      [(d) => (d.players[0]!.alliance = { seat: 1, days: 7 }), 'ally'],
      [(d) => (d.players[0]!.god = { kind: 15, days: 13 }), 'ownerDeathGod'],
      [(d) => (d.players[0]!.st.hotel = 2), 'ownerHotel'],
      [(d) => (d.players[0]!.st.away = 2), 'ownerAway'],
      [(d) => (d.players[0]!.st.jail = 0x80), 'ownerJail'],
      [(d) => (d.players[0]!.st.hospital = 1), 'ownerHospital'],
      [(d) => (d.players[0]!.st.hibernate = 3), 'ownerHibernate'],
      [(d) => (d.players[0]!.st.sleepwalk = 3), 'ownerSleepwalk'],
    ];
    for (const [fn, reason] of cases) {
      expect(quoteLandToll(editState(base, fn), em, 0, 1)).toEqual({ kind: 'exempt', reason });
    }
    // 查封优先于其余条件
    const both = editState(base, (d) => {
      d.lands[0]!.mark = { kind: 'seal', days: 5 };
      d.players[0]!.st.jail = 3;
    });
    expect(quoteLandToll(both, em, 0, 1)).toEqual({ kind: 'exempt', reason: 'sealed' });
  });

  it('付款方身上的神：小财神 ÷2、大财神 0、小穷神 ×1.5（或 ×2）、大穷神 ×2', () => {
    const base = editState(tainanGame(), (d) => {
      d.lands[0]!.owner = 0;
      d.lands[0]!.level = 1;
      d.lands[1]!.owner = 0;
      d.lands[1]!.level = 0;
    });
    const amountWith = (kind: 1 | 2 | 5 | 6, x2 = false) =>
      selectTollOf(
        editState(base, (d) => {
          d.players[1]!.god = { kind, days: 7 };
          if (x2) d.config.rules.smallPoorToll = 'x2';
        }),
        em,
        0,
        1,
      );
    expect(selectTollOf(base, em, 0, 1)).toBe(1050);
    expect(amountWith(1)).toBe(525);
    expect(amountWith(2)).toBe(0);
    expect(amountWith(5)).toBe(1575);
    expect(amountWith(5, true)).toBe(2100);
    expect(amountWith(6)).toBe(2100);
  });
});

describe('fixture B 街房价不一致（L4 房价 300、L5 房价 350）', () => {
  const em = engineMap(fixtureRegistry.getMap('test'));
  const s = testEngine().createGame(makeConfig(), makeSetups(['human', 'human']), 'c0ffee');

  it('买地价与加盖费各按自己那块的房价计算', () => {
    const lv2 = editState(s, (d) => {
      d.lands[3]!.level = 2;
      d.lands[4]!.level = 2;
    });
    expect(em.lands[3]!.housePrice).toBe(300);
    expect(em.lands[4]!.housePrice).toBe(350);
    expect(landBuyPrice(lv2, em, 3)).toBe(1200 + 2 * 300);
    expect(landBuyPrice(lv2, em, 4)).toBe(1200 + 2 * 350);
    expect(landUpgradeCost(s, em, 3)).toBe(300);
    expect(landUpgradeCost(s, em, 4)).toBe(350);
  });

  it('过路费只看租金表：同街 [1,2] 级 → 600 + 1500', () => {
    const owned = editState(s, (d) => {
      d.lands[3]!.owner = 0;
      d.lands[3]!.level = 1;
      d.lands[4]!.owner = 0;
      d.lands[4]!.level = 2;
    });
    expect(selectTollOf(owned, em, 3, 1)).toBe(2100);
    expect(selectTollOf(owned, em, 4, 1)).toBe(2100);
  });
});
