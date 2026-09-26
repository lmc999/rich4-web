/**
 * DAY 帧：日推进（design/engine.md §7.9；docs/research/r_rules_map.md §7；g_arbitration.md §3.1；r_stocks_time.md §1.2）。
 * date → victory → pi → market → holiday → d15 → month → lots → end，每个阶段先推进游标再执行，
 * 所以可以被分红破产、拍卖等打断后从下一阶段继续（d15 用 cursor 区分「分红」与「开奖」两步）。
 *
 * market   全面停市 / 挤兑天数 −1（从 1 到 0 的这一天仍然休市）；各股停牌、利多、利空 −1（星期日也倒数）；
 *          开市 = 非星期日、非休市节日、当天开始时没有全面停市 → 行情（MARKET_TICK），否则 MARKET_CLOSED
 * holiday  节日 → HOLIDAY；送卡的节日（圣诞）每位在场玩家从牌堆加权抽 1 张（满手自动弃最便宜）
 * d15      15 日：分红（exe 0x42ba97）：存活持股合计 T>0 的公司，每人 trunc(本月盈余 × f32(持股 / T))，按座位先合计，
 *          合计为正进存款、为负先存款后现金扣、扣不出来才破产（净额结算）；T>0 的公司本月盈余清零，余数不再分配
 *          → 乐透开奖
 * lots     标记倒数；地契到期：地主清空、等级保留、研究所的研发作废（RESEARCH_CANCELLED 发给原业主）
 * month    1 日：月结（无贷款者存款 ×1.1、本期冠军、悲情人物、清零月度累计）→ MONTHLY_REPORT；
 *          TODO(M6)：礼物、宝箱收回后重新随机摆放（OBJECTS_RESPAWNED）
 */

import type { HolidayDef } from '../../data/maps/types';
import { ECON } from '../../data/tables/economy';
import { add32, mul32 } from '../../util/int32';
import type { Ctx } from '../core/ctx';
import type { FrameHandler } from '../core/frameHandler';
import { monthlyInterest } from '../rules/bank';
import { holidayKey, holidayOn, isMarketClosedDay, nextDate, unpackDate, weekdayOf } from '../rules/calendar';
import { drawFromDeck, makeRoomForCard } from '../rules/inventory';
import { releaseLot } from '../rules/landMutation';
import { holdersOf, tickMarket } from '../rules/stock';
import { checkDayEnd, richestAlive } from '../rules/victory';
import { netWorth, nextPriceIndex } from '../rules/wealth';
import type { FrameOf } from '../types/frames';
import type { CompanyLotId, FacilityLotId, LotId, ResearchProject, SeatIndex } from '../types/ids';
import type { GameState } from '../types/state';

type DayFrame = FrameOf<'DAY'>;

/** 按日期重算 weekday / marketOpen / holiday（开局、日推进、调试改日期共用） */
export function applyCalendar(s: GameState, holidays: readonly HolidayDef[]): void {
  const c = s.clock;
  c.weekday = weekdayOf(c.date);
  const h = holidayOn(c.date, holidays);
  c.holiday = h ? holidayKey(h) : null;
  c.marketOpen = !isMarketClosedDay(c.date, c.weekday, holidays) && s.econ.marketClosedDays === 0;
}

/** 'market' 阶段：倒数 → 判定今日开市 → 行情 */
function marketStage(ctx: Ctx): void {
  const s = ctx.s;
  const halted = s.econ.marketClosedDays > 0;
  if (halted) s.econ.marketClosedDays -= 1;
  if (s.econ.bankRunDays > 0) s.econ.bankRunDays -= 1;
  const resumed: number[] = [];
  s.stocks.forEach((st, i) => {
    if (st.suspend > 0) {
      st.suspend -= 1;
      if (st.suspend === 0) resumed.push(i);
    }
    if (st.up > 0) st.up -= 1;
    if (st.down > 0) st.down -= 1;
  });
  const holidays = ctx.map.def.holidays;
  const closedDay = isMarketClosedDay(s.clock.date, s.clock.weekday, holidays);
  s.clock.marketOpen = !closedDay && !halted;
  for (const stock of resumed) ctx.emit('RESUMED', { stock });
  if (!s.clock.marketOpen) {
    ctx.emit('MARKET_CLOSED', { reason: halted ? 'halted' : s.clock.weekday === 0 ? 'sunday' : 'holiday' });
    return;
  }
  tickMarket(s, ctx.map, () => ctx.rand15('market'));
  ctx.emit('MARKET_TICK', { date: s.clock.date });
}

/** 'holiday' 阶段：节日公告；送卡的节日每位在场玩家从牌堆抽 1 张 */
function holidayStage(ctx: Ctx): void {
  const s = ctx.s;
  const h = holidayOn(s.clock.date, ctx.map.def.holidays);
  if (h === null) return;
  const giveCard = h.giveCard === true;
  ctx.emit('HOLIDAY', { key: holidayKey(h), giveCard });
  if (!giveCard) return;
  for (const p of s.players) {
    if (!p.alive) continue;
    const card = drawFromDeck(s);
    if (card === null) return;
    const discarded = makeRoomForCard(s, p.seat);
    if (discarded !== null) ctx.emit('CARD_LOST', { seat: p.seat, card: discarded, cause: 'discard' });
    p.cards.push(card);
    ctx.emit('CARD_GAINED', { seat: p.seat, card, source: 'holiday' });
  }
}

