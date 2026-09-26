// 断线遮罩（design/client.md §5.7、§11B）：断线 1 秒后出现「连接中断，正在重连（第 n 次）…」；
// 被同一 token 的另一页面顶替时提示并可在此处继续；握手被拒（版本过旧）提示刷新。
// 房间页挂完整遮罩；首页与单机页挂 essentialOnly（只有「被顶替」与「无法连接」两种，普通断线不挡首页操作）。
import { type ReactNode, useEffect, useState } from 'react';
import { useClient } from '../../app/services';
import { useTx } from '../../i18n/tx';
import { useConnectionStore } from '../../store/connectionStore';
import { useRoomStore } from '../../store/roomStore';
import sy from './system.module.css';

export const OVERLAY_DELAY_MS = 1000;

export function ReconnectOverlay({ essentialOnly = false }: { essentialOnly?: boolean } = {}): ReactNode {
  const t = useTx();
  const client = useClient();
  const status = useConnectionStore((s) => s.status);
  const attempt = useConnectionStore((s) => s.attempt);
  const replaced = useConnectionStore((s) => s.replaced);
  const error = useConnectionStore((s) => s.error);
  const inGame = useRoomStore((s) => s.room !== null && s.room.phase !== 'lobby');
  const down = !essentialOnly && (status === 'reconnecting' || (status === 'closed' && !replaced));
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!down) {
      setShow(false);
      return;
    }
    const id = setTimeout(() => setShow(true), OVERLAY_DELAY_MS);
    return () => clearTimeout(id);
  }, [down]);

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
    <div className={sy.overlay} role="alert" aria-live="assertive" data-testid="reconnect-overlay">
      <div className={`panel ${sy.card}`}>
        <div className={sy.spinner} aria-hidden="true" />
        <h2>{attempt > 0 ? t('hud:reconnect.titleN', { n: attempt }) : t('hud:reconnect.title')}</h2>
        {inGame && <p>{t('hud:reconnect.autopilot')}</p>}
      </div>
    </div>
  );
}
