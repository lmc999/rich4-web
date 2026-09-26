import { describe, expect, it } from 'vitest';
import { fixtureRegistry } from '../../data/maps/registry';
import { engineMap } from '../core/mapCache';
import { EngineInvariantError } from '../errors';
import { spendCash, transfer } from '../rules/payment';
import { canBuyLand, canUpgradeLand } from '../rules/purchase';
import { editState } from '../testing/builders';
import { scenario } from '../testing/scenario';

const em = engineMap(fixtureRegistry.getMap('test'));

/**
 * intOverflow='wrap'（DEV-01 的原版选项）下金额回绕成负数的处理：按 C 语义反向流动、不破产、不抛非规则异常。
 * fixture 'test' S01 街：地价 2000 / 房价 500 / rent[5] = 24000；L1 单独 5 级时基数 24000。
 */
describe('场景：wrap 模式下高物价指数的过路费', () => {
  function ownedL1(rules: { intOverflow: 'wrap' | 'saturate' }) {
    const sc = scenario({ players: ['human', 'human', 'human'], rules }).untilMenu(0);
    sc.teleport(0, 4, 3).force('dice', 1).roll(0).confirm(0);
    sc.untilMenu(1).edit((s) => {
      s.lands[0]!.level = 5;
      s.econ.priceIndex = 100000;
    });
    return sc;
  }

  it('24000 × 100000 回绕为负：付款方现金反增、地主减少，不破产，不变量成立', () => {
    const sc = ownedL1({ intOverflow: 'wrap' });
    const cash0 = sc.player(0).cash;
    const cash1 = sc.player(1).cash;
    const neg = (24000 * 100000) | 0;
    expect(neg).toBe(-1894967296);
    sc.teleport(1, 3, 2).force('dice', 2).roll(1);
    expect(sc.event('TOLL_PAID')).toMatchObject({ payer: 1, owner: 0, amount: neg, lots: ['L1'] });
    expect(sc.events.map((e) => e.type)).not.toContain('BANKRUPT');
    expect(sc.player(1).cash).toBe(cash1 - neg);
    expect(sc.player(0).cash).toBe(cash0 + neg);
    expect(sc.player(1).monthly.loss).toBe(neg);
    expect(sc.player(0).monthly.gain).toBe(neg);
    expect(sc.state.lands[0]!.lastToll).toBe(neg);
    // 对局继续推进（不卡死）
    sc.untilMenu(2);
  });

  it('saturate 模式同样局面：报价夹到 INT32_MAX，付款人破产', () => {
    const sc = ownedL1({ intOverflow: 'saturate' });
    sc.teleport(1, 3, 2).force('dice', 2).roll(1);
    expect(sc.events.map((e) => e.type)).toContain('BANKRUPT');
  });
});

describe('场景：wrap 模式下买地 / 加盖价格回绕为负', () => {
  it('能买就能确认：负价买地按 C 语义现金反增，决策与确认口径一致', () => {
    const sc = scenario({ players: ['human', 'human'], rules: { intOverflow: 'wrap' } }).untilMenu(0);
    sc.edit((s) => {
      s.lands[0]!.level = 5;
      s.econ.priceIndex = 500000;
    });
    const price = (4500 * 500000) | 0;
    expect(price).toBeLessThan(0);
    sc.teleport(0, 4, 3).force('dice', 1).roll(0).expectAsk(0, 'BUY_LAND');
    expect(sc.pending(0).options).toMatchObject({ lot: 'L1', price });
    const cash = sc.player(0).cash;
    sc.confirm(0);
    expect(sc.event('LAND_BOUGHT')).toMatchObject({ seat: 0, lot: 'L1', price });
    expect(sc.player(0).cash).toBe(cash - price);
    expect(sc.state.lands[0]!.owner).toBe(0);
  });

  it('负价加盖同样可以确认', () => {
    const sc = scenario({ players: ['human', 'human'], rules: { intOverflow: 'wrap' } }).untilMenu(0);
    sc.teleport(0, 4, 3).force('dice', 1).roll(0).confirm(0);
    sc.untilMenu(0).edit((s) => {
      s.econ.priceIndex = 5000000;
    });
    const cost = (500 * 5000000) | 0;
    expect(cost).toBeLessThan(0);
    sc.teleport(0, 4, 3).force('dice', 1).roll(0).expectAsk(0, 'UPGRADE_LAND');
    const cash = sc.player(0).cash;
    sc.confirm(0);
    expect(sc.player(0).cash).toBe(cash - cost);
    expect(sc.state.lands[0]!.level).toBe(1);
  });

  it('负价与现金的比较沿用 C 语义：现金 < 负价时买不起，canBuyLand 与 spendCash 口径一致', () => {
    const sc = scenario({ players: ['human', 'human'], rules: { intOverflow: 'wrap' } }).untilMenu(0);
    const s = editState(sc.state, (d) => {
      d.lands[0]!.level = 5;
      d.econ.priceIndex = 500000;
      d.players[0]!.cash = -2100000000;
      d.econ.ledger.burned += 100000 + 2100000000;
    });
    const price = (4500 * 500000) | 0;
    expect(canBuyLand(s, em, 0, 0)).toMatchObject({ ok: false, reason: 'notEnoughCash', price });
    expect(spendCash(s, 0, price)).toBe(false);
    const s2 = editState(sc.state, (d) => {
      d.econ.priceIndex = 5000000;
    });
    expect(canUpgradeLand(s2, em, 0, 0).price).toBe((500 * 5000000) | 0);
  });

  it('saturate 模式拒绝负数金额（不会出现，出现即内部缺陷）', () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    const s = editState(sc.state, () => {});
    expect(spendCash(s, 0, -1)).toBe(false);
    expect(() => transfer(s, { t: 'seat', seat: 0 }, { t: 'seat', seat: 1 }, -1)).toThrow(EngineInvariantError);
  });
});
