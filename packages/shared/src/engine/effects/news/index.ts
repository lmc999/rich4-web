/**
 * 新闻 36 条（design/engine.md §10.6，以 docs/research/events-from-exe.md §1、§4 为准；数值读 data/tables/news.ts）。
 *
 * 抽牌（squares/news.ts → drawNews）：游标取下一张，不可行就跳过（游标照样前进），最多试 36 次，可行的压 NEWS 帧。
 * NEWS 帧：apply 阶段先抽定随机目标（purpose 'news'，rand % 候选数），公布 NEWS{id, params, affected}（params 用客户端
 * textParams 认识的键：lot / company / stock / seat / amount / reward / fine / gain / loss / days），再结算；
 * 结算可能压子帧（AUCTION、CONFINE、BANKRUPT），子帧完成后本帧出栈。
 * PROGRAM 下新闻不做加持判定；rules.blessingOnNews（MANUAL）时对受影响玩家按表中类别判定（奖金、罚金读财运，劫难读福运）。
 *
 * 各条（与 engine.md 不同处见 data/tables/news.ts 头注释）：
 *   0/2  在押 / 住院玩家全部获释（计数改为 0x80，下一个自己的回合开头释放、走回棋盘）
 *   1/3  在押 / 住院者 (计数 + 3) & 0x7f；PROGRAM 不理赔（exe 处理函数不调保险），MANUAL（blessingOnNews）下投保者按天数理赔
 *   4    外星人：随机一处有建筑的地产为中心、半宽 100：地产清为无主，窗内的人住院 3 天、毁车，恶人送医院（不记敌意）
 *   5    怪兽：随机一处有建筑的地产清为无主；15 瓦斯气爆：随机一栋有建筑的住宅拆一级
 *   6/14 随机一处地产：住宅同名路段每块地价 × 1.3 / × 0.7（trunc，存回 16 位）；设施只改这一处
 *   7    随机一处无主地产公开拍卖（无卖方，成交款进公库）
 *   8/9/10 地产最多（并列取座位最小）/ 地产最少（全体在场玩家，含 0 块）/ 持股最多者得 10000 / 5000 / 10000 × PI
 *   11/12/13 所得税 trunc(现金 × 0.05)（不乘 PI）/ 地价税 trunc(Σ(地价 + 等级 × 房价) × 0.05) × PI（含设施）/
 *           证交税 trunc(Σ持股市值 × 0.05) × PI → 公库；公布后转入 tax 阶段按座位逐人收，付不起的当场破产
 *           （等他的 BANKRUPT 帧跑完、没有终局，再收下一人）
 *   16/17 步行者 / 乘车者停留 1 次
 *   18   地震：随机一处地产：住宅同名路段每块拆一级（连锁店清为空地），设施只这一处；19 山洪：清为无主；
 *   20   台风：随机地产为中心、半宽 100：地产拆一级，不伤人；21 龙卷风：随机一处拆一级
 *   22   银行挤兑 15 天；23 无贷款者得 trunc(存款 × 0.1) 进存款
 *   24/25 12 支股票全部跌停 / 涨停 1 天（立即按开盘价重算）；26 全面停市 10 天（实际关 11 天）
 *   27   随机一支（rand % 股票数，可能抽到已停牌的）停牌 rules.stockSuspendDays 天；28 随机一支停牌股复牌
 *   29   随机一家有董事长的公司，董事长走免罪 → 嫁祸 → 坐牢 5 天（没有加持）
 *   30/33/34 随机一家公司罚款 10000 / 10000 / 5000（不乘 PI，本月与累计盈余同减），跌 3 天
 *   31/32 随机一家公司盈余 +20000 涨 3 天 / −20000 跌 4 天
 *   35   随机一家本月盈余 > 10000 的公司：盈余 × 2（累计盈余 + 2 × 原盈余），涨 trunc(原盈余 / 10000) & 0xF 天
 */
