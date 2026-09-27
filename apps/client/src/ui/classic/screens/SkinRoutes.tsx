// 首页 / 房间 / 单机三条路由按皮肤选画面（original-skin.md §4.3、A14）：原版皮肤判定成立（useClassicScreens）时用
// 原版标题、开局设置、选人大厅与 Loading（本目录，懒加载，不进首屏），否则用程序化画面（ui/screens）。
// - 判定中（发现素材包）显示载入画面，不先画程序化画面再切换；判定有了结论后在路由实例内固定（usePinnedScreens：
//   超时判成程序化之后素材包才就绪也不中途换画面；改皮肤设置或门禁状态变化时重新判定）；
// - 界面语言与主题：原版画面 → zh-TW + 原版字体，程序化 → zh-CN（对局页由 GameScreen 的 useGameSkin 自己管，这里不插手）；
// - 房间页判定中就先进房（client.enterRoom 幂等，之后挂上的画面再调用直接返回）：房间已在对局中（刷新续玩、直接进入
//   进行中的房间）时不等判定，立即挂对局页（它自己的 useGameSkin 选布局并等素材包），不吃掉决策计时；
// - 房间页进入对局后画面选择固定下来：对局中在设置页改皮肤只换对局页自己的布局，不因这里换画面而重建对局页；
// - 房间页在对局之外（判定中、进房中、大厅）自带门禁页宿主：房间页上发现素材包遇到 401 时门禁页挂在这里，
//   进入对局后交给对局页自己的宿主（不另挂全屏浮层，避免对局页再挂一份而出现两个门禁页）。
import { ROOM_CODE_RE } from '@rich4/shared/net';
import { lazy, type ReactNode, Suspense, useEffect, useRef } from 'react';
import { useSearch } from 'wouter';
import { useClient } from '../../../app/services';
import { useTx } from '../../../i18n/tx';
import { applySkinTheme } from '../../../skin/theme';
import { useRoomStore } from '../../../store/roomStore';
import { useUiStore } from '../../../store/uiStore';
import { AccessGateHost } from '../../access/AccessGateHost';
import { HomeScreen } from '../../screens/HomeScreen';
import { ScreensPending } from './pending';
import { type ScreensMode, usePinnedScreens } from './useClassicScreens';

const RoomScreen = lazy(() => import('../../screens/RoomScreen'));
const SoloScreen = lazy(() => import('../../screens/SoloScreen'));
const ClassicHome = lazy(() => import('./ClassicHome'));
const ClassicRoomScreen = lazy(() => import('./ClassicRoomScreen'));
const ClassicSolo = lazy(() => import('./ClassicSolo'));

/** 按画面模式应用界面语言与主题（inGame 时交给对局页） */
function useScreensTheme(mode: ScreensMode, inGame: boolean): void {
  useEffect(() => {
    if (mode === 'pending' || inGame) return;
    void applySkinTheme(mode === 'classic' ? 'original' : 'procedural');
  }, [mode, inGame]);
}

export function SkinHome(): ReactNode {
  const mode = usePinnedScreens();
  useScreensTheme(mode, false);
  if (mode === 'pending') return <ScreensPending testId="screen-home-pending" />;
  if (mode === 'procedural') return <HomeScreen />;
  return (
    <Suspense fallback={<ScreensPending testId="screen-home-pending" />}>
      <ClassicHome />
    </Suspense>
  );
}

/** 判定中先进房（与 RoomScreen / ClassicRoomScreen 同参数；enterRoom 幂等，画面挂上后再调用直接返回） */
function useEnterWhilePending(code: string, pending: boolean): void {
  const client = useClient();
  const t = useTx();
  const tRef = useRef(t);
  tRef.current = t;
  const watch = new URLSearchParams(useSearch()).get('watch') === '1';
  useEffect(() => {
    if (!pending || !ROOM_CODE_RE.test(code)) return;
    void client.enterRoom(code, watch ? 'spectator' : 'player').then((r) => {
      // 失败留给画面挂上后再进一次时显示。改观战的提示：画面在进房完成后才挂上时，它那次调用是「已在房间里」，
      // 提示由这里补；画面挂上时进房还在进行中，两边拿到同一个结果、画面自己会提示——下一轮再看，避免重复
      if (!r.ok || !r.data.fellBack) return;
      const text = tRef.current('lobby:room.fellBackToSpectator');
      setTimeout(() => {
        const ui = useUiStore.getState();
        if (!ui.toasts.some((x) => x.text === text)) ui.toast(text, 'info', 5000);
      }, 0);
    });
  }, [client, code, watch, pending]);
}

export function SkinRoom({ code }: { code: string }): ReactNode {
  const mode = usePinnedScreens();
  const phase = useRoomStore((st) => (st.room?.code === code ? st.room.phase : null));
  const inGame = phase !== null && phase !== 'lobby';
  useScreensTheme(mode, inGame);
  useEnterWhilePending(code, mode === 'pending');
  // 对局中固定画面选择（大厅里随判定切换：改皮肤设置、门禁变化）；判定中已在对局 → 不等判定，用程序化外壳挂对局页
  // （外壳只差进场 Loading；对局页的经典 / 程序化布局由它自己的 useGameSkin 决定）
  const pinned = useRef<'classic' | 'procedural' | null>(null);
  if (!inGame) pinned.current = null;
  else if (pinned.current === null) pinned.current = mode === 'classic' ? 'classic' : 'procedural';
  const choice = pinned.current ?? mode;
  const gate = inGame ? null : <AccessGateHost />;
  if (choice === 'pending') {
    return (
      <>
        <ScreensPending testId="screen-room-loading" />
        {gate}
      </>
    );
  }
  const Screen = choice === 'classic' ? ClassicRoomScreen : RoomScreen;
  return (
    <>
      <Suspense fallback={<ScreensPending testId="screen-room-loading" />}>
        <Screen code={code} />
      </Suspense>
      {gate}
    </>
  );
}

export function SkinSolo(): ReactNode {
  // 单机页只是建房期间的载入画面：判定后不再换（换画面会再建一次房）
  const mode = usePinnedScreens({ downgrade: false });
  useScreensTheme(mode, false);
  if (mode === 'pending') return <ScreensPending testId="screen-solo-pending" />;
  return (
    <Suspense fallback={<ScreensPending testId="screen-solo-pending" />}>
      {mode === 'classic' ? <ClassicSolo /> : <SoloScreen />}
    </Suspense>
  );
}
