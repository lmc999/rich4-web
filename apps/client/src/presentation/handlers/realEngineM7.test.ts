// M7「事件与收尾」的真实引擎载荷 × 前端演出（定向覆盖，补自对弈抽不全的编号）：
// - 新闻 36 条、命运 37 条（按座驾替换的 10–16 分别换座驾触发）逐条经牌堆（stackDeck）+ 强制骰子落到新闻 / 命运格；
// - 魔法屋 12 种效果逐一施放；拍卖卡（多人出价、放弃、成交）；雇用四大恶人后原版 AI 接着玩一段（作案、回家）；
// - 投降 + 死神附身；时光机（TIME_REWOUND + SYNC）；公布栏挂牌 / 成交 / 撤牌。
// 引擎后续决策一律交给原版 AI（与服务器相同的兜底：不合法时用 defaultIntent）。每个样本逐个交给未封顶的 handler：
// 不抛错；日志行、toast、飘字、气泡、弹窗、竞价横幅里没有 undefined / NaN / 残留插值 / 未命中的 i18n 键；自然用时 ≤ 预算。
import { fixtureRegistry, type MapIndex } from '@rich4/shared/data';
import {
  FATE_IDS,
  type FateId,
  type GameAction,
  type GameEvent,
  type GameState,
  type MagicEffectId,
  NEWS_IDS,
  type NewsId,
  type PlayerIntent,
  type SeatIndex,
  VILLAIN_KINDS,
  type VillainKind,
} from '@rich4/shared/engine';
import { type Scenario, scenario } from '@rich4/shared/engine-testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { initI18n } from '../../i18n';
import { tx } from '../../i18n/tx';
import {
  aiAction,
  BAD_TEXT,
  defaultAction,
  play,
  playAll,
  type Sample,
  samplesOf,
  tagOf,
  viewOf,
} from '../../test/realEngineHarness';
import { type NewsPopupSpec, usePopupStore } from '../../ui/popups/popupStore';
import { fateShown, newsHeadline, oneLine } from '../eventText';
import { makeNames } from '../names';

beforeAll(() => {
  initI18n('original');
});

const MAP_ID = 'test-allkinds';
const map: MapIndex = fixtureRegistry.getMap(MAP_ID);

// test-allkinds：1 银行 → 2 新闻 → 3 命运 → 4 卡片 → 5 L1 → 6 L2 → 7 L3 → 8 乐透 → 9 魔法屋 → 10 百货 → 11 L4 → 12 L5 → 13 → 14 监狱
const NEWS_TILE = 2;
const FATE_TILE = 3;
const MAGIC_TILE = 9;
const JAIL_GATE = 14;

/** 在 applyAction 之间记录样本 */
class Recorder {
  readonly samples: Sample[] = [];
  private view;
  constructor(readonly sc: Scenario) {
    this.view = viewOf(sc.state);
  }

  /** 提交 action（同 Scenario.apply），并把事件记为样本 */
  apply(a: GameAction): void {
    const before = this.view;
    this.sc.apply(a);
    const got = samplesOf(this.sc.events, before, this.sc.state);
    this.samples.push(...got.samples);
    this.view = got.view;
  }

  act(seat: SeatIndex, intent: PlayerIntent): void {
    const d = this.sc.pending(seat);
    this.apply({ ...intent, seat, decisionId: d.id } as GameAction);
  }

  /** 让原版 AI 回答待决策，直到 stop 成立（或 max 步） */
  drive(stop: (s: GameState) => boolean, max = 400): void {
    for (let i = 0; i < max && this.sc.state.status === 'playing' && !stop(this.sc.state); i++) {
      const a = aiAction(this.sc.state, map);
      if (!a) return;
      try {
        this.apply(a);
      } catch {
        this.apply(defaultAction(this.sc.state)!);
      }
    }
  }

  /** 推进到任何人的回合菜单（本回合的事件结算完） */
  settle(max = 400): void {
    this.drive((s) => s.pending.some((d) => d.kind === 'TURN_MENU'), max);
  }

  types(): string[] {
    return this.samples.map((x) => x.e.type);
  }
}