import type { World } from '../../../data/maps/types';
import { ECON } from '../../../data/tables/economy';
import { NEWS_IDS, type NewsId } from '../../../data/tables/ids';
import { decodeTrend, type NewsDef, newsDef, newsParam } from '../../../data/tables/news';
import { add32, mul32, toU16 } from '../../../util/int32';
import type { Ctx } from '../../core/ctx';
import type { FrameHandler } from '../../core/frameHandler';
import type { EngineMap } from '../../core/mapCache';
import { lotWorld } from '../../decisions/targets';
import { EngineInvariantError } from '../../errors';
import { pushAuction } from '../../flow/auction';
import { payInsurance, pushConfine } from '../../flow/confine';
import { evalBlessing, luckFor } from '../../rules/blessing';
import { addCounterDays, COUNTER_PENDING, mainBlockOf } from '../../rules/counters';
import { movePrice } from '../../rules/stock';
import type { BlessingResult, EventParams } from '../../types/events';
import type { FrameOf } from '../../types/frames';
import type { CompanyLotId, LotId, SeatIndex } from '../../types/ids';
import type { GameState, PlayerState } from '../../types/state';
import { mutateLot, timesPI } from '../common';
import { strike } from '../items/weapons';

type NewsFrame = FrameOf<'NEWS'>;

// ───────────────────────── 地产与公司的候选 ─────────────────────────

/** 全部住宅在前、设施在后（rand % (住宅数 + 设施数) 的顺序） */
function allLots(em: EngineMap): LotId[] {
  return [...em.lands.map((l) => l.id), ...em.facilities.map((f) => f.id)];
}

function lotLevel(s: GameState, em: EngineMap, lot: LotId): number {
  if (lot.startsWith('L')) return s.lands[em.landIdx(lot)]?.level ?? 0;
  return s.facilities[em.facilityIdx(lot)]?.level ?? 0;
}

function lotOwner(s: GameState, em: EngineMap, lot: LotId): SeatIndex | null {
  if (lot.startsWith('L')) return s.lands[em.landIdx(lot)]?.owner ?? null;
  return s.facilities[em.facilityIdx(lot)]?.owner ?? null;
}

function builtLots(s: GameState, em: EngineMap): LotId[] {
  return allLots(em).filter((l) => lotLevel(s, em, l) > 0);
}

function builtLands(s: GameState, em: EngineMap): LotId[] {
  return em.lands.filter((_, i) => (s.lands[i]?.level ?? 0) > 0).map((l) => l.id);
}

function ownerlessLots(s: GameState, em: EngineMap): LotId[] {
  return allLots(em).filter((l) => lotOwner(s, em, l) === null);
}

/** 有董事长的公司（按地图顺序） */
function companiesWithChairman(s: GameState): { company: CompanyLotId; chairman: SeatIndex }[] {
  const out: { company: CompanyLotId; chairman: SeatIndex }[] = [];
  for (const c of s.companies) {
    const ch = s.stocks[c.stock]?.chairman ?? null;
    if (ch !== null) out.push({ company: c.id, chairman: ch });
  }
  return out;
}

function lotCount(s: GameState, seat: SeatIndex): number {
  let n = 0;
  for (const l of s.lands) if (l.owner === seat) n++;
  for (const f of s.facilities) if (f.owner === seat) n++;
  return n;
}

function sharesOf(p: PlayerState): number {
  let n = 0;
  for (const h of p.holdings) n += h.shares;
  return n;
}

function alive(s: GameState): PlayerState[] {
  return s.players.filter((p) => p.alive);
}

// ───────────────────────── 可行性与抽牌 ─────────────────────────