/**
 * 一家公司按持股应分的金额（exe 0x42bc45-0x42bc9f）：比例 = 持股 / T 先存成 float32，再 trunc(本月盈余 × 比例)。
 * float32 比例偏小时比精确值少 1（例如 0.7f = 0.69999999…：盈余 10000、持股 700/1000 得 6999）。
 * JS 的 double 乘法与 x87 53 位精度（Win32 默认控制字）逐位一致；64 位精度下只在乘积距整数 < 2^-22 时可能差 1。
 */
export function dividendShare(surplus: number, shares: number, total: number): number {
  return Math.trunc(surplus * Math.fround(shares / total));
}

/**
 * 15 日分红（exe 0x42ba97）：先对全部公司按在场股东算应分金额、按座位累加（T>0 的公司本月盈余清零），
 * 再逐座位一次入账：合计 > 0 进存款；< 0 先存款后现金扣，扣不出来才破产（按座位顺序压 BANKRUPT 帧）。
 * rows 按公司、座位逐条列出供演出；整次分红只发一个 DIVIDENDS（资金变化在它的 post 里）。
 */
function payDividends(ctx: Ctx): void {
  const s = ctx.s;
  const mode = s.config.rules.intOverflow;
  const rows: { company: CompanyLotId; seat: SeatIndex; amount: number }[] = [];
  const perSeat = new Map<SeatIndex, number>();
  /** 每个座位第一笔负分红的公司（破产原因） */
  const firstLoss = new Map<SeatIndex, CompanyLotId>();
  for (const c of s.companies) {
    const holders = holdersOf(s, c.stock);
    const total = holders.reduce((a, h) => a + h.shares, 0);
    const surplus = c.surplusMonth;
    if (total <= 0) continue;
    if (surplus !== 0) {
      for (const h of holders) {
        const amount = dividendShare(surplus, h.shares, total);
        perSeat.set(h.seat, add32(perSeat.get(h.seat) ?? 0, amount, mode));
        if (amount < 0 && !firstLoss.has(h.seat)) firstLoss.set(h.seat, c.id);
        rows.push({ company: c.id, seat: h.seat, amount });
      }
    }
    // 本月盈余清零：正盈余视为销毁、负盈余视为铸造（玩家一侧按实际收付铸造 / 销毁）
    if (surplus > 0) s.econ.ledger.burned += surplus;
    else if (surplus < 0) s.econ.ledger.minted += -surplus;
    c.surplusMonth = 0;
  }
  if (rows.length === 0) return;
  // 座位倒序入账：BANKRUPT 帧后压的先处理，破产按座位顺序展开（原版按座位顺序当场破产）
  const seats = [...perSeat.keys()].sort((a, b) => b - a);
  for (const seat of seats) {
    const sum = perSeat.get(seat)!;
    if (sum > 0) ctx.mint(seat, sum, 'deposit');
    else if (sum < 0) {
      ctx.pay({ t: 'seat', seat }, { t: 'bank' }, -sum, {
        order: 'depositFirst',
        reason: 'dividend',
        cause: { k: 'dividend', ref: firstLoss.get(seat) ?? null, by: null },
      });
    }
  }
  ctx.emit('DIVIDENDS', { rows });
}

/** 乐透开奖：无人购票不开；有人持号 > 10 个只在已售号码里开，否则在 36 个里开 */
function drawLottery(ctx: Ctx): void {
  const s = ctx.s;
  const owners = s.lottery.owners;
  const sold: number[] = [];
  const perSeat = [0, 0, 0, 0];
  owners.forEach((o, i) => {
    if (o === null) return;
    sold.push(i);
    perSeat[o] = (perSeat[o] ?? 0) + 1;
  });
  if (sold.length === 0) return;
  const soldOnly = perSeat.some((n) => n > ECON.LOTTERY_SOLD_ONLY_THRESHOLD);
  const number = soldOnly ? sold[ctx.pick('lottery', sold.length)]! : ctx.pick('lottery', owners.length);
  const winner = owners[number] ?? null;
  if (winner === null) {
    ctx.emit('LOTTERY_DRAW', { number, winner: null, prize: 0 });
    return;
  }
  const prize = s.econ.pool;
  if (prize !== 0)
    ctx.pay({ t: 'pool' }, { t: 'seat', seat: winner }, prize, {
      reason: 'lotteryPrize',
      cause: { k: 'system', ref: 'lottery', by: null },
    });
  s.lottery.owners = owners.map(() => null);
  ctx.emit('LOTTERY_DRAW', { number, winner, prize });
}

