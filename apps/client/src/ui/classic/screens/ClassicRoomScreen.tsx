// /r/:code 的原版画面（逻辑同 ui/screens/RoomScreen：连接 → resume / join → 大厅或对局；满员或已开局自动改观战；
// 房间关闭回到首页并提示）：大厅阶段显示原版选人画面（ClassicLobby），对局阶段照常挂 GameScreen（经典布局由它按皮肤
// 选择），进入对局时叠原版 Loading 直到棋盘建好；进房中与出错用原版背景（知道房间的地图时用该图的 jump#gm）上的提示。
// 本页看到新局开始（大厅 → 对局，或单机页刚开局）时在 Loading 之上播该图的飞行动画（FlyVideo：读档、刷新、重连、观战不播）。
import { ROOM_CODE_RE } from '@rich4/shared/net';
import { lazy, type ReactNode, Suspense, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { useClient } from '../../../app/services';
import { useTx } from '../../../i18n/tx';
import { useRoomStore } from '../../../store/roomStore';
import { useUiStore } from '../../../store/uiStore';
import { Toasts } from '../../hud/Overlays';
import { ReconnectOverlay } from '../../system/ReconnectOverlay';
import { regionStyle } from '../layout';
import { GameLoading, LoadingScreen } from './ClassicLoading';
import ClassicLobby from './ClassicLobby';
import { FlyVideo, useFlyPlan } from './FlyVideo';
import { ensureScreensI18n } from './i18n';
import { ClassicScreenFrame, SetupBg } from './parts';
import s from './screens.module.css';

const GameScreen = lazy(() => import('../../screens/GameScreen'));

export default function ClassicRoomScreen({ code }: { code: string }): ReactNode {
  ensureScreensI18n();
  const t = useTx();
  const client = useClient();
  const search = useSearch();
  const watch = new URLSearchParams(search).get('watch') === '1';
  const room = useRoomStore((st) => st.room);
  const closed = useRoomStore((st) => st.closed);
  const [error, setError] = useState<string | null>(null);
  const [, navigate] = useLocation();
  const valid = ROOM_CODE_RE.test(code);
  const [fly, flyDone] = useFlyPlan(code, room);
  /** 背景：已经知道这个房间时用它的地图（jump#gm），否则台湾的 jump#0 */
  const bgMap = room?.code === code ? room.settings.game.mapId : null;
  // 进房只随房间号 / 身份变化重做（见 RoomScreen：t 随界面语言变化，不能放进依赖）
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
      <ClassicScreenFrame testId="screen-room-error" label={t('lobby:room.title', { code: code.slice(0, 12) })}>
        <SetupBg mapId={bgMap} />
        <div className={s.panel} style={regionStyle({ x: 120, y: 150, w: 400, h: 160 })}>
          <h2 className={s.outline}>{t('lobby:room.title', { code: code.slice(0, 12) })}</h2>
          <p className={s.error} role="alert" data-testid="room-error">
            {valid ? error : t('lobby:room.invalidCode')}
          </p>
          <Link href="/" className={s.panelBtn}>
            {t('common.backHome')}
          </Link>
        </div>
      </ClassicScreenFrame>
    );
  }

  let body: ReactNode;
  if (!room || room.code !== code) {
    body = (
      <ClassicScreenFrame testId="screen-room-loading" label={t('lobby:room.entering', { code })}>
        <SetupBg mapId={bgMap} />
        <p className={s.note} style={regionStyle({ x: 170, y: 220, w: 300, h: 40 })} role="status">
          {t('lobby:room.entering', { code })}
        </p>
      </ClassicScreenFrame>
    );
  } else if (room.phase === 'lobby') {
    body = <ClassicLobby room={room} onLeave={() => void leave()} />;
  } else {
    body = (
      <>
        <Suspense fallback={<LoadingScreen testId="screen-game-loading" />}>
          <GameScreen room={room} onLeave={() => void leave()} />
        </Suspense>
        <GameLoading />
        {fly && fly.code === code && <FlyVideo url={fly.url} maxMs={fly.maxMs} onDone={flyDone} />}
      </>
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
