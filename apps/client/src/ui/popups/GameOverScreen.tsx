// 终局画面（design/client.md §4.5 gameOver）：烟花 + 排名 + 每人资产构成（现金、存款、股票、地产，贷款另列）。
// 终局演出期间由 PopupLayer 显示；也可以单独使用（actions 传入「再来一局 / 离开」按钮）。
import clsx from 'clsx';
import type { CSSProperties, ReactNode } from 'react';
import { useTx } from '../../i18n/tx';
import { formatMoney } from '../../presentation/names';
import { Avatar } from '../common/Avatar';
import type { GameOverPopupSpec, GameOverRow } from './popupStore';
import s from './popups.module.css';

const PART_COLORS = {
  cash: 'var(--c-green)',
  deposit: 'var(--c-blue)',
  stocks: 'var(--c-purple)',
  estate: 'var(--c-orange)',
} as const;
type PartKey = keyof typeof PART_COLORS;
const PART_KEYS: readonly PartKey[] = ['cash', 'deposit', 'stocks', 'estate'];

/** 装饰烟花（DOM；减少动态时不播放） */
export function Fireworks({ bursts = 5 }: { bursts?: number }): ReactNode {
  const sparks: { key: string; style: CSSProperties }[] = [];
  const colors = ['#F2545B', '#FFD84D', '#3D8BFD', '#5CC85A', '#9B6BFF'];
  for (let b = 0; b < bursts; b++) {
    const left = 12 + ((b * 37) % 76);
    const top = 10 + ((b * 23) % 30);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      sparks.push({
        key: `${b}-${i}`,
        style: {
          left: `${left}%`,
          top: `${top}%`,
          background: colors[(b + i) % colors.length],
          animationDelay: `${b * 0.35}s`,
          '--dx': `${Math.round(Math.cos(a) * 70)}px`,
          '--dy': `${Math.round(Math.sin(a) * 70)}px`,
        } as CSSProperties,
      });
    }
  }
  return (
    <div className={s.fireworks} aria-hidden="true" data-testid="fireworks">
      {sparks.map((x) => (
        <span key={x.key} className={s.spark} style={x.style} />
      ))}
    </div>
  );
}

function PartsBar({ row, max }: { row: GameOverRow; max: number }): ReactNode {
  const t = useTx();
  const total = Math.max(1, max);
  return (
    <div className={s.parts} role="img" aria-label={partsLabel(row, t)} data-testid={`over-parts-${row.seat}`}>
      {PART_KEYS.map((k) => {
        const v = Math.max(0, row.parts[k]);
        if (v === 0) return null;
        return <span key={k} data-part={k} style={{ width: `${(v / total) * 100}%`, background: PART_COLORS[k] }} />;
      })}
    </div>
  );
}

function partsLabel(row: GameOverRow, t: (k: string, p?: Record<string, unknown>) => string): string {
  const out = PART_KEYS.map((k) => `${t(`events:popup.part.${k}`)} ${formatMoney(row.parts[k])}`);
  if (row.parts.loan > 0) out.push(`${t('events:popup.part.loan')} -${formatMoney(row.parts.loan)}`);
  return out.join('，');
}

export function GameOverScreen({
  spec,
  actions,
  fireworks = true,
}: {
  spec: GameOverPopupSpec;
  actions?: ReactNode;
  fireworks?: boolean;
}): ReactNode {
  const t = useTx();
  const max = Math.max(1, ...spec.rows.map((r) => PART_KEYS.reduce((a, k) => a + Math.max(0, r.parts[k]), 0)));
  return (
    <section className={clsx(s.card, s.over)} data-testid="game-over-screen" aria-label={spec.title}>
      {fireworks && <Fireworks />}
      <header className={s.overHead}>
        {spec.winner && <Avatar character={spec.winner.character} size={64} seat={spec.winner.seat} expr="happy" />}
        <div>
          <h2 className={s.overTitle}>🏆 {spec.title}</h2>
          <p style={{ margin: 0 }}>{spec.subtitle}</p>
        </div>
      </header>
      <ol className={s.ranking} aria-label={t('events:popup.ranking')}>
        {spec.rows.map((r) => (
          <li
            key={r.seat}
            className={clsx(!r.alive && s.rankOut)}
            data-testid={`over-rank-${r.rank}`}
            data-seat={r.seat}
          >
            <div className={s.rankRow}>
              <span className={s.rankNo}>{r.rank}</span>
              <Avatar character={r.character} size={32} seat={r.seat} expr={r.alive ? 'normal' : 'sad'} />
              <span>
                {r.name}
                {!r.alive && <small> · {t('events:popup.out')}</small>}
              </span>
              <span className="num">{formatMoney(r.netWorth)}</span>
              <PartsBar row={r} max={max} />
            </div>
          </li>
        ))}
      </ol>
      <div className={s.legend} aria-hidden="true">
        {PART_KEYS.map((k) => (
          <span key={k}>
            <i style={{ background: PART_COLORS[k] }} />
            {t(`events:popup.part.${k}`)}
          </span>
        ))}
        <span>{t('events:popup.loanNote')}</span>
      </div>
      {actions && <div className={s.overActions}>{actions}</div>}
    </section>
  );
}
