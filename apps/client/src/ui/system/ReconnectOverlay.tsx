// 断线遮罩（design/client.md §5.7、§11B；net.md §5.2–5.3）：断线 1 秒后出现「连接中断，正在重连（第 n 次）…」，
// 对局中的玩家另外看到托管倒计时（断线超过 reconnectGraceSec 由电脑托管，重连后自动解除）；
// 遮罩出现过之后重新连上时 toast「已重新连接」。被同一 token 的另一页面顶替时提示并可在此处继续；
// 握手被拒（版本过旧）提示刷新。
// 房间页挂完整遮罩；首页与单机页挂 essentialOnly（只有「被顶替」与「无法连接」两种，普通断线不挡首页操作）。
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useClient } from '../../app/services';
import { useTx } from '../../i18n/tx';
import { useConnectionStore } from '../../store/connectionStore';
import { useRoomStore } from '../../store/roomStore';
import { useUiStore } from '../../store/uiStore';
import sy from './system.module.css';

export const OVERLAY_DELAY_MS = 1000;
/** 恢复提示的显示时长 */
export const RESTORED_TOAST_MS = 3000;

/** 托管倒计时：每秒刷新 */
function GraceNote({ since, graceSec }: { since: number; graceSec: number }): ReactNode {
  const t = useTx();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  const left = Math.ceil((since + graceSec * 1000 - now) / 1000);
  return (
    <p className={sy.graceNote} data-testid="reconnect-grace" data-left={Math.max(0, left)}>
      {left > 0 ? t('ui:conn.graceLeft', { n: left }) : t('ui:conn.autopiloted')}
    </p>
  );
}

export function ReconnectOverlay({ essentialOnly = false }: { essentialOnly?: boolean } = {}): ReactNode {
  const t = useTx();
  const client = useClient();
  const status = useConnectionStore((s) => s.status);
  const attempt = useConnectionStore((s) => s.attempt);
  const replaced = useConnectionStore((s) => s.replaced);
  const error = useConnectionStore((s) => s.error);
  const since = useConnectionStore((s) => s.since);
  const inGame = useRoomStore((s) => s.room !== null && s.room.phase !== 'lobby' && s.room.phase !== 'ended');
  const player = useRoomStore((s) => s.room?.you.role === 'player');
  const graceSec = useRoomStore((s) => s.room?.settings.reconnectGraceSec ?? null);
  const down = !essentialOnly && (status === 'reconnecting' || (status === 'closed' && !replaced));
  const [show, setShow] = useState(false);
  /** 遮罩出现过（断线超过 1 秒）：重新连上时提示 */
  const wasShown = useRef(false);

  useEffect(() => {
    if (!down) {
      setShow(false);
      return;
    }
    const id = setTimeout(() => setShow(true), OVERLAY_DELAY_MS);
    return () => clearTimeout(id);
  }, [down]);

  useEffect(() => {
    if (show) wasShown.current = true;
  }, [show]);

  useEffect(() => {
    if (status !== 'open' || !wasShown.current) return;
    wasShown.current = false;
    useUiStore
      .getState()
      .toast(inGame ? t('ui:conn.restoredGame') : t('ui:conn.restored'), 'success', RESTORED_TOAST_MS);
  }, [status, inGame, t]);

  if (replaced) {
    return (
      <div className={sy.overlay} role="alertdialog" aria-modal="true" data-testid="replaced-overlay">
        <div className={`panel ${sy.card}`}>
          <h2>{t('hud:reconnect.replacedTitle')}</h2>
          <p>{t('hud:reconnect.replacedBody')}</p>
          <button
            type="button"
            className="btn btn--blue"
            onClick={() => client.reclaim()}
            data-testid="replaced-reclaim"
          >
            {t('hud:reconnect.reclaim')}
          </button>
        </div>
      </div>
    );
  }
  if (status === 'closed' && error && (error.code === 'PROTOCOL_MISMATCH' || error.code === 'BAD_HANDSHAKE')) {
    return (
      <div className={sy.overlay} role="alertdialog" aria-modal="true" data-testid="fatal-overlay">
        <div className={`panel ${sy.card}`}>
          <h2>{t('hud:reconnect.fatalTitle')}</h2>
          <p>{client.errorText(error)}</p>
          <button type="button" className="btn btn--blue" onClick={() => location.reload()}>
            {t('hud:reconnect.reload')}
          </button>
        </div>
      </div>
    );
  }
  if (!show) return null;
  return (
    <div
      className={sy.overlay}
      role="alert"
      aria-live="assertive"
      data-testid="reconnect-overlay"
      data-attempt={attempt}
    >
      <div className={`panel ${sy.card}`}>
        <div className={sy.spinner} aria-hidden="true" />
        <h2>{attempt > 0 ? t('hud:reconnect.titleN', { n: attempt }) : t('hud:reconnect.title')}</h2>
        {inGame && player && graceSec !== null && <GraceNote since={since} graceSec={graceSec} />}
        {inGame && !player && <p className={sy.graceNote}>{t('ui:conn.spectatorNote')}</p>}
      </div>
    </div>
  );
}