export function newsFeasible(s: GameState, em: EngineMap, id: NewsId): boolean {
  const def = newsDef(id);
  switch (def.feasible) {
    case 'always':
      return true;
    case 'jailed':
      return alive(s).some((p) => p.st.jail !== 0);
    case 'hospitalized':
      return alive(s).some((p) => p.st.hospital !== 0);
    case 'builtLot':
      return builtLots(s, em).length > 0;
    case 'builtLand':
      return builtLands(s, em).length > 0;
    case 'ownerlessLot':
      return ownerlessLots(s, em).length > 0;
    case 'anyOwner':
      return alive(s).some((p) => lotCount(s, p.seat) > 0);
    case 'anyHolding':
      return alive(s).some((p) => sharesOf(p) > 0);
    case 'walker':
      return alive(s).some((p) => p.vehicle === 'walk');
    case 'rider':
      return alive(s).some((p) => p.vehicle !== 'walk');
    case 'suspended':
      return s.stocks.some((st) => st.suspend > 0);
    case 'chairmanFree':
      return companiesWithChairman(s).some(({ chairman }) => {
        const p = s.players.find((x) => x.seat === chairman);
        return p?.alive === true && mainBlockOf(p.st) === null;
      });
    case 'profitable': {
      const th = newsParam(id, 'threshold');
      return s.companies.some((c) => c.surplusMonth > th);
    }
  }
}

/** 新闻格：游标取下一张，不可行就跳过（游标照样前进），最多 36 次；可行的压 NEWS 帧 */
export function drawNews(ctx: Ctx): void {
  const sec = ctx.s.secret;
  for (let i = 0; i < NEWS_IDS.length; i++) {
    const id = sec.newsOrder[sec.newsCursor % sec.newsOrder.length]!;
    sec.newsCursor = (sec.newsCursor + 1) % sec.newsOrder.length;
    if (!newsFeasible(ctx.s, ctx.map, id)) continue;
    ctx.push({ k: 'NEWS', id, stage: 'apply', data: {} });
    return;
  }
}

// ───────────────────────── 共用 ─────────────────────────

function announce(ctx: Ctx, id: NewsId, params: EventParams, affected: readonly SeatIndex[]): void {
  ctx.emit('NEWS', { id, params, affected: affected.slice() });
}

/** MANUAL（blessingOnNews）下对 seat 的加持判定；PROGRAM 或没有类别时为 none */
function bless(ctx: Ctx, def: NewsDef, seat: SeatIndex): BlessingResult {
  if (!ctx.s.config.rules.blessingOnNews || def.blessing === null) return 'none';
  const p = ctx.player(seat);
  const r = evalBlessing(luckFor(p, def.blessing), () => ctx.rand15('bless') & 1);
  if (r !== 'none') ctx.emit('BLESSING', { seat, category: def.blessing, result: r });
  return r;
}

/** 按趋势写利多 / 利空天数，并立即按开盘价 ±10% 重算（停牌中的只写天数） */
function setTrend(ctx: Ctx, idx: number, up: number, down: number): void {
  const st = ctx.s.stocks[idx];
  if (!st) return;
  st.up = up;
  st.down = down;
  if (st.suspend > 0 || (up === 0 && down === 0)) return;
  st.priceCents = movePrice(st.openCents, up > 0 ? ECON.STOCK_LIMIT_PCT : -ECON.STOCK_LIMIT_PCT);
  if (st.history.length > 0) st.history[st.history.length - 1] = st.priceCents;
}

/** 地产拆一级 / 清为无主（批量：LOT_MUTATED 逐块） */
function mutateEach(ctx: Ctx, lots: readonly LotId[], mode: 0 | 1, id: NewsId): void {
  const cause = { k: 'news', ref: id, by: null } as const;
  for (const lot of lots) mutateLot(ctx, lot, mode, cause);
}

/** 随机一处（候选按 rand % n），没有候选返回 null */
function pickOne<T>(ctx: Ctx, xs: readonly T[]): T | null {
  if (xs.length === 0) return null;
  return xs[ctx.pick('news', xs.length)]!;
}

/** 住宅：同名路段全部；设施：只这一处 */
function streetOrSelf(em: EngineMap, lot: LotId): LotId[] {
  if (!lot.startsWith('L')) return [lot];
  return em.streetOf(em.landIdx(lot)).map((i) => em.lands[i]!.id);
}