function buyShares(s: GameState, seat: SeatIndex, idx: number, n: number): void {
  const p = s.players.find((x) => x.seat === seat)!;
  const st = s.stocks[idx]!;
  const h = p.holdings[idx]!;
  p.holdings[idx] = { shares: h.shares + n, costCents: st.priceCents };
  st.float -= n;
  let best = 0;
  let who: SeatIndex | null = null;
  for (const q of s.players) {
    const k = q.holdings[idx]?.shares ?? 0;
    if (q.alive && k > best) {
      best = k;
      who = q.seat;
    }
  }
  st.chairman = who;
}

/**
 * 事件格场景：4 人（0、1 号真人），地产有主有房、有人持股（有董事长）、1 支停牌、公司本月有盈余、
 * 对手有卡；可选让 3 号关在监狱、2 号住院（新闻 0–3 需要）。
 */
function eventArena(o: { confined?: boolean } = {}): Scenario {
  const sc = scenario({ players: ['human', 'human', 'ai', 'ai'], map: MAP_ID }).untilMenu(0);
  sc.edit((s) => {
    const land = (id: string, owner: SeatIndex | null, level: number) => {
      const l = s.lands.find((x) => x.id === id)!;
      l.owner = owner;
      l.level = level as 0;
    };
    land('L1', 0, 2);
    land('L2', 1, 1);
    land('L3', 0, 0);
    land('L4', 2, 3);
    land('L5', null, 0);
    const f = s.facilities.find((x) => x.id === 'F1');
    if (f) {
      f.owner = 1;
      f.level = 1;
      f.type = 'hotel';
    }
    buyShares(s, 0, 0, 300);
    buyShares(s, 1, 1, 500);
    buyShares(s, 2, 2, 200);
    s.stocks[3]!.suspend = 5;
    // 公司本月盈余（计入资金守恒：同额记为铸造）
    for (const c of s.companies) {
      s.econ.ledger.minted += 40000 - c.surplusMonth;
      c.surplusMonth = 40000;
    }
  });
  sc.give(1, { cards: [17, 12] }).give(2, { cards: [3] });
  // 3 号骑机车（新闻 17 要有乘车的人）：座驾计入道具库存
  sc.edit((s) => {
    const p = s.players.find((x) => x.seat === 3)!;
    s.pools.items[5] = s.pools.items[5]! - 1;
    p.vehicle = 'moto';
    p.diceCount = 2;
  });
  if (o.confined) {
    sc.bench(3, 5);
    sc.edit((s) => {
      const p = s.players.find((x) => x.seat === 2)!;
      const hold = map.hospitalHold;
      p.st.hospital = 4;
      p.placed = true;
      p.node = hold;
      p.prevNode = hold;
    });
  }
  return sc;
}

/** 0 号从 from 掷 1 点落到下一格 */
function stepOnto(r: Recorder, from: number, prev: number): void {
  r.sc.untilMenu(0);
  r.apply({ type: 'SYS_DEBUG', op: { op: 'teleport', seat: 0, node: from, prev } });
  r.apply({ type: 'SYS_DEBUG', op: { op: 'forceNext', purpose: 'dice', values: [1] } });
  r.act(0, { type: 'ROLL', dice: 1 });
}

/** events:param.* 的缺省占位词：出现即说明模板用到了引擎没给的键 */
const PLACEHOLDER = /某处地产|某家公司|某支股票|某位玩家|一笔钱|若干|某处/;

const byType = (samples: readonly Sample[], type: string): GameEvent[] =>
  samples.filter((s) => s.e.type === type).map((s) => s.e);

async function expectClean(samples: readonly Sample[]): Promise<void> {
  usePopupStore.getState().clear();
  const { over } = await playAll(samples, map, (tag, t) => expect(t, tag).not.toMatch(BAD_TEXT));
  usePopupStore.getState().clear();
  expect(over).toEqual([]);
}

