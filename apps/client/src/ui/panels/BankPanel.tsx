// BankPanel（design/client.md §5.4）：存款、贷款与到期日、特别融资、利率与下次计息日。存取款滑条在 BankDialog（只有在银行格才能办）。
import type { SeatIndex } from '@rich4/shared/engine';
import type { GameView } from '@rich4/shared/view';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { counterDays, formatDateShort, nextMonthFirst } from '../components/format';
import { Money } from '../components/Money';
import s from './panels.module.css';

export interface BankPanelProps {
  view: GameView;
  seat: SeatIndex;
  /** 紧凑模式：只显示数字卡片（嵌在 BankDialog 里） */
  compact?: boolean;
  /** 用决策 options 里的数字覆盖 view（决策出现那一刻两者一致，options 为准） */
  amounts?: { cash: number; deposit: number };
}

export function BankPanel({ view, seat, compact = false, amounts }: BankPanelProps): ReactNode {
  const { t } = useTranslation();
  const p = view.players.find((x) => x.seat === seat);
  if (!p) return null;
  const next = nextMonthFirst(view.clock.date);
  return (
    <section className={s.panel} aria-label={t('pnl.bank.title')} data-testid="bank-panel">
      {!compact && (
        <header className={s.head}>
          <h2>🏦 {t('pnl.bank.title')}</h2>
        </header>
      )}
      <div className={s.stats}>
        <div className={s.stat}>
          <span>{t('pnl.bank.cash')}</span>
          <Money value={amounts?.cash ?? p.cash} testId="bank-cash" />
        </div>
        <div className={s.stat}>
          <span>{t('pnl.bank.deposit')}</span>
          <Money value={amounts?.deposit ?? p.deposit} testId="bank-deposit" />
        </div>
        <div className={s.stat}>
          <span>{t('pnl.bank.loan')}</span>
          <Money value={p.loan} testId="bank-loan" />
        </div>
        {p.finance > 0 && (
          <div className={s.stat}>
            <span>{t('pnl.bank.finance')}</span>
            <Money value={p.finance} />
          </div>
        )}
      </div>
      {!compact && (
        <>
          <p className={s.muted}>
            {p.loan > 0
              ? t('pnl.bank.loanDue', { date: formatDateShort(p.loanDue) })
              : t('pnl.bank.interest', { date: formatDateShort(next) })}
          </p>
          {view.econ.bankRunDays > 0 && <p className={s.warn}>{t('pnl.bank.bankRun', { n: view.econ.bankRunDays })}</p>}
          {p.bankReject > 0 && <p className={s.warn}>{t('pnl.bank.rejected', { n: counterDays(p.bankReject) })}</p>}
        </>
      )}
    </section>
  );
}
