// 乐透开奖（design/client.md §4.5 LotteryDrawPopup）：摇奖球跳动滚号，停下后放大显示开出的号码与中奖人。
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { useRolling, useSpinner } from './hooks';
import { Person } from './parts';
import type { LotteryPopupSpec } from './popupStore';
import s from './popups.module.css';

const BALLS = 5;

export function LotteryDrawPopup({ spec, ms = 2800 }: { spec: LotteryPopupSpec; ms?: number }): ReactNode {
  const rolling = useRolling(spec.number === null ? 0 : Math.min(1800, ms * 0.6));
  const spin = useSpinner(rolling, 36, 90);
  return (
    <section className={clsx(s.card, s.lottery)} data-testid="lottery-popup" aria-label={spec.title}>
      <h2 className={s.title}>🎱 {spec.title}</h2>
      <div className={s.balls} data-rolling={rolling ? 'true' : 'false'}>
        {spec.number === null ? null : rolling ? (
          Array.from({ length: BALLS }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 位置固定
            <span key={i} className={clsx(s.ball, 'num')} style={{ animationDelay: `${i * 70}ms` }}>
              {((spin + i * 7) % 36) + 1}
            </span>
          ))
        ) : (
          <span className={clsx(s.ball, s.ballFinal, 'num')} data-testid="lottery-number">
            {spec.number}
          </span>
        )}
      </div>
      {!rolling && (
        <>
          <p data-testid="lottery-subtitle">{spec.subtitle}</p>
          {spec.winner && (
            <div className={s.caption}>
              <Person p={spec.winner} size={32} />
            </div>
          )}
        </>
      )}
    </section>
  );
}