describe('M7 真实引擎事件 × handler（定向覆盖）', { timeout: 120_000 }, () => {
  it('新闻 36 条逐条：NEWS 载荷的插值参数全部解析，弹窗与日志完整', async () => {
    const all: Sample[] = [];
    const seen = new Set<NewsId>();
    for (const id of NEWS_IDS) {
      const sc = eventArena({ confined: id <= 3 });
      const r = new Recorder(sc);
      r.apply({ type: 'SYS_DEBUG', op: { op: 'stackDeck', deck: 'news', ids: [id] } });
      stepOnto(r, NEWS_TILE - 1, 18);
      r.settle();
      const news = byType(r.samples, 'NEWS');
      expect(news.length, `news ${id}: ${r.types().join(',')}`).toBeGreaterThan(0);
      const first = news[0] as Extract<GameEvent, { type: 'NEWS' }>;
      expect(first.id, `news ${id}`).toBe(id);
      seen.add(first.id);
      all.push(...r.samples);
    }
    expect(seen.size).toBe(NEWS_IDS.length);
    // 模板里用到的插值键引擎都给了：正文不出现缺省占位词
    for (const s of all) {
      if (s.e.type !== 'NEWS') continue;
      const n = makeNames({ t: tx, view: () => s.before, map: () => map });
      const text = oneLine(newsHeadline(n, s.e.id, s.e.params));
      expect(text, tagOf(s.e)).not.toMatch(PLACEHOLDER);
    }
    await expectClean(all);
  });

  it('新闻板逐人行（11–13 税、23 储金红利）：金额按公布时的显示态算（selectors.newsRowAmount），与引擎随后实际收付相同', async () => {
    for (const id of [11, 12, 13, 23] as NewsId[]) {
      const sc = eventArena();
      // 每人都有存款（储金红利要有人领；资金守恒：同额记为铸造）
      sc.edit((s) => {
        for (const p of s.players) {
          const add = 1234 * (p.seat + 1);
          s.econ.ledger.minted += add;
          p.deposit += add;
        }
      });
      const r = new Recorder(sc);
      r.apply({ type: 'SYS_DEBUG', op: { op: 'stackDeck', deck: 'news', ids: [id] } });
      stepOnto(r, NEWS_TILE - 1, 18);
      r.settle();
      const at = r.samples.findIndex((x) => x.e.type === 'NEWS');
      expect(at, `news ${id}`).toBeGreaterThanOrEqual(0);
      const news = r.samples[at]!.e as Extract<GameEvent, { type: 'NEWS' }>;
      expect(news.affected.length, `news ${id}`).toBeGreaterThan(0);
      // 引擎随后的收付：税 = MONEY{from seat, reason tax}，红利 = MONEY{to seat, reason reward}
      const paid = new Map<SeatIndex, number>();
      for (const x of r.samples.slice(at + 1)) {
        if (x.e.type !== 'MONEY') continue;
        if (id === 23 && x.e.reason === 'reward' && x.e.to.t === 'seat') paid.set(x.e.to.seat, x.e.amount);
        if (id !== 23 && x.e.reason === 'tax' && x.e.from.t === 'seat') paid.set(x.e.from.seat, x.e.amount);
      }
      usePopupStore.getState().clear();
      const played = await play(r.samples[at]!, map);
      const spec = played.popups.find((x) => (x as { kind?: string }).kind === 'news') as NewsPopupSpec;
      expect(spec.affected.map((a) => a.seat)).toEqual(news.affected);
      for (const row of spec.affected) {
        const amount = paid.get(row.seat);
        expect(amount, `news ${id} seat ${row.seat}`).toBeGreaterThan(0);
        expect(row.line, `news ${id} seat ${row.seat}`).toBe(
          tx(`news:${id}.row`, { who: row.name, amount: String(amount) }),
        );
      }
    }
    usePopupStore.getState().clear();
  });

  it('命运 37 条逐条（10–16 按座驾换号）：金额含义、天数、加持文案完整', async () => {
    const all: Sample[] = [];
    const seen = new Set<FateId>();
    const vehicleOf = (id: FateId): 5 | 6 | null => ([10, 13, 15].includes(id) ? 5 : [11, 16].includes(id) ? 6 : null);
    for (const id of FATE_IDS) {
      const sc = eventArena();
      const r = new Recorder(sc);
      const v = vehicleOf(id);
      if (v !== null) {
        // 换座驾：发道具并在回合菜单里使用（VEHICLE）
        r.apply({ type: 'SYS_DEBUG', op: { op: 'give', seat: 0, cards: [], items: [{ item: v, qty: 1 }] } });
        r.act(0, { type: 'USE_ITEM', item: v, target: { t: 'none' } });
      }
      r.apply({ type: 'SYS_DEBUG', op: { op: 'stackDeck', deck: 'fate', ids: [id] } });
      stepOnto(r, FATE_TILE - 1, NEWS_TILE - 1);
      r.settle();
      const fate = byType(r.samples, 'FATE') as Extract<GameEvent, { type: 'FATE' }>[];
      expect(fate.length, `fate ${id}: ${r.types().join(',')}`).toBeGreaterThan(0);
      expect(fate[0]!.id, `fate ${id}`).toBe(id);
      seen.add(fate[0]!.id);
      all.push(...r.samples);
    }
    expect(seen.size).toBe(FATE_IDS.length);
    for (const s of all) {
      if (s.e.type !== 'FATE') continue;
      const n = makeNames({ t: tx, view: () => s.before, map: () => map });
      const shown = fateShown(n, s.e);
      const text = n.t(`fate:${s.e.id}.text`, shown.params);
      expect(text, tagOf(s.e)).not.toMatch(PLACEHOLDER);
    }
    await expectClean(all);
  });

  it('命运弹窗：罚金显示为支出、补偿与奖金为收入、点券与贷款带说明', async () => {
    const sc = eventArena();
    const r = new Recorder(sc);
    r.apply({ type: 'SYS_DEBUG', op: { op: 'stackDeck', deck: 'fate', ids: [0] } });
    stepOnto(r, FATE_TILE - 1, NEWS_TILE - 1);
    r.settle();
    const s0 = r.samples.find((x) => x.e.type === 'FATE')!;
    usePopupStore.getState().clear();
    const p0 = await play(s0, map);
    const spec = p0.popups.find((x) => (x as { kind?: string }).kind === 'fate') as {
      amountText: string | null;
      amountTone?: string;
      text: string;
    };
    // 命运 0：强拆，补偿 = 等级 × 房价（收入）
    expect(spec.amountText).toMatch(/^\+/);
    expect(spec.amountTone).toBe('gain');
    // 原文「強制拆除房屋一棟」不带补偿金额（补偿只在程序化翻面卡的金额行与随后的 MONEY 里）
    expect(spec.text).toBe('强制拆除房屋一栋');
  });

  it('魔法屋 12 种效果逐一施放：条件名单、效果名、目标与后续子帧（命运、关押、拍卖、选设施）', async () => {
    const all: Sample[] = [];
    for (const effect of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as MagicEffectId[]) {
      const sc = eventArena();
      const r = new Recorder(sc);
      // 条件 10 / 11（男生 / 女生）一定有人；让 0 号脚下是魔法屋前一格的地产不影响：效果 5/9/11 作用于各目标脚下
      r.apply({ type: 'SYS_DEBUG', op: { op: 'teleport', seat: 1, node: 6, prev: 5 } });
      r.apply({
        type: 'SYS_DEBUG',
        op: { op: 'forceNext', purpose: 'magicCond', values: [effect % 2 === 0 ? 10 : 11] },
      });
      stepOnto(r, MAGIC_TILE - 1, MAGIC_TILE - 2);
      r.sc.expectAsk(0, 'MAGIC_CAST');
      r.act(0, { type: 'MAGIC_CAST', effect });
      r.settle();
      const cast = byType(r.samples, 'MAGIC_CAST') as Extract<GameEvent, { type: 'MAGIC_CAST' }>[];
      expect(cast[0]?.effect, `effect ${effect}`).toBe(effect);
      all.push(...r.samples);
    }
    expect(all.some((s) => s.e.type === 'MAGIC_CONDITION')).toBe(true);
    await expectClean(all);
  });

  it('拍卖卡：三名竞拍者出价、加价、放弃 → 成交；竞价横幅跟随出价、结束后收起', async () => {
    const sc = eventArena();
    const r = new Recorder(sc);
    r.apply({ type: 'SYS_DEBUG', op: { op: 'teleport', seat: 0, node: 5, prev: 4 } });
    r.apply({ type: 'SYS_DEBUG', op: { op: 'give', seat: 0, cards: [8], items: [] } });
    const slot = r.sc.player(0).cards.indexOf(8);
    r.act(0, { type: 'USE_CARD', slot, card: 8, target: { t: 'underfoot', facility: null } });
    const started = byType(r.samples, 'AUCTION_STARTED')[0] as Extract<GameEvent, { type: 'AUCTION_STARTED' }>;
    expect(started).toMatchObject({ lot: 'L1', seller: 0, source: 'card' });
    expect(started.bidders).toEqual([1, 2, 3]);
    // 1 号按起拍价 → 2 号这轮不加价 → 3 号 +1000（2 号恢复为可出价）→ 1 号退出 → 2 号 +500 → 3 号不加价 → 2 号成交
    r.act(1, { type: 'BID', inc: 0 });
    r.act(2, { type: 'PASS' });
    r.act(3, { type: 'BID', inc: 1000 });
    r.act(1, { type: 'QUIT' });
    r.act(2, { type: 'BID', inc: 500 });
    r.act(3, { type: 'PASS' });
    const ended = byType(r.samples, 'AUCTION_ENDED')[0] as Extract<GameEvent, { type: 'AUCTION_ENDED' }>;
    expect(ended).toMatchObject({ lot: 'L1', winner: 2, price: started.start + 1500 });
    expect(r.sc.state.lands.find((l) => l.id === 'L1')?.owner).toBe(2);
    for (const t of ['AUCTION_BID', 'AUCTION_PASS', 'AUCTION_QUIT']) expect(r.types()).toContain(t);

    usePopupStore.getState().clear();
    type Banner = { price: number; leader: { seat: number } | null; bidders: { seat: number; state: string }[] };
    const banners: { type: string; banner: Banner }[] = [];
    for (const s of r.samples) {
      const p = await play(s, map);
      for (const t of p.texts) expect(t, tagOf(s.e)).not.toMatch(BAD_TEXT);
      const a = usePopupStore.getState().auction;
      if (a) banners.push({ type: s.e.type, banner: structuredClone(a) as unknown as Banner });
    }
    const state = (b: Banner, seat: number) => b.bidders.find((x) => x.seat === seat)?.state;
    // 2 号放弃后显示「这轮不加价」；3 号加价后 2 号恢复为竞拍中（与引擎相同）；1 号退出后显示已退出
    expect(banners.some((x) => x.type === 'AUCTION_PASS' && state(x.banner, 2) === 'passed')).toBe(true);
    const after3 = banners.find((x) => x.type === 'AUCTION_BID' && x.banner.leader?.seat === 3)!;
    expect(after3.banner.price).toBe(started.start + 1000);
    expect(state(after3.banner, 2)).toBe('active');
    expect(banners.some((x) => x.type === 'AUCTION_QUIT' && state(x.banner, 1) === 'quit')).toBe(true);
    // 结束后横幅收起
    expect(usePopupStore.getState().auction).toBeNull();
  });

  it('四大恶人：保释格雇用（HIRE）→ 原版 AI 接着玩，作案与回家的演出文案完整', async () => {
    const all: Sample[] = [];
    const hired = new Set<VillainKind>();
    for (const kind of VILLAIN_KINDS) {
      const sc = eventArena();
      const r = new Recorder(sc);
      const home = r.sc.state.villains.find((v) => v.kind === kind)!.home;
      const gate = home === 'jail' ? JAIL_GATE : JAIL_GATE + 1;
      r.apply({ type: 'SYS_DEBUG', op: { op: 'setPoints', seat: 0, points: 1000 } });
      stepOnto(r, gate - 1, gate - 2);
      r.sc.expectAsk(0, 'BAIL');
      r.act(0, { type: 'HIRE', villain: kind });
      const h = byType(r.samples, 'VILLAIN_HIRED')[0] as Extract<GameEvent, { type: 'VILLAIN_HIRED' }>;
      expect(h).toMatchObject({ by: 0, kind });
      hired.add(h.kind);
      // 接着让原版 AI 玩一段（0、1 号也交给 AI），收集恶人的行走、作案、回家
      r.drive(() => false, 600);
      all.push(...r.samples);
    }
    expect(hired.size).toBe(4);
    expect(all.some((s) => s.e.type === 'VILLAIN_ACTION' || s.e.type === 'VILLAIN_HOME')).toBe(true);
    expect(all.some((s) => s.e.type === 'MOVE_SEGMENT' && s.e.actor.t === 'villain')).toBe(true);
    await expectClean(all);
  });

  it('投降 → 死神附身 → 清算拍卖；时光机；公布栏挂牌、成交、撤牌', async () => {
    const all: Sample[] = [];
    // 投降（0 号真人；1 号也是真人，在场 4 人）
    {
      const sc = eventArena();
      sc.edit((s) => {
        // 投降者名下 5 处地产：清算时随机拍卖 3 处
        for (const l of s.lands) {
          l.owner = 0;
        }
      });
      const r = new Recorder(sc);
      r.act(0, { type: 'SURRENDER' });
      r.sc.expectAsk(0, 'DEATH_GOD_TARGET');
      r.act(0, { type: 'DEATH_GOD_TARGET', target: 2 });
      r.settle();
      for (const t of ['SURRENDERED', 'DEATH_GOD_SUMMONED', 'LIQUIDATION', 'AUCTION_STARTED']) {
        expect(r.types(), t).toContain(t);
      }
      all.push(...r.samples);
    }
    // 时光机：0 号掷骰（锚点）→ 1 号掷骰（新锚点）→ … → 0 号用时光机回到 1 号掷骰之前
    {
      const sc = eventArena();
      const r = new Recorder(sc);
      r.apply({ type: 'SYS_DEBUG', op: { op: 'stackDeck', deck: 'fate', ids: [20] } });
      stepOnto(r, 11, 10);
      r.drive((s) => s.pending.some((d) => d.seat === 1 && d.kind === 'TURN_MENU'));
      r.act(1, { type: 'ROLL', dice: 1 });
      r.drive((s) => s.pending.some((d) => d.seat === 0 && d.kind === 'TURN_MENU'));
      r.apply({ type: 'SYS_DEBUG', op: { op: 'give', seat: 0, cards: [], items: [{ item: 10, qty: 1 }] } });
      r.act(0, { type: 'USE_ITEM', item: 10, target: { t: 'none' } });
      expect(r.sc.events.map((e) => e.type)).toContain('TIME_REWOUND');
      r.sc.expectAsk(1, 'TURN_MENU');
      all.push(...r.samples);
    }
    // 公布栏：0 号挂牌 L1 → 撤牌 → 再挂 → 1 号在自己的回合买下
    {
      const sc = eventArena();
      const r = new Recorder(sc);
      r.act(0, { type: 'BOARD_LIST', asset: { t: 'lot', lot: 'L1' }, price: 5000 });
      const id1 = r.sc.state.noticeBoard.at(-1)!.id;
      r.act(0, { type: 'BOARD_DELIST', listingId: id1 });
      r.act(0, { type: 'BOARD_LIST', asset: { t: 'lot', lot: 'L1' }, price: 6000 });
      const id2 = r.sc.state.noticeBoard.at(-1)!.id;
      r.apply({ type: 'SYS_DEBUG', op: { op: 'stackDeck', deck: 'fate', ids: [20] } });
      stepOnto(r, 11, 10);
      r.drive((s) => s.pending.some((d) => d.seat === 1 && d.kind === 'TURN_MENU'));
      r.act(1, { type: 'BOARD_BUY', listingId: id2 });
      for (const t of ['LISTING_ADDED', 'LISTING_REMOVED', 'LISTING_SOLD']) expect(r.types(), t).toContain(t);
      expect(r.sc.state.lands.find((l) => l.id === 'L1')?.owner).toBe(1);
      all.push(...r.samples);
    }
    await expectClean(all);
  });
});