/** 月结：利息 → 冠军与悲情人物 → 清零月度累计 → MONTHLY_REPORT */
function monthStage(ctx: Ctx): void {
  const s = ctx.s;
  const mode = s.config.rules.intOverflow;
  const pi = s.econ.priceIndex;
  for (const p of s.players) {
    if (!p.alive) continue;
    const interest = monthlyInterest(p);
    if (interest > 0) ctx.mint(p.seat, interest, 'deposit');
    p.monthly.interest = interest;
  }
  const alive = s.players.filter((p) => p.alive);
  const rows = alive.map((p) => ({
    seat: p.seat,
    netWorth: netWorth(s, ctx.map, p.seat),
    loss: p.monthly.loss,
    gain: p.monthly.gain,
    interest: p.monthly.interest,
  }));
  const champion = richestAlive(s, ctx.map)?.seat ?? null;
  let best: { seat: SeatIndex; score: number } | null = null;
  let second: number | null = null;
  for (const p of alive) {
    const score =
      p.monthly.loss -
      p.monthly.gain +
      mul32(mul32(p.monthly.badDays, pi, mode), ECON.TRAGIC_DAY_FACTOR, mode) +
      p.luck.bad * ECON.TRAGIC_BAD_LUCK;
    if (best === null || score > best.score) {
      if (best !== null) second = best.score;
      best = { seat: p.seat, score };
    } else if (second === null || score > second) second = score;
  }
  const tragic =
    best !== null && best.score > 0 && (second === null || best.score * 10 > second * ECON.TRAGIC_RATIO_X10)
      ? best.seat
      : null;
  for (const p of s.players) p.monthly = { loss: 0, gain: 0, badDays: 0, interest: 0 };
  ctx.emit('MONTHLY_REPORT', { rows, champion, tragic });
}

export const DAY: FrameHandler<DayFrame> = {
  step(ctx, f) {
    const s = ctx.s;
    switch (f.stage) {
      case 'date': {
        f.stage = 'victory';
        s.clock.date = nextDate(s.clock.date);
        s.clock.elapsedDays += 1;
        applyCalendar(s, ctx.map.def.holidays);
        ctx.emit('DAY_ADVANCED', { date: s.clock.date, weekday: s.clock.weekday, elapsed: s.clock.elapsedDays });
        return;
      }
      case 'victory': {
        f.stage = 'pi';
        const end = checkDayEnd(s, ctx.map);
        if (end) ctx.endGame(end);
        return;
      }
      case 'pi': {
        f.stage = 'market';
        const from = s.econ.priceIndex;
        const to = nextPriceIndex(s, ctx.map);
        if (to !== from) {
          s.econ.priceIndex = to;
          ctx.emit('PRICE_INDEX', { from, to });
        }
        return;
      }
      case 'market':
        f.stage = 'holiday';
        marketStage(ctx);
        return;
      case 'holiday':
        f.stage = 'd15';
        f.cursor = 0;
        holidayStage(ctx);
        return;
      case 'd15': {
        if (unpackDate(s.clock.date).d !== ECON.DIVIDEND_DAY) {
          f.stage = 'month';
          return;
        }
        // cursor 0：分红（可能压 BANKRUPT 帧，处理完再回来）；之后开奖
        if (f.cursor === 0) {
          f.cursor = 1;
          payDividends(ctx);
          return;
        }
        f.stage = 'month';
        drawLottery(ctx);
        return;
      }
      case 'month':
        f.stage = 'lots';
        if (unpackDate(s.clock.date).d === 1) monthStage(ctx);
        // TODO(M6)：礼物、宝箱收回后重新随机摆放（OBJECTS_RESPAWNED）
        return;
      case 'lots': {
        f.stage = 'end';
        const expired: Record<'raise' | 'seal', LotId[]> = { raise: [], seal: [] };
        for (const l of [...s.lands, ...s.facilities]) {
          if (!l.mark) continue;
          l.mark.days -= 1;
          if (l.mark.days <= 0) {
            expired[l.mark.kind].push(l.id);
            l.mark = null;
          }
        }
        for (const kind of ['raise', 'seal'] as const) {
          if (expired[kind].length > 0) ctx.emit('MARK_EXPIRED', { lots: expired[kind], kind });
        }
        // 地契到期（日期相等才算；1/31 + 1 个月 = 2/31 永不到期）：地主清空、等级保留，研究所进行中的研发作废
        const tenure: LotId[] = [];
        const cancelled: { seat: SeatIndex; lot: FacilityLotId; project: ResearchProject }[] = [];
        for (const l of [...s.lands, ...s.facilities]) {
          if (l.owner === null || l.tenure === 0 || l.tenure !== s.clock.date) continue;
          const seat = l.owner;
          const r = releaseLot(l);
          if (r !== null) cancelled.push({ seat, lot: l.id as FacilityLotId, project: r.project });
          tenure.push(l.id);
        }
        if (tenure.length > 0) ctx.emit('TENURE_EXPIRED', { lots: tenure });
        for (const c of cancelled) ctx.emit('RESEARCH_CANCELLED', c);
        return;
      }
      case 'end':
        ctx.emit('DAY_END', { date: s.clock.date, elapsed: s.clock.elapsedDays });
        ctx.pop(f);
        return;
    }
  },
};
