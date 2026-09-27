// 弹窗共用的小部件：玩家胶囊（头像 + 名字）、金额变化列表
import type { ReactNode } from 'react';
import { useTx } from '../../i18n/tx';
import { formatMoney } from '../../presentation/names';
import { Avatar } from '../common/Avatar';
import type { PlayerRef, StatDelta } from './popupStore';
import s from './popups.module.css';

export function Person({ p, size = 28, children }: { p: PlayerRef; size?: number; children?: ReactNode }): ReactNode {
  return (
    <span className={s.person} data-seat={p.seat}>
      <Avatar character={p.character} size={size} seat={p.seat} />
      <span>{p.name}</span>
      {children}
    </span>
  );
}

export function Deltas({ deltas }: { deltas: readonly StatDelta[] }): ReactNode {
  const t = useTx();
  if (deltas.length === 0) return null;
  return (
    <>
      {deltas.map((d) => (
        <span
          key={d.field}
          className={`num ${d.field === 'points' ? s.points : d.delta > 0 ? s.gain : s.loss}`}
          data-field={d.field}
        >
          {t(`events:popup.field.${d.field}`)} {d.delta > 0 ? '+' : '-'}
          {formatMoney(Math.abs(d.delta))}
        </span>
      ))}
    </>
  );
}
