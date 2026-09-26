/**
 * 资金原语（design/engine.md §11.2；docs/research/r_rules_map.md §8）。任何资金变动都必须经过这里，
 * 以保证台账不变量：Σ(cash + deposit) + 公库 + Σ公司本月盈余 == 初始总额 + minted − burned。
 *
 * - 玩家付款（transfer）：按 order 先扣一个口袋再扣另一个（默认先现金后存款）；两者都不够时 paid = 他剩下的全部，
 *   bankrupt=true，由调用方压 BANKRUPT 帧。不动用贷款额度、不自动变卖。
 * - 公司付款可以为负，不破产；'bank' 表示铸造 / 销毁，计入 ledger。
 * - 只能用现金的消费（买地、盖房……）走 spendCash：价格 > 现金就失败，不破产，钱 burn。
 * - accident=true 时累计付款方 monthly.loss 与收款玩家 monthly.gain（月结「意外损失 / 意外之财」）。
 * - int32 溢出（saturate 夹紧或 wrap 回绕）造成的差额记入 ledger，使台账恒等式始终精确成立。
 * - 负数金额只会出现在 intOverflow='wrap'（报价回绕）：按 C 语义照常「扣款」，钱反向流动（付款方第一个口袋增加、
 *   收款方减少），「余额 < 金额」才破产，所以资产非负时不会破产；spendCash 同理（cash ≥ 价格即成功，现金反增）。
 *   saturate 下负数金额不可能出现，出现即内部缺陷（EngineInvariantError）。⚑ 原版对负金额的处理无指令级证据（DEV-01）。
 */
import { add32, type OverflowMode, toInt32 } from '../../util/int32';
import { EngineInvariantError } from '../errors';
import type { Party, SeatIndex } from '../types/ids';
import type { GameState, PlayerState } from '../types/state';

export interface TransferOptions {
  /** 付款方口袋的扣款顺序（玩家付款默认 cashFirst；银行口径 depositFirst） */
  order?: 'cashFirst' | 'depositFirst';
  /** 收款玩家入账到现金还是存款（默认现金） */
  credit?: 'cash' | 'deposit';
  accident?: boolean;
}

export interface TransferResult {
  paid: number;
  bankrupt: boolean;
}

function modeOfState(s: GameState): OverflowMode {
  return s.config.rules.intOverflow;
}

/** 把 delta 加到一个 int32 存量上；溢出差额记入 ledger（正差额视为销毁，负差额视为铸造） */
export function addMoney(s: GameState, current: number, delta: number): number {
  const exact = current + delta;
  const stored = toInt32(exact, modeOfState(s));
  const lost = exact - stored;
  if (lost > 0) s.econ.ledger.burned += lost;
  else if (lost < 0) s.econ.ledger.minted += -lost;
  return stored;
}

export function playerAt(s: GameState, seat: SeatIndex): PlayerState {
  for (const p of s.players) if (p.seat === seat) return p;
  throw new RangeError(`no player at seat ${seat}`);
}

function companyAt(s: GameState, id: string) {
  const c = s.companies.find((x) => x.id === id);
  if (!c) throw new RangeError(`no company ${id}`);
  return c;
}

/** 从付款方扣款；返回实际扣到的金额（≥0）与是否破产 */
function debit(s: GameState, from: Party, amount: number, order: 'cashFirst' | 'depositFirst'): TransferResult {
  switch (from.t) {
    case 'seat': {
      const p = playerAt(s, from.seat);
      const avail = p.cash + p.deposit;
      if (avail < amount) {
        // 付不起：两个口袋清零，收款方只收到剩下的部分
        const paid = avail > 0 ? avail : 0;
        if (avail < 0) s.econ.ledger.minted += -avail;
        p.cash = 0;
        p.deposit = 0;
        return { paid, bankrupt: true };
      }
      if (order === 'cashFirst') {
        const c = p.cash > 0 ? p.cash : 0;
        // 负数金额（wrap）也走这里：c ≥ 0 > amount，现金反增，可能回绕
        if (c >= amount) p.cash = addMoney(s, p.cash, -amount);
        else {
          p.cash -= c;
          p.deposit -= amount - c;
        }
      } else {
        const d = p.deposit > 0 ? p.deposit : 0;
        if (d >= amount) p.deposit = addMoney(s, p.deposit, -amount);
        else {
          p.deposit -= d;
          p.cash -= amount - d;
        }
      }
      return { paid: amount, bankrupt: false };
    }
    case 'company': {
      const c = companyAt(s, from.company);
      c.surplusMonth = addMoney(s, c.surplusMonth, -amount);
      c.surplusTotal = add32(c.surplusTotal, -amount, modeOfState(s));
      return { paid: amount, bankrupt: false };
    }
    case 'pool':
      s.econ.pool = addMoney(s, s.econ.pool, -amount);
      return { paid: amount, bankrupt: false };
    case 'bank':
      bankFlow(s, amount);
      return { paid: amount, bankrupt: false };
  }
}