/** 付款进公库（新闻的税）：PROGRAM 不走被动卡；付不起即破产（已压 BANKRUPT 帧，返回 true，调用方须立刻返回） */
function payTax(ctx: Ctx, seat: SeatIndex, amount: number, id: NewsId): boolean {
  if (amount <= 0) return false;
  const from = { t: 'seat', seat } as const;
  const r = ctx.pay(from, { t: 'pool' }, amount, {
    reason: 'tax',
    accident: true,
    cause: { k: 'news', ref: id, by: null },
  });
  ctx.emit('MONEY', { from, to: { t: 'pool' }, amount, paid: r.paid, reason: 'tax', ref: null });
  return r.bankrupt;
}

function reward(ctx: Ctx, seat: SeatIndex, amount: number, where: 'cash' | 'deposit'): void {
  if (amount <= 0) return;
  ctx.mint(seat, amount, where, true);
  ctx.emit('MONEY', {
    from: { t: 'bank' },
    to: { t: 'seat', seat },
    amount,
    paid: amount,
    reason: 'reward',
    ref: null,
  });
}

/** 住宅地价 × factor（trunc，存回 16 位：saturate 夹紧 / wrap 回绕） */
function scalePrice(ctx: Ctx, price: number, factor: number): number {
  return toU16(Math.trunc(price * factor), ctx.s.config.rules.intOverflow);
}

// ───────────────────────── 36 条 ─────────────────────────

type Handler = (ctx: Ctx, def: NewsDef, f: NewsFrame) => void;

const releaseAll: Handler = (ctx, def) => {
  const where = def.scope === 'hospital' ? 'hospital' : 'jail';
  const who: SeatIndex[] = [];
  for (const p of alive(ctx.s)) {
    if (p.st[where] === 0 || p.st[where] === COUNTER_PENDING) continue;
    p.st[where] = COUNTER_PENDING;
    who.push(p.seat);
  }
  announce(ctx, def.id, {}, who);
};

const extendAll: Handler = (ctx, def) => {
  const where = def.scope === 'hospital' ? 'hospital' : 'jail';
  const days = newsParam(def.id, 'days');
  const who = alive(ctx.s)
    .filter((p) => p.st[where] !== 0)
    .map((p) => p.seat);
  const hit: SeatIndex[] = [];
  const added: number[] = [];
  for (const seat of who) {
    // 劫难类（MANUAL 的 blessingOnNews）：high 逃过此劫，low 天数 ×2
    const b = bless(ctx, def, seat);
    if (b === 'high') continue;
    const p = ctx.player(seat);
    const d = b === 'low' ? days * 2 : days;
    p.st[where] = addCounterDays(p.st[where], d);
    hit.push(seat);
    added.push(d);
  }
  announce(ctx, def.id, { days }, hit);
  // exe 的新闻 1/3 只把天数加在计数字节上（抽取结果没有任何 jail / hospital / insurance 调用，events-from-exe §1）：
  // PROGRAM 不理赔；「每次加刑都理赔」是社区说法（r_squares §6.5），只在 MANUAL 的新闻规则组（blessingOnNews）下照赔 ⚑
  if (!ctx.s.config.rules.blessingOnNews) return;
  for (const [i, seat] of hit.entries()) payInsurance(ctx, seat, added[i]!);
};

function strikeNews(ctx: Ctx, def: NewsDef, center: LotId, lotMode: 0 | 1, hospitalDays: number): void {
  const w: World = lotWorld(ctx.map, center);
  const front = ctx.map.index.lot(center).frontTiles[0] ?? 1;
  strike(ctx, {
    kind: def.effect === 'alienAttack' ? 'alien' : 'typhoon',
    center: front,
    half: newsParam(def.id, 'halfWidth'),
    lotMode,
    hospitalDays,
    by: null,
    cause: { k: 'news', ref: def.id, by: null },
    world: w,
  });
}

const alienAttack: Handler = (ctx, def) => {
  const lot = pickOne(ctx, builtLots(ctx.s, ctx.map));
  if (lot === null) return;
  announce(ctx, def.id, { lot }, []);
  strikeNews(ctx, def, lot, 1, newsParam(def.id, 'hospitalDays'));
};

