// 神明降临 / 发威 / 显灵（design/client.md §4.5 GodArrivePopup）：神明立绘 + 台词；发威带老虎机时数字先滚动再定格。
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { useTx } from '../../i18n/tx';
import { godUrl } from './figureUrls';
import { useRolling, useSpinner } from './hooks';
import { Person } from './parts';
import type { GodPopupSpec } from './popupStore';
import s from './popups.module.css';

/** 老虎机：digits 位，滚动 rollMs 后停在 value（左侧补 0） */
export function SlotMachine({ digits, value, rollMs }: { digits: number; value: number; rollMs: number }): ReactNode {
  const rolling = useRolling(rollMs);
  const spin = useSpinner(rolling, 10);
  const n = Math.max(1, Math.min(8, digits));
  const shown = String(Math.max(0, Math.trunc(value)))
    .padStart(n, '0')
    .slice(-n);
  return (
    <span className={s.slot} data-testid="god-slot" data-value={value} data-rolling={rolling ? 'true' : 'false'}>
      {[...shown].map((d, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 位置固定
        <span key={i} className={clsx(s.slotDigit, 'num')} data-rolling={rolling ? 'true' : 'false'}>
          {rolling ? String((spin + i * 3) % 10) : d}
        </span>
      ))}
    </span>
  );
}

export function GodArrivePopup({ spec, ms = 1300 }: { spec: GodPopupSpec; ms?: number }): ReactNode {
  const t = useTx();
  return (
    <section
      className={clsx(s.card, s.god, spec.good ? s.godGood : s.godBad)}
      data-testid="god-popup"
      data-god={spec.god}
      aria-label={spec.title}
    >
      <img className={s.godImg} src={godUrl(spec.god, spec.slot ? 'cheer' : 'idle0')} alt={spec.godName} />
      <div>
        <h2 className={s.title}>{spec.title}</h2>
        <p className={s.line} data-testid="god-line">
          「{spec.line}」
        </p>
        {spec.slot && (
          <div>
            <small>{t('events:popup.slot')}</small> <SlotMachine {...spec.slot} rollMs={Math.min(1600, ms * 0.55)} />
          </div>
        )}
        {spec.amountText && (
          <div className={clsx(s.amount, spec.amountText.startsWith('-') ? s.loss : s.gain)}>{spec.amountText}</div>
        )}
        {spec.player && (
          <div className={s.caption} style={{ justifyContent: 'flex-start' }}>
            <Person p={spec.player} />
          </div>
        )}
      </div>
    </section>
  );
}
