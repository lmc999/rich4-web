// /r/:code（邀请链接直接进房；?watch=1 以观战者进入）：连接 → resume / join → 大厅或对局。
// 满员或已开局时自动改为观战；房间关闭（解散、被踢、回收）回到首页并提示。
import { ROOM_CODE_RE } from '@rich4/shared/net';
import { lazy, type ReactNode, Suspense, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { useClient } from '../../app/services';
import { useTx } from '../../i18n/tx';
import { useRoomStore } from '../../store/roomStore';
import { useUiStore } from '../../store/uiStore';
import c from '../common/common.module.css';
import { Toasts } from '../hud/Overlays';
import { LobbyView } from '../lobby/LobbyView';
import { ReconnectOverlay } from '../system/ReconnectOverlay';
import { ScreenShell, shellStyles as s } from './ScreenShell';

// 对局页含 Pixi，按需加载
const GameScreen = lazy(() => import('./GameScreen'));

export default function RoomScreen({ code }: { code: string }): ReactNode {
  const t = useTx();
  const client = useClient();
  const search = useSearch();
  const watch = new URLSearchParams(search).get('watch') === '1';
  const room = useRoomStore((st) => st.room);
  const closed = useRoomStore((st) => st.closed);
  const [error, setError] = useState<string | null>(null);
  const [, navigate] = useLocation();
  const valid = ROOM_CODE_RE.test(code);
  // 进房只随房间号 / 身份变化重做：t 随界面语言变化（原版皮肤的对局页进出时在 zh-TW 与 zh-CN 之间切换），
  // 放进依赖会在「离开房间 → 对局页卸载 → 语言切回」的途中重新 enterRoom，把刚离开的玩家又拉回房间
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    if (!valid) return;
    let stale = false;
    setError(null);
    void client.enterRoom(code, watch ? 'spectator' : 'player').then((r) => {
      if (stale) return;
      if (!r.ok) setError(client.errorText(r.error));
      else if (r.data.fellBack)
        useUiStore.getState().toast(tRef.current('lobby:room.fellBackToSpectator'), 'info', 5000);
    });
    return () => {
      stale = true;
    };
  }, [client, code, watch, valid]);

  useEffect(() => {
    if (closed) navigate('/', { replace: true });
  }, [closed, navigate]);

  const leave = async (): Promise<void> => {
    await client.leaveRoom();
    navigate('/');
  };

  if (!valid || error) {
    return (
      <ScreenShell testId="screen-room-error">
        <h1 className={s.title}>{t('lobby:room.title', { code: code.slice(0, 12) })}</h1>
        <p className={c.error} role="alert" data-testid="room-error">
          {valid ? error : t('lobby:room.invalidCode')}
        </p>
        <div className={s.actions}>
          <Link href="/" className="btn btn--cream">
            {t('common.backHome')}
          </Link>
        </div>
      </ScreenShell>
    );
  }

  let body: ReactNode;
  if (!room || room.code !== code) {
    body = (
      <ScreenShell testId="screen-room-loading">
        <p className={s.tagline} role="status">
          {t('lobby:room.entering', { code })}
        </p>
      </ScreenShell>
    );
  } else if (room.phase === 'lobby') {
    body = <LobbyView room={room} onLeave={() => void leave()} />;
  } else {
    body = (
      <Suspense
        fallback={
          <ScreenShell testId="screen-game-loading">
            <p className={s.tagline} role="status">
              {t('common.loading')}
            </p>
          </ScreenShell>
        }
      >
        <GameScreen room={room} onLeave={() => void leave()} />
      </Suspense>
    );
  }
  return (
    <>
      {body}
      <Toasts />
      <ReconnectOverlay />
    </>
  );
}