const typhoon: Handler = (ctx, def) => {
  const lot = pickOne(ctx, allLots(ctx.map));
  if (lot === null) return;
  announce(ctx, def.id, { lot }, []);
  strikeNews(ctx, def, lot, 0, 0);
};

/** 5 怪兽（有建筑的地产 → 清为无主）/ 15 瓦斯（有建筑的住宅 → 拆一级）/ 19 山洪（任一 → 清为无主）/ 21 龙卷风（任一 → 拆一级） */
function lotDamage(candidates: (s: GameState, em: EngineMap) => LotId[], mode: 0 | 1): Handler {
  return (ctx, def) => {
    const lot = pickOne(ctx, candidates(ctx.s, ctx.map));
    if (lot === null) return;
    const owner = lotOwner(ctx.s, ctx.map, lot);
    announce(ctx, def.id, { lot }, owner === null ? [] : [owner]);
    mutateEach(ctx, [lot], mode, def.id);
  };
}

const earthquake: Handler = (ctx, def) => {
  const lot = pickOne(ctx, allLots(ctx.map));
  if (lot === null) return;
  const lots = streetOrSelf(ctx.map, lot).filter((l) => lotLevel(ctx.s, ctx.map, l) > 0);
  const owners = new Set<SeatIndex>();
  for (const l of lots) {
    const o = lotOwner(ctx.s, ctx.map, l);
    if (o !== null) owners.add(o);
  }
  announce(
    ctx,
    def.id,
    { lot },
    [...owners].sort((a, b) => a - b),
  );
  mutateEach(ctx, lots, 0, def.id);
};

const streetPrice: Handler = (ctx, def) => {
  const lot = pickOne(ctx, allLots(ctx.map));
  if (lot === null) return;
  const s = ctx.s;
  const factor = newsParam(def.id, 'factor');
  if (lot.startsWith('L')) {
    for (const l of streetOrSelf(ctx.map, lot)) {
      const st = s.lands[ctx.map.landIdx(l)]!;
      st.landPrice = scalePrice(ctx, st.landPrice, factor);
    }
  } else {
    const f = s.facilities[ctx.map.facilityIdx(lot)]!;
    const ff = def.params.factorFacility ?? factor;
    f.landPrice = scalePrice(ctx, f.landPrice, ff);
  }
  announce(ctx, def.id, { lot }, []);
};

const publicAuction: Handler = (ctx, def) => {
  const lot = pickOne(ctx, ownerlessLots(ctx.s, ctx.map));
  if (lot === null) return;
  announce(ctx, def.id, { lot }, []);
  pushAuction(ctx, lot, null, 'news');
};

/** 最多者（严格大于才替换：并列取座位最小）；全为 0 返回 null */
function topBy(ps: readonly PlayerState[], score: (p: PlayerState) => number): SeatIndex | null {
  let best: SeatIndex | null = null;
  let max = 0;
  for (const p of ps) {
    const v = score(p);
    if (v > max) {
      max = v;
      best = p.seat;
    }
  }
  return best;
}

function rewardTo(ctx: Ctx, def: NewsDef, seat: SeatIndex | null, key: 'reward' | 'subsidy'): void {
  if (seat === null) return;
  let amount = timesPI(ctx, newsParam(def.id, key));
  announce(ctx, def.id, { seat, amount }, [seat]);
  const r = bless(ctx, def, seat);
  if (r === 'high') amount = mul32(amount, 2, ctx.s.config.rules.intOverflow);
  else if (r === 'low') amount = 0;
  reward(ctx, seat, amount, 'cash');
}

const rewardTopLandlord: Handler = (ctx, def) => {
  rewardTo(
    ctx,
    def,
    topBy(alive(ctx.s), (p) => lotCount(ctx.s, p.seat)),
    'reward',
  );
};

