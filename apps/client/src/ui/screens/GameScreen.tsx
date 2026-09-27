// 对局页（design/client.md §5.1 桌面布局 + §5.2 手机横屏紧凑右栏；竖屏阻断式旋转遮罩）：
// 棋盘（BoardCanvas，挂载一次）+ HUD（顶栏、玩家面板、玩家条、小地图、行动区、等待条、决策层、横幅、骰子、日志、聊天、菜单）。
// 地图按 view.dataRef 经 GET /api/maps/:id?h= 加载；决策倒计时的服务器时钟与棋盘桥由这里提供给对话框。
// 原版皮肤 A5：皮肤判定（useGameSkin：素材包、地图绑定、界面语言）决定棋盘用哪个渲染器；棋盘只经 BoardSurface 访问
// （镜头、旋转 0..7、锚点、视口框）；门禁页宿主挂在这里（素材包 401 时显示，门禁开启时定期续期 cookie）。
import type { SeatIndex } from '@rich4/shared/engine';
import type { RoomView } from '@rich4/shared/net';
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useClient } from '../../app/services';
import type { Insets } from '../../game/camera/Camera';
import type { Pt } from '../../game/iso/projection';
import { useTx } from '../../i18n/tx';
import { installMinigames } from '../../minigames';
import type { BoardControllerLike, BoardSurface, SurfaceRotation } from '../../skin/BoardSurface';
import { useGameSkin } from '../../skin/useGameSkin';
import { useConnectionStore } from '../../store/connectionStore';
import { currentSeat, useGameStore } from '../../store/gameStore';
import { mapKey, useMapStore } from '../../store/mapStore';
import { mySeat } from '../../store/roomStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useUiStore } from '../../store/uiStore';
import { AccessGateHost } from '../access/AccessGateHost';
import { DecisionClockProvider } from '../decisions/clock';
import { type BoardBridge, BoardBridgeContext } from '../decisions/targeting';
import { ActionPad } from '../hud/ActionPad';
import { DecisionLayer } from '../hud/DecisionLayer';
import { EventLogPanel } from '../hud/EventLogPanel';
import { GameOverPanel } from '../hud/GameOverPanel';
import h from '../hud/hud.module.css';
import { MiniMap } from '../hud/MiniMap';
import { DiceOverlay, PausedBanner, TurnBanner } from '../hud/Overlays';
import { PanelHost } from '../hud/PanelHost';
import { PlayerChips } from '../hud/PlayerChips';
import { PlayerPanel } from '../hud/PlayerPanel';
import { TopBar } from '../hud/TopBar';
import { WaitingBanner } from '../hud/WaitingBanner';
import { PopupLayer } from '../popups/PopupLayer';
import { ChatPanel } from '../social/ChatPanel';
import { SpectatorList } from '../social/SpectatorList';
import { RotateHint } from '../system/RotateHint';
import { SystemMenu } from '../system/SystemMenu';
import { BoardCanvas } from './BoardCanvas';

