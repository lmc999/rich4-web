// HUD 叠层：回合横幅、骰子、toast、暂停条（design/client.md §4.5、§5.1）
import type { RoomView } from '@rich4/shared/net';
import clsx from 'clsx';
import { type ReactNode, useEffect } from 'react';
import { useClient } from '../../app/services';
import { useTx } from '../../i18n/tx';
import { type Toast, useUiStore } from '../../store/uiStore';
import h from './hud.module.css';

const FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'] as const;

export function TurnBanner(): ReactNode {
  const b = useUiStore((s) => s.banner);
  if (!b) return null;
  return (
    <div
      key={b.id}
      className={clsx(h.banner, h[`banner_${b.kind}`])}
      role="status"
      aria-live="polite"
      data-testid="turn-banner"
      data-kind={b.kind}
      style={b.seat !== undefined ? { borderColor: `var(--c-p${b.seat + 1})` } : undefined}
    >
      <div className={h.bannerTitle}>{b.title}</div>
      {b.subtitle && <div className={h.bannerSub}>{b.subtitle}</div>}
    </div>
  );
}

export function DiceOverlay(): ReactNode {
  const d = useUiStore((s) => s.dice);
  const t = useTx();
  useEffect(() => {
    if (!d || d.rolling) return;
    // 落定后 1.5 秒（真实时间）自动收起；下一次掷骰会替换
    const id = setTimeout(() => {
      if (useUiStore.getState().dice?.id === d.id) useUiStore.getState().setDice(null);
    }, 1500);
    return () => clearTimeout(id);
  }, [d]);
  if (!d) return null;
  const sum = d.faces.reduce((a, b) => a + b, 0);
  return (
    <div className={h.dice} data-testid="dice-overlay" data-rolling={d.rolling ? 'true' : 'false'} data-sum={sum}>
      {d.faces.map((f, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 骰子位置固定
        <span key={i} className={clsx(h.die, d.rolling && h.dieRolling)} style={{ color: `var(--c-p${d.seat + 1})` }}>
          {d.rolling ? FACES[(i * 2 + 3) % 6] : FACES[(f - 1) % 6]}
        </span>
      ))}
      {!d.rolling && <span className={h.diceSum}>{t('hud:dice.sum', { n: sum })}</span>}
    </div>
  );
}

/** 单条 toast：出现时设一次定时器（ttl 从出现起算），其他 toast 增删不会让它重新计时 */
function ToastItem({ toast: x }: { toast: Toast }): ReactNode {
  useEffect(() => {
    const id = setTimeout(() => useUiStore.getState().dismissToast(x.id), x.ttl);
    return () => clearTimeout(id);
  }, [x.id, x.ttl]);
  return (
    <li className={clsx(h.toast, h[`toast_${x.kind}`])} data-testid="toast" data-kind={x.kind}>
      <span>{x.text}</span>
      <button
        type="button"
        className={h.toastX}
        onClick={() => useUiStore.getState().dismissToast(x.id)}
        aria-label="×"
      >
        ×
      </button>
    </li>
  );
}

export function Toasts(): ReactNode {
  const toasts = useUiStore((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <ul className={h.toasts} aria-live="polite" data-testid="toasts">
      {toasts.map((x) => (
        <ToastItem key={x.id} toast={x} />
      ))}
    </ul>
  );
}

export function PausedBanner({ room }: { room: RoomView }): ReactNode {
  const t = useTx();
  const client = useClient();
  if (room.phase !== 'paused') return null;
  const reason = room.paused?.reason ?? 'host';
  return (
    <div className={h.paused} role="status" data-testid="paused-banner">
      <strong>⏸ {t('hud:paused.title')}</strong>
      <span>{t(`hud:paused.${reason}`)}</span>
      {room.you.isHost && (
        <button
          type="button"
          className="btn btn--sm btn--green"
          onClick={() => void client.pause(false)}
          data-testid="paused-resume"
        >
          {t('hud:menu.resume')}
        </button>
      )}
    </div>
  );
}