/** 银行付出 amount（铸造）；负数视为收回（销毁），保持 minted / burned 非负 */
function bankFlow(s: GameState, amount: number): void {
  if (amount >= 0) s.econ.ledger.minted += amount;
  else s.econ.ledger.burned += -amount;
}

function credit(s: GameState, to: Party, amount: number, where: 'cash' | 'deposit'): void {
  switch (to.t) {
    case 'seat': {
      const p = playerAt(s, to.seat);
      if (where === 'cash') p.cash = addMoney(s, p.cash, amount);
      else p.deposit = addMoney(s, p.deposit, amount);
      return;
    }
    case 'company': {
      const c = companyAt(s, to.company);
      c.surplusMonth = addMoney(s, c.surplusMonth, amount);
      c.surplusTotal = add32(c.surplusTotal, amount, modeOfState(s));
      return;
    }
    case 'pool':
      s.econ.pool = addMoney(s, s.econ.pool, amount);
      return;
    case 'bank':
      bankFlow(s, -amount);
      return;
  }
}

function checkAmount(s: GameState, amount: number, what: string): void {
  if (!Number.isInteger(amount) || (amount < 0 && modeOfState(s) !== 'wrap')) {
    throw new EngineInvariantError('BAD_AMOUNT', `${what}: bad amount ${amount}`);
  }
}

/** 通用转账（不压帧、不发事件；破产时由 Ctx.pay 压 BANKRUPT） */
export function transfer(
  s: GameState,
  from: Party,
  to: Party,
  amount: number,
  o: TransferOptions = {},
): TransferResult {
  checkAmount(s, amount, 'transfer');
  const r = debit(s, from, amount, o.order ?? 'cashFirst');
  credit(s, to, r.paid, o.credit ?? 'cash');
  if (o.accident) {
    const mode = modeOfState(s);
    if (from.t === 'seat') {
      const p = playerAt(s, from.seat);
      p.monthly.loss = add32(p.monthly.loss, r.paid, mode);
    }
    if (to.t === 'seat') {
      const p = playerAt(s, to.seat);
      p.monthly.gain = add32(p.monthly.gain, r.paid, mode);
    }
  }
  return r;
}

/**
 * 只用现金的消费：价格 > 现金返回 false（不改任何东西）；成功时钱 burn。
 * wrap 下价格可能回绕为负：与 canBuyLand 等的「价格 > 现金」口径一致，照 C 语义扣（现金反增，差额计 minted）。
 */
export function spendCash(s: GameState, seat: SeatIndex, amount: number): boolean {
  const p = playerAt(s, seat);
  if (!Number.isInteger(amount) || amount > p.cash) return false;
  if (amount < 0 && modeOfState(s) !== 'wrap') return false;
  p.cash = addMoney(s, p.cash, -amount);
  bankFlow(s, -amount);
  return true;
}

/** 铸造到玩家的现金或存款 */
export function mint(s: GameState, seat: SeatIndex, amount: number, where: 'cash' | 'deposit' = 'cash'): void {
  transfer(s, { t: 'bank' }, { t: 'seat', seat }, amount, { credit: where });
}

/** 把玩家剩余的现金与存款全部销毁（破产清算用；负值视为铸造回 0） */
export function zeroOutMoney(s: GameState, seat: SeatIndex): void {
  const p = playerAt(s, seat);
  const total = p.cash + p.deposit;
  if (total > 0) s.econ.ledger.burned += total;
  else if (total < 0) s.econ.ledger.minted += -total;
  p.cash = 0;
  p.deposit = 0;
}
