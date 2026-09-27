import { describe, expect, it } from 'vitest';
import { scenario } from '../testing/scenario';

/**
 * 银行（design/engine.md §7.5、§11.3）。fixture 'test'：18 → 1（银行格，企业 C1 = 银行）→ 2 → 3。
 * 路过银行开 ATM、办完继续走；停在银行先 ATM 再柜台；贷款 90 天到期，遇休市顺延，到期强制还款。
 */
describe('bank', () => {
  it('bank.pass-atm-resume-move：路过银行开 ATM，办完继续走完剩余步数', () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    // 3 号是命运格：让它抽到不动钱的命运 3（拒绝往来）
    sc.stackDeck('fate', [3]).teleport(0, 18, 17).force('dice', 3).roll(0);
    expect(sc.event('MOVE_SEGMENT')).toMatchObject({ path: [1], remaining: 2 });
    sc.expectAsk(0, 'BANK_ATM');
    expect(sc.pending(0).options).toMatchObject({ mode: 'pass', cash: 100000, deposit: 100000, canWithdraw: true });
    sc.act(0, { type: 'ATM', op: 'deposit', amount: 30000 });
    sc.expectEvents(['ATM', 'MOVE_SEGMENT', 'LANDED']);
    expect(sc.events.find((e) => e.type === 'MOVE_SEGMENT')).toMatchObject({ path: [2, 3], remaining: 0 });
    expect(sc.player(0)).toMatchObject({ node: 3, cash: 70000, deposit: 130000 });
    // 路过不到柜台
    expect(sc.state.pending.every((d) => d.kind !== 'BANK_COUNTER')).toBe(true);
  });

  it('bank.pass-skip：SKIP 同样继续走；取款超过存款被拒绝', () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    sc.teleport(0, 18, 17).force('dice', 2).roll(0).expectAsk(0, 'BANK_ATM');
    expect(() => sc.act(0, { type: 'ATM', op: 'withdraw', amount: 100001 })).toThrow(/CANNOT_AFFORD/);
    sc.act(0, { type: 'SKIP' });
    expect(sc.player(0).node).toBe(2);
  });

  it('bank.stop-counter：停在银行先 ATM 再柜台；贷款进存款、到期日 90 天（遇休市顺延）；还款先扣存款', () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    // 2005-05-05（星期四）+ 90 天 = 2005-08-03（星期三），不顺延
    sc.teleport(0, 18, 17).force('dice', 1).roll(0).expectAsk(0, 'BANK_ATM');
    expect(sc.pending(0).options).toMatchObject({ mode: 'stop' });
    sc.act(0, { type: 'SKIP' }).expectAsk(0, 'BANK_COUNTER');
    const o = sc.pending(0).options as { loanLimit: number; dueDatePreview: number; financeLimit: number | null };
    expect(o.loanLimit).toBe(200000);
    expect(o.dueDatePreview).toBe(20050803);
    expect(o.financeLimit).toBeNull();
    expect(() => sc.act(0, { type: 'LOAN', amount: 200001 })).toThrow(/OUT_OF_RANGE/);
    sc.act(0, { type: 'LOAN', amount: 50000 });
    expect(sc.event('LOAN')).toMatchObject({ seat: 0, amount: 50000, due: 20050803 });
    expect(sc.player(0)).toMatchObject({ loan: 50000, loanDue: 20050803, deposit: 150000, cash: 100000 });
    // 柜台每次一笔：办完就结束本回合
    sc.expectNoAsk(0, 'BANK_COUNTER');

    // 下次停在银行：还款先扣存款再扣现金，还清后到期日清零
    sc.untilMenu(0).setCash(0, 100000, 20000).teleport(0, 18, 17).force('dice', 1).roll(0);
    sc.act(0, { type: 'SKIP' }).expectAsk(0, 'BANK_COUNTER');
    expect(sc.pending(0).options).toMatchObject({ repayMax: 50000, loan: 50000, dueDatePreview: 20050803 });
    sc.act(0, { type: 'REPAY', amount: 50000 });
    expect(sc.player(0)).toMatchObject({ loan: 0, loanDue: 0, deposit: 0, cash: 70000 });
  });

  it('loan.due-forced-repay：剩 3 天提醒；到期在本人回合开始按银行口径强制还清', () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    sc.teleport(0, 18, 17).force('dice', 1).roll(0).act(0, { type: 'SKIP' });
    sc.act(0, { type: 'LOAN', amount: 30000 });
    const due = sc.player(0).loanDue;
    // 让下一天是到期前 3 天
    sc.untilMenu(1).apply({ type: 'SYS_DEBUG', op: { op: 'setDate', date: 20050730 } });
    sc.until((s) => s.pending[0]?.seat === 0 && s.pending[0]?.kind === 'TURN_MENU');
    expect(sc.log.find((e) => e.type === 'LOAN_REMINDER')).toMatchObject({ seat: 0, daysLeft: 3 });
    // 到期当天：先扣存款
    sc.setCash(0, 5000, 40000).apply({ type: 'SYS_DEBUG', op: { op: 'setDate', date: due - 1 } });
    sc.roll(0).until((s) => s.pending[0]?.seat === 0 && s.pending[0]?.kind === 'TURN_MENU');
    expect(sc.log.find((e) => e.type === 'LOAN_FORCED')).toMatchObject({ seat: 0, amount: 30000, paid: 30000 });
    expect(sc.player(0)).toMatchObject({ loan: 0, loanDue: 0, deposit: 10000, cash: 5000 });
  });

  it('loan.due-forced-repay：扣不出来就破产', () => {
    const sc = scenario({ players: ['human', 'human', 'human'] }).untilMenu(0);
    sc.teleport(0, 18, 17).force('dice', 1).roll(0).act(0, { type: 'SKIP' });
    sc.act(0, { type: 'LOAN', amount: 30000 });
    const due = sc.player(0).loanDue;
    // 其余两人先关两天：到期前不走动（避免新闻的税改变 0 号的钱）
    sc.bench(1, 2).bench(2, 2);
    sc.setCash(0, 1000, 2000).apply({ type: 'SYS_DEBUG', op: { op: 'setDate', date: due - 1 } });
    // 0 号这一步走到 4 号卡片格（不是新闻 / 命运格）
    sc.force('dice', 3).until((s) => !s.players[0]!.alive);
    const forced = sc.log.find((e) => e.type === 'LOAN_FORCED');
    expect(forced).toMatchObject({ seat: 0, amount: 30000, paid: 3000 });
    expect(sc.log.find((e) => e.type === 'BANKRUPT')).toMatchObject({ seat: 0, cause: { k: 'loan' } });
    sc.untilMenu(1);
  });

  it('loan：到期日落在星期日顺延到星期一', () => {
    // 2005-05-08 是星期日；2005-02-07（星期一）+ 90 天 = 2005-05-08 → 顺延到 5-09
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    sc.apply({ type: 'SYS_DEBUG', op: { op: 'setDate', date: 20050207 } });
    sc.teleport(0, 18, 17).force('dice', 1).roll(0).act(0, { type: 'SKIP' });
    expect(sc.pending(0).options).toMatchObject({ dueDatePreview: 20050509 });
  });

  it('bank.rejected / sunday：拒绝往来只提示；sundayBankClosed 时星期日 ATM 与柜台都只提示', () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    sc.edit((s) => {
      s.players[0]!.bankReject = 10;
    });
    sc.stackDeck('fate', [3]).teleport(0, 18, 17).force('dice', 3).roll(0);
    expect(sc.event('BANK_REJECTED')).toMatchObject({ seat: 0, days: 11, reason: 'rejected' });
    expect(sc.player(0).node).toBe(3);

    const sun = scenario({ players: ['human', 'human'], rules: { sundayBankClosed: true } }).untilMenu(0);
    sun.apply({ type: 'SYS_DEBUG', op: { op: 'setDate', date: 20050508 } });
    sun.teleport(0, 18, 17).force('dice', 1).roll(0);
    expect(sun.event('BANK_REJECTED')).toMatchObject({ seat: 0, reason: 'sunday' });
    sun.expectNoAsk(0, 'BANK_ATM');
    // PROGRAM：星期日照常营业
    const prog = scenario({ players: ['human', 'human'] }).untilMenu(0);
    prog.apply({ type: 'SYS_DEBUG', op: { op: 'setDate', date: 20050508 } });
    prog.teleport(0, 18, 17).force('dice', 1).roll(0).expectAsk(0, 'BANK_ATM');
  });

  it('bank.run：挤兑期间 ATM 只能存、柜台不放款', () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    sc.edit((s) => {
      s.econ.bankRunDays = 5;
    });
    sc.teleport(0, 18, 17).force('dice', 1).roll(0).expectAsk(0, 'BANK_ATM');
    expect(sc.pending(0).options).toMatchObject({ canWithdraw: false });
    expect(() => sc.act(0, { type: 'ATM', op: 'withdraw', amount: 1 })).toThrow(/NOT_ALLOWED/);
    sc.act(0, { type: 'SKIP' });
    // 没有贷款可还、也不能借 → 柜台不问
    sc.expectNoAsk(0, 'BANK_COUNTER');
  });

  it('bank.finance-reserve：银行董事长特别融资；别人取款使存款合计低于融资额时由董事长垫付', () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    // 0 号持有银行股（股票 0）成为董事长
    sc.edit((s) => {
      s.players[0]!.holdings[0] = { shares: 100, costCents: 800000 };
      s.stocks[0]!.float -= 100;
      s.stocks[0]!.chairman = 0;
    });
    sc.teleport(0, 18, 17).force('dice', 1).roll(0).act(0, { type: 'SKIP' }).expectAsk(0, 'BANK_COUNTER');
    expect(sc.pending(0).options).toMatchObject({ financeLimit: 100000 });
    expect(() => sc.act(0, { type: 'FINANCE', amount: 100001 })).toThrow(/OUT_OF_RANGE/);
    sc.act(0, { type: 'FINANCE', amount: 80000 });
    expect(sc.player(0)).toMatchObject({ finance: 80000, deposit: 180000 });
    // 1 号路过银行取款 30000：其他人存款 70000 < 融资 80000 → 0 号垫付 10000（先扣存款）
    sc.untilMenu(1).teleport(1, 18, 17).force('dice', 2).roll(1).expectAsk(1, 'BANK_ATM');
    expect(sc.pending(1).options).toMatchObject({ reserveShortfallPayer: 0 });
    sc.act(1, { type: 'ATM', op: 'withdraw', amount: 30000 });
    expect(sc.event('RESERVE_SHORTFALL')).toMatchObject({ chairman: 0, amount: 10000 });
    expect(sc.player(0)).toMatchObject({ finance: 70000, deposit: 170000 });
  });
});
