import { describe, expect, it } from 'vitest';
import { CARD } from '../../data/tables/ids';
import { type Scenario, scenario } from '../testing/scenario';
import type { CardId, SeatIndex } from '../types/ids';

/**
 * 被动卡链（design/engine.md §10.3；docs/research/g_villains.md §6；r_cards.md §5）：
 * 免费卡 / 嫁祸卡在过路费、设施费、企业收费、查税（金额 ≥ 2000×PI 或 > 现金+存款 时先问免费卡再问嫁祸卡）；
 * 免罪 → 嫁祸 → 复仇（陷害、梦游）；满手弃牌（handFull='choose'）；同盟分账；CONFINE 的加持判定。
 */
function tollSetup(payerCards: CardId[], level = 5): Scenario {
  const sc = scenario({ players: ['human', 'human', 'human'] }).untilMenu(0);
  sc.teleport(0, 10, 9).teleport(1, 5, 4).teleport(2, 18, 17);
  sc.edit((s) => {
    Object.assign(s.lands[3]!, { owner: 1, level });
  });
  return sc.give(0, { cards: payerCards });
}

function deck(sc: Scenario, card: CardId): number {
  return sc.state.pools.cards[card]!;
}

describe('passive（被动卡）', () => {
  it('免费卡：过路费 ≥ 2000×PI 时询问；CONFIRM 免付、卡回牌堆（PASSIVE）', () => {
    const sc = tollSetup([CARD.FREE]);
    const [c0, c1] = [sc.player(0).cash, sc.player(1).cash];
    const d20 = deck(sc, CARD.FREE);
    sc.force('dice', 1).roll(0).expectAsk(0, 'USE_FREE_CARD');
    expect(sc.pending(0).options).toMatchObject({ context: 'toll', amount: 12000, payer: 0, lot: 'L4', slot: 0 });
    sc.confirm(0);
    sc.expectEvents(['PASSIVE']);
    // 对方 = 收过路费的地主（原版由他接一句反应台词，exe 0x419e89）
    expect(sc.event('PASSIVE')).toMatchObject({ seat: 0, card: CARD.FREE, context: 'toll', other: 1 });
    expect([sc.player(0).cash, sc.player(1).cash]).toEqual([c0, c1]);
    expect(sc.player(0).cards).toEqual([]);
    expect(deck(sc, CARD.FREE)).toBe(d20 + 1);
  });

  it('免费卡：DECLINE 照付；金额低于门槛且付得起时不问', () => {
    const sc = tollSetup([CARD.FREE]);
    sc.force('dice', 1).roll(0).decline(0);
    expect(sc.event('TOLL_PAID')).toMatchObject({ amount: 12000 });
    const low = tollSetup([CARD.FREE], 1);
    low.force('dice', 1).roll(0).expectNoAsk(0, 'USE_FREE_CARD');
    expect(low.event('TOLL_PAID')).toMatchObject({ amount: 600 });
    expect(low.player(0).cards).toEqual([CARD.FREE]);
  });

  it('免费卡：金额 > 现金 + 存款时即使低于门槛也问', () => {
    const sc = tollSetup([CARD.FREE], 1).setCash(0, 300, 200);
    sc.force('dice', 1).roll(0).expectAsk(0, 'USE_FREE_CARD');
  });

  it('免费卡：设施费（购物中心）同样问；对方 = 设施的地主（exe 0x419654）', () => {
    const sc = scenario({ players: ['human', 'human'] })
      .untilMenu(0)
      .edit((s) => {
        Object.assign(s.facilities[0]!, { owner: 1, level: 3, type: 'mall' });
      })
      .give(0, { cards: [CARD.FREE] });
    sc.force('wheel', 11).teleport(0, 16, 15).force('dice', 1).roll(0).expectAsk(0, 'USE_FREE_CARD').confirm(0);
    expect(sc.event('PASSIVE')).toMatchObject({ seat: 0, card: CARD.FREE, context: 'fee', other: 1 });
    expect(sc.events.some((e) => e.type === 'FEE_PAID')).toBe(false);
  });

  it('嫁祸卡：过路费转给新目标代付（候选不含地主）；DECLINE 自己付', () => {
    const sc = tollSetup([CARD.SCAPEGOAT]);
    const c2 = sc.player(2).cash;
    sc.force('dice', 1).roll(0).expectAsk(0, 'SCAPEGOAT');
    expect(sc.pending(0).options).toMatchObject({ context: 'toll', amount: 12000, candidates: [2] });
    expect(() => sc.act(0, { type: 'SCAPEGOAT', target: 1 })).toThrow(/INVALID_TARGET/);
    sc.act(0, { type: 'SCAPEGOAT', target: 2 });
    // 对方 = 被改嫁的新目标（exe 0x443645）
    expect(sc.event('PASSIVE')).toMatchObject({ seat: 0, card: CARD.SCAPEGOAT, context: 'toll', other: 2 });
    expect(sc.event('TOLL_PAID')).toMatchObject({ payer: 2, owner: 1, amount: 12000 });
    expect(sc.player(2).cash).toBe(c2 - 12000);
  });

  it('免费卡与嫁祸卡都有：先问免费卡，拒绝后再问嫁祸卡', () => {
    const sc = tollSetup([CARD.SCAPEGOAT, CARD.FREE]);
    sc.force('dice', 1).roll(0).expectAsk(0, 'USE_FREE_CARD').decline(0).expectAsk(0, 'SCAPEGOAT').decline(0);
    expect(sc.event('TOLL_PAID')).toMatchObject({ payer: 0, amount: 12000 });
  });

  it('旅馆：不能用免费卡，可以嫁祸（住宿仍落在落点者身上 ⚑）', () => {
    const sc = scenario({ players: ['human', 'human', 'human'] }).untilMenu(0);
    sc.teleport(0, 16, 15)
      .teleport(1, 5, 4)
      .teleport(2, 12, 11)
      .give(0, { cards: [CARD.FREE, CARD.SCAPEGOAT] });
    sc.edit((s) => {
      Object.assign(s.facilities[0]!, { owner: 1, level: 5, type: 'hotel' });
    });
    sc.force('wheel', 0).force('dice', 1).roll(0).expectAsk(0, 'SCAPEGOAT');
    sc.act(0, { type: 'SCAPEGOAT', target: 2 });
    expect(sc.event('FEE_PAID')).toMatchObject({ payer: 2, feeKind: 'hotel', amount: 13000 });
    expect(sc.event('HOTEL_STAY')).toMatchObject({ seat: 0 });
  });

  it('查税：免费卡抵消；嫁祸回出卡者则不收；嫁祸给别人按新目标现金重算', () => {
    const base = () => {
      const sc = scenario({ players: ['human', 'human', 'human'] }).untilMenu(0);
      sc.teleport(0, 5, 4).teleport(1, 6, 5).teleport(2, 12, 11).setCash(1, 50000, 0).setCash(2, 20000, 0);
      return sc.give(0, { cards: [CARD.TAX_AUDIT] });
    };
    const free = base().give(1, { cards: [CARD.FREE] });
    free.useCard(0, CARD.TAX_AUDIT, { t: 'seat', seat: 1 }).expectAsk(1, 'USE_FREE_CARD').confirm(1);
    // 对方 = 查税的出卡者（exe 0x443ede 传当前玩家）
    expect(free.event('PASSIVE')).toMatchObject({ seat: 1, card: CARD.FREE, context: 'taxAudit', other: 0 });
    expect(free.player(1).cash).toBe(50000);
    expect(free.player(1).hostility[0]).toBe(100);

    const back = base().give(1, { cards: [CARD.SCAPEGOAT] });
    back.useCard(0, CARD.TAX_AUDIT, { t: 'seat', seat: 1 }).expectAsk(1, 'SCAPEGOAT');
    expect(back.pending(1).options).toMatchObject({ context: 'taxAudit', candidates: [0, 2] });
    const dep0 = back.player(0).deposit;
    back.act(1, { type: 'SCAPEGOAT', target: 0 });
    expect(back.event('PASSIVE')).toMatchObject({ seat: 1, card: CARD.SCAPEGOAT, other: 0 });
    expect([back.player(0).deposit, back.player(1).cash]).toEqual([dep0, 50000]);

    const other = base().give(1, { cards: [CARD.SCAPEGOAT] });
    other.useCard(0, CARD.TAX_AUDIT, { t: 'seat', seat: 1 }).act(1, { type: 'SCAPEGOAT', target: 2 });
    expect(other.player(2).cash).toBe(16000);
    expect(other.player(1).cash).toBe(50000);
    other.expectAsk(0, 'TURN_MENU');
  });

  it('免罪卡：陷害自动抵消（优先于嫁祸与复仇），卡回牌堆', () => {
    const sc = scenario({ players: ['human', 'human', 'human'] }).untilMenu(0);
    sc.teleport(0, 5, 4).teleport(1, 6, 5).teleport(2, 12, 11);
    sc.give(0, { cards: [CARD.FRAME] }).give(1, { cards: [CARD.PARDON, CARD.SCAPEGOAT, CARD.REVENGE] });
    sc.useCard(0, CARD.FRAME, { t: 'actor', actor: { t: 'seat', seat: 1 } });
    sc.expectEvents(['CARD_USED', 'PASSIVE']).expectAsk(0, 'TURN_MENU');
    // 免罪只有持卡人一句台词（exe 0x44381f），没有对方
    expect(sc.event('PASSIVE')).toMatchObject({ seat: 1, card: CARD.PARDON, context: 'frame', other: null });
    expect(sc.player(1).st.jail).toBe(0);
    expect(sc.player(1).cards).toEqual([CARD.SCAPEGOAT, CARD.REVENGE]);
    // 敌意照记
    expect(sc.player(1).hostility[0]).toBe(150);
  });

  it('梦游卡：嫁祸给第三人（5 天），不触发复仇；免罪同样抵消', () => {
    const sc = scenario({ players: ['human', 'human', 'human'] }).untilMenu(0);
    sc.teleport(0, 5, 4).teleport(1, 6, 5).teleport(2, 12, 11);
    sc.give(0, { cards: [CARD.SLEEPWALK, CARD.SLEEPWALK] }).give(1, { cards: [CARD.SCAPEGOAT, CARD.REVENGE] });
    sc.useCard(0, CARD.SLEEPWALK, { t: 'actor', actor: { t: 'seat', seat: 1 } }).expectAsk(1, 'SCAPEGOAT');
    expect(sc.pending(1).options).toMatchObject({ context: 'sleepwalk', days: 5, candidates: [0, 2] });
    sc.act(1, { type: 'SCAPEGOAT', target: 2 });
    expect(sc.event('PASSIVE')).toMatchObject({ seat: 1, card: CARD.SCAPEGOAT, context: 'sleepwalk', other: 2 });
    expect(sc.player(2).st.sleepwalk).toBe(5);
    expect(sc.player(1).st.sleepwalk).toBe(0);
    expect(sc.player(0).st.sleepwalk).toBe(0);
    expect(sc.player(1).cards).toEqual([CARD.REVENGE]);
    // 1 号手里只剩复仇卡：再被梦游时出卡者也梦游 5 天，出卡者的回合随即变成自动乱走
    sc.useCard(0, CARD.SLEEPWALK, { t: 'actor', actor: { t: 'seat', seat: 1 } });
    sc.expectEvents(['CARD_USED', 'STATUS_SET', 'PASSIVE', 'STATUS_SET', 'DICE_ROLLED']);
    const set = sc.events.filter((e) => e.type === 'STATUS_SET');
    expect(set.slice(0, 2).map((e) => [e.actor, e.status, e.value])).toEqual([
      [{ t: 'seat', seat: 1 }, 'sleepwalk', 5],
      [{ t: 'seat', seat: 0 }, 'sleepwalk', 5],
    ]);
    // 对方 = 出卡者（exe 0x443383：当前玩家接一句反应台词）
    expect(sc.event('PASSIVE')).toMatchObject({ seat: 1, card: CARD.REVENGE, context: 'sleepwalk', other: 0 });
  });

  it('满手弃牌（handFull=choose）：先入手，再由 DISCARD_CARD 选一张弃掉；autoCheapest 自动弃最便宜的', () => {
    const full: CardId[] = [1, 2, 9, 10, 11, 13, 15, 16, 17, 22, 23, 24, 25, 26, 29];
    const sc = scenario({ players: ['human', 'human'], rules: { handFull: 'choose' } }).untilMenu(0);
    sc.give(0, { cards: full }).teleport(0, 3, 2).force('deck', CARD.FREE).force('dice', 1).roll(0);
    sc.expectAsk(0, 'DISCARD_CARD');
    expect(sc.player(0).cards).toHaveLength(16);
    expect(sc.pending(0).options).toMatchObject({ incoming: CARD.FREE });
    expect(sc.pending(0).defaultIntent).toEqual({ type: 'DISCARD', slot: 9 });
    sc.act(0, { type: 'DISCARD', slot: 0 });
    expect(sc.player(0).cards).toHaveLength(15);
    expect(sc.player(0).cards[0]).toBe(2);
    sc.expectEvents(['CARD_LOST']);

    const auto = scenario({ players: ['human', 'human'] }).untilMenu(0);
    auto.give(0, { cards: full }).teleport(0, 3, 2).force('deck', CARD.FREE).force('dice', 1).roll(0);
    auto.expectEvents(['CARD_LOST', 'CARD_GAINED']);
    expect(auto.event('CARD_LOST')).toMatchObject({ card: 22, cause: 'discard' });
    expect(auto.player(0).cards).toHaveLength(15);
  });

  it('同盟：盟友名下同名路段的租金并入总额，按比例分账（先付地主再付盟友）；盟友之间免收', () => {
    const sc = scenario({ players: ['human', 'human', 'human'] }).untilMenu(0);
    sc.teleport(0, 5, 4)
      .teleport(1, 6, 5)
      .teleport(2, 12, 11)
      .give(0, { cards: [CARD.ALLIANCE] });
    sc.edit((s) => {
      Object.assign(s.lands[0]!, { owner: 0, level: 2 });
      Object.assign(s.lands[1]!, { owner: 1, level: 2 });
      Object.assign(s.lands[2]!, { owner: 1, level: 1 });
    });
    sc.useCard(0, CARD.ALLIANCE, { t: 'seat', seat: 1 }).roll(0).untilMenu(2);
    // 2 号停在 L2（1 号的）：地主份 2500+1000 = 3500，盟友份 2500 → 总额 6000
    sc.teleport(2, 5, 4).force('dice', 1).roll(2);
    const paid = sc.event('TOLL_PAID');
    expect(paid).toMatchObject({
      payer: 2,
      owner: 1,
      ally: 0,
      amount: 6000,
      mods: expect.arrayContaining(['alliance']),
    });
    expect(paid.allyAmount).toBe(Math.trunc(6000 * Math.fround(2500 / 6000)));
    // 1 号停在 0 号的 L1：盟友免收
    sc.untilMenu(1).teleport(1, 4, 3).force('dice', 1).roll(1);
    expect(sc.event('TOLL_EXEMPT')).toMatchObject({ reason: 'ally' });
  });

  it('CONFINE 的福运加持：high 逃过此劫（BLESSING），low 天数 ×2', () => {
    const run = (fortune: number, force: number | null) => {
      const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
      sc.teleport(1, 6, 5)
        .give(0, { cards: [CARD.STAY] })
        .edit((s) => {
          s.players[1]!.luck.fortune = fortune;
          s.counters.frame += 1;
          s.flow.push({
            k: 'CONFINE',
            fid: s.counters.frame,
            actor: { t: 'seat', seat: 1 as SeatIndex },
            where: 'jail',
            days: 3,
            cause: { k: 'fate', ref: 33, by: null },
            passive: true,
            blessing: true,
            hate: 0,
            orig: 1,
            selfDays: null,
            revenge: false,
            scapegoated: false,
            wreck: false,
            stage: 'hostility',
          });
        });
      if (force !== null) sc.force('bless', force);
      return sc.useCard(0, CARD.STAY, { t: 'actor', actor: { t: 'seat', seat: 0 } });
    };
    const high = run(150, null);
    expect(high.event('BLESSING')).toMatchObject({ seat: 1, category: 'misfortune', result: 'high' });
    expect(high.player(1).st.jail).toBe(0);
    const low = run(-60, null);
    expect(low.event('BLESSING')).toMatchObject({ result: 'low' });
    expect(low.player(1).st.jail).toBe(6);
    const coin = run(60, 0);
    expect(coin.events.some((e) => e.type === 'BLESSING')).toBe(false);
    expect(coin.player(1).st.jail).toBe(3);
  });
});
