// 银行：BANK_ATM（路过或停下，存 / 取一笔；挤兑期间只能存）与 BANK_COUNTER（停下，ATM 之后：贷款 / 还款 / 董事长特别融资，三选一）。
// 金额用滑条 + 数字框；上限全部来自 options（现金、存款、loanLimit、repayMax、financeLimit）。
import { ToggleGroup } from 'radix-ui';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AmountSlider } from '../components/AmountSlider';
import { Button } from '../components/Button';
import { clampInt, formatDateShort } from '../components/format';
import { Money } from '../components/Money';
import { type LooseT, useGameText } from '../components/names';
import { KeyValues } from '../components/Panel';
import { BankPanel } from '../panels/BankPanel';
import { DecisionFrame } from './DecisionFrame';
import s from './decisions.module.css';
import type { DecisionProps } from './types';
import { useDecision } from './useDecision';

interface OpDef<Op extends string> {
  op: Op;
  label: string;
  max: number;
  /** 不可用原因（已翻译）；null 为可用 */
  blocked: string | null;
}

function OpToggle<Op extends string>({
  ops,
  value,
  onChange,
  label,
}: {
  ops: OpDef<Op>[];
  value: Op;
  onChange(op: Op): void;
  label: string;
}): ReactNode {
  return (
    <ToggleGroup.Root
      type="single"
      className={s.diceToggle}
      value={value}
      onValueChange={(v) => {
        if (v) onChange(v as Op);
      }}
      aria-label={label}
    >
      {ops.map((o) => (
        <ToggleGroup.Item
          key={o.op}
          value={o.op}
          className={s.diceItem}
          style={{ minWidth: 88, fontFamily: 'var(--font-title)' }}
          disabled={o.blocked !== null}
          data-testid={`bank-op-${o.op}`}
          title={o.blocked ?? undefined}
        >
          {o.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}

function firstOpen<Op extends string>(ops: OpDef<Op>[]): Op {
  return (ops.find((o) => o.blocked === null) ?? ops[0]!).op;
}

export function BankAtmDialog(props: DecisionProps<'BANK_ATM'>): ReactNode {
  const { t } = useTranslation();
  const { view, map, isMine, decision: d } = props;
  const ctl = useDecision(props);
  const text = useGameText(view, map);
  const o = d.options;
  const ops: OpDef<'deposit' | 'withdraw'>[] = [
    {
      op: 'deposit',
      label: t('dlg.bank.deposit'),
      max: o.cash,
      blocked: o.cash <= 0 ? t('dlg.bank.noCash') : null,
    },
    {
      op: 'withdraw',
      label: t('dlg.bank.withdraw'),
      max: o.deposit,
      blocked: !o.canWithdraw ? t('dlg.bank.bankRun') : o.deposit <= 0 ? t('dlg.bank.noDeposit') : null,
    },
  ];
  const [op, setOp] = useState(() => firstOpen(ops));
  const cur = ops.find((x) => x.op === op)!;
  const [amount, setAmount] = useState(0);
  const amt = clampInt(amount, 0, cur.max);

  return (
    <DecisionFrame
      ctl={ctl}
      kind={d.kind}
      seat={d.seat}
      view={view}
      isMine={isMine}
      title={t('dlg.bank.atmTitle')}
      subtitle={o.mode === 'pass' ? t('dlg.bank.pass') : t('dlg.bank.stop')}
      icon="🏧"
      tone="sun"
      actions={
        <>
          <Button variant="cream" onClick={() => ctl.send({ type: 'SKIP' })} data-testid="bank-skip">
            {t('dlg.bank.skip')}
          </Button>
          <Button
            variant="green"
            disabled={amt <= 0 || cur.blocked !== null}
            onClick={() => ctl.send({ type: 'ATM', op, amount: amt })}
            data-testid="bank-confirm"
          >
            {t(op === 'deposit' ? 'dlg.bank.doDeposit' : 'dlg.bank.doWithdraw')} <Money value={amt} />
          </Button>
        </>
      }
    >
      <div className={s.stack}>
        <BankPanel view={view} seat={d.seat} compact amounts={{ cash: o.cash, deposit: o.deposit }} />
        <OpToggle
          ops={ops}
          value={op}
          onChange={(v) => {
            setOp(v);
            setAmount(0);
          }}
          label={t('dlg.bank.op')}
        />
        {cur.blocked && <p className={s.warn}>{cur.blocked}</p>}
        <AmountSlider
          value={amt}
          onChange={setAmount}
          max={cur.max}
          label={t('dlg.bank.amount')}
          disabled={cur.blocked !== null}
          testId="bank-amount"
        />
        {op === 'withdraw' && o.reserveShortfallPayer !== null && (
          <p className={s.note}>{t('dlg.bank.shortfall', { name: text.player(o.reserveShortfallPayer) })}</p>
        )}
      </div>
    </DecisionFrame>
  );
}

type CounterOp = 'loan' | 'repay' | 'finance';

export function BankCounterDialog(props: DecisionProps<'BANK_COUNTER'>): ReactNode {
  const { t } = useTranslation();
  const lt = t as unknown as LooseT;
  const { view, isMine, decision: d } = props;
  const ctl = useDecision(props);
  const o = d.options;
  const ops: OpDef<CounterOp>[] = [
    {
      op: 'loan',
      label: t('dlg.bank.loan'),
      max: o.loanLimit,
      blocked: o.loanBlocked
        ? lt(`dlg.bank.loanBlocked.${o.loanBlocked}`)
        : o.loanLimit <= 0
          ? t('dlg.bank.noLimit')
          : null,
    },
    {
      op: 'repay',
      label: t('dlg.bank.repay'),
      max: o.repayMax,
      blocked: o.loan <= 0 ? t('dlg.bank.noLoan') : o.repayMax <= 0 ? t('dlg.bank.noMoney') : null,
    },
  ];
  if (o.financeLimit !== null) {
    ops.push({
      op: 'finance',
      label: t('dlg.bank.finance'),
      max: o.financeLimit,
      blocked: o.financeLimit <= 0 ? t('dlg.bank.noLimit') : null,
    });
  }
  const [op, setOp] = useState(() => firstOpen(ops));
  const cur = ops.find((x) => x.op === op) ?? ops[0]!;
  const [amount, setAmount] = useState(0);
  const amt = clampInt(amount, 0, cur.max);
  const intentType = op === 'loan' ? 'LOAN' : op === 'repay' ? 'REPAY' : 'FINANCE';

  return (
    <DecisionFrame
      ctl={ctl}
      kind={d.kind}
      seat={d.seat}
      view={view}
      isMine={isMine}
      title={t('dlg.bank.counterTitle')}
      icon="🏦"
      tone="sun"
      actions={
        <>
          <Button variant="cream" onClick={() => ctl.send({ type: 'SKIP' })} data-testid="bank-skip">
            {t('dlg.bank.leave')}
          </Button>
          <Button
            variant="green"
            disabled={amt <= 0 || cur.blocked !== null}
            onClick={() => ctl.send({ type: intentType, amount: amt })}
            data-testid="bank-confirm"
          >
            {lt(`dlg.bank.do.${op}`)} <Money value={amt} />
          </Button>
        </>
      }
    >
      <div className={s.stack}>
        <KeyValues
          rows={[
            [t('dlg.common.cash'), <Money key="c" value={o.cash} />],
            [t('dlg.common.deposit'), <Money key="d" value={o.deposit} />],
            [t('dlg.bank.loanNow'), <Money key="l" value={o.loan} testId="counter-loan" />],
            [
              t('dlg.bank.due'),
              o.loan > 0
                ? formatDateShort(o.loanDue)
                : t('dlg.bank.duePreview', { date: formatDateShort(o.dueDatePreview) }),
            ],
            [t('dlg.bank.limit'), <Money key="m" value={o.loanLimit} testId="counter-limit" />],
            ...(o.financeLimit !== null
              ? ([
                  [t('dlg.bank.financeNow'), <Money key="f" value={o.finance} />],
                  [t('dlg.bank.financeLimit'), <Money key="fl" value={o.financeLimit} />],
                ] as [ReactNode, ReactNode][])
              : []),
          ]}
        />
        <OpToggle
          ops={ops}
          value={op}
          onChange={(v) => {
            setOp(v);
            setAmount(0);
          }}
          label={t('dlg.bank.op')}
        />
        {cur.blocked && <p className={s.warn}>{cur.blocked}</p>}
        <AmountSlider
          value={amt}
          onChange={setAmount}
          max={cur.max}
          label={t('dlg.bank.amount')}
          disabled={cur.blocked !== null}
          testId="bank-amount"
        />
        <p className={s.muted}>{lt(`dlg.bank.hint.${op}`)}</p>
      </div>
    </DecisionFrame>
  );
}