const subsidyFewest: Handler = (ctx, def) => {
  // 全体在场玩家中取最少（初值 10000，严格小于才替换：并列取座位号最小；含 0 块）
  let best: SeatIndex | null = null;
  let min = 10000;
  for (const p of alive(ctx.s)) {
    const n = lotCount(ctx.s, p.seat);
    if (n < min) {
      min = n;
      best = p.seat;
    }
  }
  rewardTo(ctx, def, best, 'subsidy');
};

const rewardTopShareholder: Handler = (ctx, def) => {
  rewardTo(ctx, def, topBy(alive(ctx.s), sharesOf), 'reward');
};

/** 11/12/13 的税基（每人的税额，≤ 0 不收） */
type TaxBase = (ctx: Ctx, p: PlayerState, rate: number) => number;

const TAX_BASES: Readonly<Record<'incomeTax' | 'landTax' | 'stockTax', TaxBase>> = Object.freeze({
  // 所得税 trunc(现金 × 0.05)，不乘 PI
  incomeTax: (_ctx: Ctx, p: PlayerState, rate: number) => Math.trunc(p.cash * rate),
  // 地价税 trunc(Σ(地价 + 等级 × 房价) × 0.05) × PI（含设施）
  landTax: (ctx: Ctx, p: PlayerState, rate: number) => {
    const s = ctx.s;
    const em = ctx.map;
    let sum = 0;
    s.lands.forEach((l, i) => {
      if (l.owner === p.seat) sum += l.landPrice + l.level * em.lands[i]!.housePrice;
    });
    s.facilities.forEach((f, i) => {
      if (f.owner === p.seat) sum += f.landPrice + f.level * em.facilities[i]!.rateWindow[0];
    });
    return timesPI(ctx, Math.trunc(sum * rate));
  },
  // 证交税 trunc(Σ持股市值 × 0.05) × PI
  stockTax: (ctx: Ctx, p: PlayerState, rate: number) => {
    let value = 0;
    ctx.s.stocks.forEach((st, i) => {
      value += ((p.holdings[i]?.shares ?? 0) * st.priceCents) / 100;
    });
    return timesPI(ctx, Math.trunc(value * rate));
  },
});

function taxBaseOf(def: NewsDef): TaxBase {
  const base = (TAX_BASES as Readonly<Record<string, TaxBase>>)[def.effect];
  if (!base) throw new EngineInvariantError('NEWS_TAX', `news ${def.id} is not a tax`);
  return base;
}

/**
 * 11/12/13：公布（affected = 税额 > 0 的在场玩家）后转入 tax 阶段逐人收。原版 pay_money 付不起时当场破产、
 * 按座位顺序逐人结算（g_villains §5）：这里也是一次收一人，有人破产就先让他的 BANKRUPT 帧跑完（可能直接终局），
 * 再从下一人继续；税额在收的那一刻按当时的状态计算（破产清算的拍卖可能改变后面的人的现金与地产）。
 */
const taxNews: Handler = (ctx, def, f) => {
  const rate = newsParam(def.id, 'rate');
  const base = taxBaseOf(def);
  const seats = alive(ctx.s)
    .filter((p) => base(ctx, p, rate) > 0)
    .map((p) => p.seat);
  announce(ctx, def.id, { pct: Math.trunc(rate * 100) }, seats);
  f.data = { seats, idx: 0 };
  f.stage = 'tax';
};

/** tax 阶段：从游标处逐人收税；有人破产（已压 BANKRUPT 帧）就先返回，BANKRUPT 帧完成后回到这里继续 */
function collectTax(ctx: Ctx, f: NewsFrame): void {
  const def = newsDef(f.id);
  const rate = newsParam(def.id, 'rate');
  const base = taxBaseOf(def);
  const seats = Array.isArray(f.data.seats) ? (f.data.seats as number[]) : [];
  let idx = typeof f.data.idx === 'number' ? f.data.idx : 0;
  while (idx < seats.length) {
    const seat = seats[idx] as SeatIndex;
    idx += 1;
    f.data.idx = idx;
    const p = ctx.player(seat);
    if (!p.alive) continue;
    const b = bless(ctx, def, seat);
    if (b === 'high') continue;
    const owed = base(ctx, p, rate);
    const amount = b === 'low' ? mul32(owed, 2, ctx.s.config.rules.intOverflow) : owed;
    if (payTax(ctx, seat, amount, def.id)) return;
  }
  f.stage = 'done';
}

