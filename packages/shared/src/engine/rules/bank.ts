/**
 * 银行（design/engine.md §11.3；docs/research/r_stocks_time.md §3；g_arbitration.md §2.f）。
 *
 * - ATM：存、取各一笔（每次决策一笔），无手续费；挤兑（新闻 22，econ.bankRunDays>0）期间只能存。
 * - 柜台（只有停下才能办，三选一，每次一笔）：
 *   贷款：额度 = 总资产 − 现有贷款（总资产已扣贷款）；借款进存款（铸造）；第一次借款时到期日 = 90 天后，
 *         落在休市日（星期日或休市节日）顺延到下一个开市日；追加借款不延期；无利息；挤兑期间不放款。
 *   还款：先扣存款再扣现金（销毁），可部分还；还清后到期日清零。
 *   特别融资：只有银行（行业 7）董事长能办，额度 = 其他在场玩家存款合计 − 已融资额；进存款并累加 finance，无期限。
 * - 储备金缺口：别人取款后，其他在场玩家存款合计 < 董事长的融资余额时，差额由董事长按银行口径（先存款后现金）垫付，
 *   融资余额相应减少；垫付不起即破产。董事长易主时不强制归还（oama）。
 * - 星期日照常营业（PROGRAM）；sundayBankClosed（MANUAL）时 ATM 与柜台都只弹提示。
 * - 到期检查在本人回合开始：剩 3/2/1 天提醒；≤0 天按银行口径强制归还全部贷款，扣不出来就破产。
 */
import { ECON } from '../../data/tables/economy';
import { INDUSTRY } from '../../data/tables/facilities';
import { sub32 } from '../../util/int32';
import type { EngineMap } from '../core/mapCache';
import type { DateNum, SeatIndex } from '../types/ids';
import { loanDueDate } from './calendar';
import { netWorth } from './wealth';
import { modeOf, playerOf, type RuleWorld } from './world';

/** 地图上第一家某行业公司的下标；没有返回 -1 */
export function firstCompanyOfIndustry(em: EngineMap, industry: number): number {
  return em.companies.findIndex((c) => c.industry === industry);
}

/** 银行董事长（地图上第一家行业 7 公司的股票董事长）；没有银行公司或没人持股为 null */
export function bankChairman(w: Pick<RuleWorld, 'companies' | 'stocks'>, em: EngineMap): SeatIndex | null {
  const i = firstCompanyOfIndustry(em, INDUSTRY.BANK);
  if (i < 0) return null;
  const c = w.companies[i];
  return c ? (w.stocks[c.stock]?.chairman ?? null) : null;
}

/** seat 以外在场玩家的存款合计（负存款按 0 计） */
export function othersDeposit(w: Pick<RuleWorld, 'players'>, seat: SeatIndex): number {
  let n = 0;
  for (const p of w.players) if (p.alive && p.seat !== seat && p.deposit > 0) n += p.deposit;
  return n;
}

/** 贷款额度 = 总资产（已扣贷款）− 现有贷款，最少 0 */
export function loanLimitOf(w: RuleWorld, em: EngineMap, seat: SeatIndex): number {
  const p = playerOf(w.players, seat);
  const v = sub32(netWorth(w, em, seat), p.loan, modeOf(w));
  return v > 0 ? v : 0;
}

/** 特别融资额度：只有银行董事长有，= 其他在场玩家存款合计 − 已融资额（最少 0）；否则 null */
export function financeLimitOf(w: RuleWorld, em: EngineMap, seat: SeatIndex): number | null {
  if (bankChairman(w, em) !== seat) return null;
  const p = playerOf(w.players, seat);
  const v = othersDeposit(w, seat) - p.finance;
  return v > 0 ? v : 0;
}

/**
 * 取款后的储备金缺口：银行董事长（≠ 取款人）有融资余额且其他在场玩家存款合计低于它时，返回 {chairman, amount}
 */
export function reserveShortfall(
  w: RuleWorld,
  em: EngineMap,
  withdrawer: SeatIndex,
): { chairman: SeatIndex; amount: number } | null {
  const c = bankChairman(w, em);
  if (c === null || c === withdrawer) return null;
  const p = playerOf(w.players, c);
  if (!p.alive || p.finance <= 0) return null;
  const gap = p.finance - othersDeposit(w, c);
  return gap > 0 ? { chairman: c, amount: gap } : null;
}

/** 首次借款的到期日（90 天后，遇休市顺延） */
export function newLoanDue(w: Pick<RuleWorld, 'clock'>, em: EngineMap): DateNum {
  return loanDueDate(w.clock.date, ECON.LOAN_DAYS, em.def.holidays);
}

/** 首家保险公司（行业 4）的下标：理赔从它的盈余支付；没有返回 -1 */
export function insuranceCompanyIdx(em: EngineMap): number {
  return firstCompanyOfIndustry(em, INDUSTRY.INSURANCE);
}

/** 月息：无贷款且存款 > 0 → trunc(存款 / 10) */
export function monthlyInterest(p: { loan: number; deposit: number }): number {
  if (p.loan !== 0 || p.deposit <= 0) return 0;
  return Math.trunc(p.deposit / ECON.INTEREST_DIV);
}
