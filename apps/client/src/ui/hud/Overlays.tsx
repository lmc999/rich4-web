// HUD 叠层：回合横幅、骰子、toast、暂停条（design/client.md §4.5、§5.1）
import type { RoomView } from '@rich4/shared/net';
import clsx from 'clsx';
import { type CSSProperties, type ReactNode, useEffect } from 'react';
import { useClient } from '../../app/services';
import { useTx } from '../../i18n/tx';
import { type Toast, useUiStore } from '../../store/uiStore';
import { usePopupStore } from '../popups/popupStore';
import h from './hud.module.css';
import { type ToastSlot, useToastSlot } from './toastSlot';

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
    <div
      className={h.dice}
      data-testid="dice-overlay"
      data-rolling={d.rolling ? 'true' : 'false'}
      data-sum={sum}
      data-seat={d.seat}
      data-count={d.faces.length}
    >
      {d.faces.map((f, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: 骰子位置固定
          key={i}
          className={clsx(h.die, d.rolling && h.dieRolling)}
          style={{ color: `var(--c-p${d.seat + 1})` }}
          data-testid="dice-face"
          data-index={i}
          data-face={d.rolling ? '' : f}
        >
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

/** 排在登记的空位里：top 排法列表只有内容那么高（最高 h），bottom 排法列表占满空位、内容贴底 */
function slotStyle(slot: ToastSlot): CSSProperties {
  const base = { left: slot.x, top: slot.y, width: slot.w };
  return slot.align === 'top' ? { ...base, maxHeight: slot.h } : { ...base, height: slot.h };
}

/**
 * toast 列表。缺省画在页面上部正中（固定 CSS 像素大小）；原版皮肤的对局画面在舞台缩小（手机横屏）时由经典舞台登记
 * 棋盘视窗以外的空位（./toastSlot、ui/classic/layout 的 classicToastSlot），改排在那里——缺省位置在手机上正好叠在
 * 棋盘视窗上部，压住原版亮卡、神明弹窗的消息框。
 * 在缺省位置时，原版亮卡（ui/classic/popups/CardCast，消息框在棋盘视窗上部 (123,48)–(318,181)）期间暂缓显示：
 * 两条以上的 toast 会压到消息框，原版亮卡时画面静止、也没有别的提示。暂缓的 toast 仍在队列里，亮卡结束后重新出现并
 * 从那时起计时。排在空位里时不暂缓（碰不到消息框，暂缓只会让已经出现的 toast 闪没再出现）。
 */
export function Toasts(): ReactNode {
  const toasts = useUiStore((s) => s.toasts);
  const slot = useToastSlot((s) => s.slot);
  const casting = usePopupStore((s) => s.classicShown?.kind === 'cardCast');
  if (toasts.length === 0 || (casting && !slot)) return null;
  return (
    <ul
      className={clsx(h.toasts, slot && h.toastsSlot)}
      style={slot ? slotStyle(slot) : undefined}
      aria-live="polite"
      data-testid="toasts"
      data-place={slot?.place ?? 'page'}
    >
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