const stayByVehicle: Handler = (ctx, def) => {
  const who = alive(ctx.s)
    .filter((p) => (def.scope === 'walker' ? p.vehicle === 'walk' : p.vehicle !== 'walk'))
    .map((p) => p.seat);
  const hit: SeatIndex[] = [];
  for (const seat of who) {
    if (bless(ctx, def, seat) === 'high') continue;
    ctx.player(seat).st.stay = 1;
    hit.push(seat);
  }
  announce(ctx, def.id, {}, hit);
};

const bankRun: Handler = (ctx, def) => {
  ctx.s.econ.bankRunDays = newsParam(def.id, 'days');
  announce(ctx, def.id, { days: ctx.s.econ.bankRunDays }, []);
};

const bonusInterest: Handler = (ctx, def) => {
  const rate = newsParam(def.id, 'rate');
  const rows = alive(ctx.s)
    .filter((p) => p.loan === 0 && p.deposit > 0)
    .map((p) => ({ seat: p.seat, amount: Math.trunc(p.deposit * rate) }))
    .filter((r) => r.amount > 0);
  announce(
    ctx,
    def.id,
    {},
    rows.map((r) => r.seat),
  );
  for (const r of rows) {
    const b = bless(ctx, def, r.seat);
    const amount = b === 'high' ? mul32(r.amount, 2, ctx.s.config.rules.intOverflow) : b === 'low' ? 0 : r.amount;
    reward(ctx, r.seat, amount, 'deposit');
  }
};

const marketAll: Handler = (ctx, def) => {
  const { up, down } = decodeTrend(newsParam(def.id, 'trend'));
  for (let i = 0; i < ctx.s.stocks.length; i++) setTrend(ctx, i, up, down);
  announce(ctx, def.id, {}, []);
};

const marketHalt: Handler = (ctx, def) => {
  ctx.s.econ.marketClosedDays = newsParam(def.id, 'days');
  ctx.s.clock.marketOpen = false;
  announce(ctx, def.id, { days: ctx.s.econ.marketClosedDays }, []);
};

const suspend: Handler = (ctx, def) => {
  const s = ctx.s;
  if (s.stocks.length === 0) return;
  // rand % 股票数（exe 写 12，可能抽到已停牌的：覆盖计数）；天数按 rules.stockSuspendDays（PROGRAM 15）
  const idx = ctx.pick('news', s.stocks.length);
  const days = s.config.rules.stockSuspendDays;
  s.stocks[idx]!.suspend = days;
  announce(ctx, def.id, { stock: s.stocks[idx]!.idx, days }, []);
  ctx.emit('SUSPENDED', { stock: s.stocks[idx]!.idx, days });
};

const resume: Handler = (ctx, def) => {
  const s = ctx.s;
  const cands = s.stocks.filter((st) => st.suspend > 0).map((st) => st.idx);
  const stock = pickOne(ctx, cands);
  if (stock === null) return;
  s.stocks.find((st) => st.idx === stock)!.suspend = 0;
  announce(ctx, def.id, { stock }, []);
  ctx.emit('RESUMED', { stock });
};

const overLoanJail: Handler = (ctx, def) => {
  // 在全部有董事长的公司中抽（抽到受困的董事长也照样坐牢；exe 与可行条件不同，events-from-exe §4）
  const pick = pickOne(ctx, companiesWithChairman(ctx.s));
  if (pick === null) return;
  const days = newsParam(def.id, 'days');
  announce(ctx, def.id, { company: pick.company, seat: pick.chairman, days }, [pick.chairman]);
  if (!ctx.player(pick.chairman).alive) return;
  pushConfine(
    ctx,
    { t: 'seat', seat: pick.chairman },
    {
      where: 'jail',
      days,
      cause: { k: 'news', ref: def.id, by: null },
      passive: true,
      blessing: ctx.s.config.rules.blessingOnNews,
    },
  );
};

