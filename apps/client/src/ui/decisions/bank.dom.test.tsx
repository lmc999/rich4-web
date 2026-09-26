// BankDialog：ATM 存取款滑条（挤兑只能存）、柜台贷款 / 还款 / 特别融资（上限取自 options）
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BankAtmDialog, BankCounterDialog } from './BankDialog';
import { expectSingleIntent, renderDialog } from './testing';

describe('BankAtmDialog', () => {
  it('默认存款：输入金额 → ATM{deposit}；金额夹在现金以内', async () => {
    const r = renderDialog(BankAtmDialog, 'BANK_ATM');
    expect(screen.getByTestId('bank-cash')).toHaveTextContent('48,800');
    expect(screen.getByTestId('bank-confirm')).toBeDisabled(); // 金额 0
    const amount = screen.getByRole('spinbutton', { name: '金额' });
    await r.user.clear(amount);
    await r.user.type(amount, '99999');
    expect(amount).toHaveValue(48800);
    await r.user.clear(amount);
    await r.user.type(amount, '12000');
    await r.user.dblClick(screen.getByTestId('bank-confirm'));
    expectSingleIntent(r.submit, { type: 'ATM', op: 'deposit', amount: 12000 });
  });

  it('切到取款，用「一半」快捷档 → ATM{withdraw}，并提示董事长垫付', async () => {
    const r = renderDialog(BankAtmDialog, 'BANK_ATM');
    await r.user.click(screen.getByTestId('bank-op-withdraw'));
    expect(screen.getByText(/由董事长 钱夫人 垫付/)).toBeInTheDocument();
    await r.user.click(screen.getByRole('button', { name: '一半' }));
    await r.user.click(screen.getByTestId('bank-confirm'));
    expectSingleIntent(r.submit, { type: 'ATM', op: 'withdraw', amount: 60000 });
  });

  it('挤兑期间取款禁用；滑条拖动也能改金额；不办了 → SKIP', async () => {
    const r = renderDialog(BankAtmDialog, 'BANK_ATM', { options: { canWithdraw: false } });
    expect(screen.getByTestId('bank-op-withdraw')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('金额', { selector: 'input[type="range"]' }), { target: { value: '3000' } });
    expect(screen.getByRole('spinbutton', { name: '金额' })).toHaveValue(3000);
    await r.user.click(screen.getByTestId('bank-skip'));
    expectSingleIntent(r.submit, { type: 'SKIP' });
  });
});

describe('BankCounterDialog', () => {
  it('贷款：额度与到期日；全部 → LOAN{loanLimit}', async () => {
    const r = renderDialog(BankCounterDialog, 'BANK_COUNTER');
    expect(screen.getByTestId('counter-limit')).toHaveTextContent('180,000');
    expect(screen.getByTestId('counter-loan')).toHaveTextContent('20,000');
    await r.user.click(screen.getByRole('button', { name: '全部' }));
    await r.user.click(screen.getByTestId('bank-confirm'));
    expectSingleIntent(r.submit, { type: 'LOAN', amount: 180000 });
  });

  it('还款 → REPAY；融资 → FINANCE（只有董事长有融资选项）', async () => {
    const r = renderDialog(BankCounterDialog, 'BANK_COUNTER');
    await r.user.click(screen.getByTestId('bank-op-repay'));
    await r.user.click(screen.getByRole('button', { name: '全部' }));
    await r.user.click(screen.getByTestId('bank-confirm'));
    expectSingleIntent(r.submit, { type: 'REPAY', amount: 20000 });
  });

  it('融资 → FINANCE', async () => {
    const r = renderDialog(BankCounterDialog, 'BANK_COUNTER');
    await r.user.click(screen.getByTestId('bank-op-finance'));
    const amount = screen.getByRole('spinbutton', { name: '金额' });
    await r.user.clear(amount);
    await r.user.type(amount, '5000');
    await r.user.click(screen.getByTestId('bank-confirm'));
    expectSingleIntent(r.submit, { type: 'FINANCE', amount: 5000 });
  });

  it('非董事长没有融资；拒绝往来时贷款禁用并显示原因', () => {
    renderDialog(BankCounterDialog, 'BANK_COUNTER', { options: { financeLimit: null, loanBlocked: 'rejected' } });
    expect(screen.queryByTestId('bank-op-finance')).toBeNull();
    expect(screen.getByTestId('bank-op-loan')).toBeDisabled();
    // 默认落到第一个可用的业务（还款）
    expect(screen.getByTestId('bank-op-repay')).toHaveAttribute('data-state', 'on');
  });
});