const ZERO: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/** 右栏、顶栏、底栏的实际尺寸 → 镜头 insets（窗口或布局变化时更新） */
function useHudInsets(
  top: React.RefObject<HTMLElement | null>,
  right: React.RefObject<HTMLElement | null>,
  bottom: React.RefObject<HTMLElement | null>,
): Insets {
  const [insets, setInsets] = useState<Insets>(ZERO);
  useLayoutEffect(() => {
    const measure = (): void => {
      const next: Insets = {
        top: top.current?.offsetHeight ?? 0,
        right: right.current?.offsetWidth ?? 0,
        bottom: bottom.current?.offsetHeight ?? 0,
        left: 0,
      };
      setInsets((cur) => (cur.top === next.top && cur.right === next.right && cur.bottom === next.bottom ? cur : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new ResizeObserver(measure);
    for (const r of [top, right, bottom]) if (r.current) ro.observe(r.current);
    return () => ro.disconnect();
  }, [top, right, bottom]);
  return insets;
}

export default function GameScreen({ room, onLeave }: { room: RoomView; onLeave(): void }): ReactNode {
  const t = useTx();
  const client = useClient();
  const view = useGameStore((s) => s.view);
  const offset = useConnectionStore((s) => s.clockOffsetMs);
  const chatOpen = useUiStore((s) => s.chatOpen);
  const logOpen = useUiStore((s) => s.logOpen);
  const leftHanded = useSettingsStore((s) => s.leftHanded);
  const mapId = view?.dataRef.mapId ?? null;
  const mapHash = view?.dataRef.mapHash ?? null;
  const entry = useMapStore((s) => (mapId && mapHash ? (s.entries[mapKey(mapId, mapHash)] ?? null) : null));
  const [ctrl, setCtrl] = useState<BoardControllerLike | null>(null);
  const [surface, setSurface] = useState<BoardSurface | null>(null);
  const [bridge, setBridge] = useState<BoardBridge | null>(null);
  const [rotation, setRotation] = useState<SurfaceRotation>(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const topRef = useRef<HTMLElement>(null);
  const rightRef = useRef<HTMLElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const insets = useHudInsets(topRef, rightRef, bottomRef);
  const skin = useGameSkin(entry?.def ?? null);

  useEffect(() => {
    if (!mapId || !mapHash) return;
    let stale = false;
    useMapStore
      .getState()
      .load(mapId, mapHash)
      .then(
        (idx) => !stale && client.setMap(idx),
        () => {},
      );
    return () => {
      stale = true;
    };
  }, [client, mapId, mapHash]);

  useEffect(() => () => client.setMap(null), [client]);

  // 小游戏：观战票据、输入帧与续玩都挂在传输层，进入对局页就安装（幂等；否则只有本人的 MinigameIntro 渲染时才装上，
  // 观战者与其他玩家收不到直播遮罩，刷新后服务器补发的自己的帧也会在安装前丢失）
  useEffect(() => {
    installMinigames(client);
  }, [client]);

  const onBoardReady = useCallback((c: BoardControllerLike | null, b: BoardBridge | null, s: BoardSurface | null) => {
    setCtrl(c);
    setBridge(b);
    setSurface(s);
    if (s) setRotation(s.rotation);
  }, []);

  const viewport = useCallback((): Pt[] | null => surface?.viewportCorners() ?? null, [surface]);

  const panTo = useCallback(
    (p: Pt) => {
      if (!surface) return;
      surface.camera.onUserGesture();
      void surface.camera.panTo(p, 400);
    },
    [surface],
  );

  const focusMe = useCallback(() => {
    if (!ctrl || !surface || !view) return;
    const seat = (mySeat(room) ?? currentSeat(view)) as SeatIndex | null;
    if (seat === null) return;
    const a = surface.anchorPos({ seat });
    if (a) void surface.camera.panTo(a, 400);
    ctrl.follow(seat);
  }, [ctrl, surface, view, room]);

  const rotate = (d: number): void => {
    if (!surface) return;
    setRotation(surface.rotate(d));
  };

  if (!view) {
    return (
      <main className={h.game} data-testid="screen-game">
        <p className={h.boardNote} role="status">
          {t('hud:board.waiting')}
        </p>
      </main>
    );
  }
  const map = entry?.index ?? null;

  return (
    <DecisionClockProvider offsetMs={offset}>
      <BoardBridgeContext.Provider value={bridge}>
        <main
          className={h.game}
          data-testid="screen-game"
          data-phase={room.phase}
          data-left={leftHanded ? 'true' : 'false'}
        >
          {entry?.def && map && !skin.waitForPack ? (
            <BoardCanvas
              def={entry.def}
              map={map}
              insets={insets}
              skin={skin.resolution.board}
              onReady={onBoardReady}
            />
          ) : (
            <div className={h.board}>
              <p className={h.boardNote} role="status">
                {entry?.status === 'error'
                  ? t('hud:board.error', { reason: entry.error ?? '' })
                  : t('hud:board.loadingMap')}
              </p>
            </div>
          )}
          <div className={h.topWrap} ref={topRef as React.RefObject<HTMLDivElement>}>
            <TopBar view={view} map={map} room={room} onMenu={() => setMenuOpen(true)} />
          </div>
          <aside className={h.right} ref={rightRef as React.RefObject<HTMLElement>}>
            <PlayerPanel view={view} room={room} />
            <PlayerChips view={view} room={room} />
            {map && (
              <div className={h.miniWrap}>
                <MiniMap view={view} map={map} rotation={rotation} viewport={viewport} onPan={panTo} />
                <div className={h.rotateBtns}>
                  <button
                    type="button"
                    className="btn btn--sm btn--cream"
                    onClick={() => rotate(-1)}
                    aria-label={t('hud:board.rotateLeft')}
                    data-testid="rotate-left"
                  >
                    ⟲
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm btn--cream"
                    onClick={() => rotate(1)}
                    aria-label={t('hud:board.rotateRight')}
                    data-testid="rotate-right"
                  >
                    ⟳
                  </button>
                </div>
              </div>
            )}
          </aside>
          <div className={h.bottom} ref={bottomRef}>
            <WaitingBanner view={view} room={room} map={map} />
            <ActionPad room={room} onFocusMe={focusMe} />
          </div>
          {(chatOpen || logOpen) && (
            <div className={h.dock}>
              {logOpen && <EventLogPanel />}
              {chatOpen && <ChatPanel room={room} className={h.dockChat} />}
              {chatOpen && <SpectatorList room={room} />}
            </div>
          )}
          <TurnBanner />
          <DiceOverlay />
          <PausedBanner room={room} />
          <PopupLayer map={map} />
          {map && <DecisionLayer view={view} map={map} room={room} />}
          {map && <PanelHost view={view} map={map} room={room} />}
          <GameOverPanel view={view} room={room} onLeave={onLeave} />
          <SystemMenu room={room} open={menuOpen} onOpenChange={setMenuOpen} onLeave={onLeave} />
          <RotateHint />
          <AccessGateHost renew />
        </main>
      </BoardBridgeContext.Provider>
    </DecisionClockProvider>
  );
}