/** 30/33/34 罚款、31/32 海外投资：随机任一公司（rand % 公司数，不要求有董事长） */
const companyMoney: Handler = (ctx, def) => {
  const s = ctx.s;
  const c = pickOne(ctx, s.companies);
  if (c === null) return;
  const { up, down } = decodeTrend(newsParam(def.id, 'trend'));
  const company = { t: 'company', company: c.id } as const;
  const cause = { k: 'news', ref: def.id, by: null } as const;
  const gain = def.params.gain ?? 0;
  const loss = def.params.fine ?? def.params.loss ?? 0;
  if (gain > 0) ctx.pay({ t: 'bank' }, company, gain, { reason: 'reward', cause });
  if (loss > 0) ctx.pay(company, { t: 'bank' }, loss, { reason: 'fine', cause });
  setTrend(ctx, c.stock, up, down);
  const params: EventParams = { company: c.id, stock: s.stocks[c.stock]?.idx ?? c.stock };
  if (def.params.fine !== undefined) params.fine = def.params.fine;
  if (def.params.gain !== undefined) params.gain = def.params.gain;
  if (def.params.loss !== undefined) params.loss = def.params.loss;
  announce(ctx, def.id, params, []);
};

const doubleProfit: Handler = (ctx, def) => {
  const s = ctx.s;
  const th = newsParam(def.id, 'threshold');
  const div = newsParam(def.id, 'divisor');
  const c = pickOne(
    ctx,
    s.companies.filter((x) => x.surplusMonth > th),
  );
  if (c === null) return;
  const surplus = c.surplusMonth;
  const mode = s.config.rules.intOverflow;
  // 本月盈余 × 2（铸造同额进公司），累计盈余 + 2 × 原盈余（transfer 已加 1 倍，再补 1 倍）
  ctx.pay({ t: 'bank' }, { t: 'company', company: c.id }, surplus, {
    reason: 'reward',
    cause: { k: 'news', ref: def.id, by: null },
  });
  c.surplusTotal = add32(c.surplusTotal, surplus, mode);
  const up = Math.trunc(surplus / div) & 0xf;
  setTrend(ctx, c.stock, up, 0);
  announce(ctx, def.id, { company: c.id, stock: s.stocks[c.stock]?.idx ?? c.stock, gain: surplus, days: up }, []);
};

const HANDLERS = Object.freeze({
  releaseAll,
  extendAll,
  alienAttack,
  monster: lotDamage(builtLots, 1),
  streetPrice,
  publicAuction,
  rewardTopLandlord,
  subsidyFewest,
  rewardTopShareholder,
  incomeTax: taxNews,
  landTax: taxNews,
  stockTax: taxNews,
  gasExplosion: lotDamage(builtLands, 0),
  stayByVehicle,
  earthquake,
  flood: lotDamage((_s, em) => allLots(em), 1),
  typhoon,
  tornado: lotDamage((_s, em) => allLots(em), 0),
  bankRun,
  bonusInterest,
  marketAll,
  marketHalt,
  suspend,
  resume,
  overLoanJail,
  companyFine: companyMoney,
  overseas: companyMoney,
  doubleProfit,
} satisfies { readonly [E in NewsDef['effect']]: Handler });

export const NEWS: FrameHandler<NewsFrame> = {
  step(ctx, f) {
    switch (f.stage) {
      case 'done':
        ctx.pop(f);
        return;
      case 'tax':
        collectTax(ctx, f);
        return;
      default: {
        // apply：处理函数可能把阶段改成 tax（11/12/13），其余直接 done（压出的子帧完成后本帧出栈）
        f.stage = 'done';
        const def = newsDef(f.id);
        HANDLERS[def.effect](ctx, def, f);
      }
    }
  },
};

/** 测试与调试用：直接压一条新闻（不经牌堆） */
export function pushNews(ctx: Ctx, id: NewsId): void {
  ctx.push({ k: 'NEWS', id, stage: 'apply', data: {} });
}
