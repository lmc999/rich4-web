// 路线 A 外壳（original-skin.md §4.1、§5 A10）：原版皮肤下的对局页布局——640×480 经典舞台（工具列、棋盘视窗、
// 个人资料栏、日历 / 缩小地图、GO 钮与骰子）+ 两侧联机侧栏（窄屏收成抽屉）。
// 与程序化布局共用同一套 store、决策层（DecisionLayer 暂时叠在棋盘视窗上方，原版风格对话框在 A11）、演出层
// （PopupLayer、横幅）与面板（PanelHost）；棋盘由 GameScreen 建好传进来（BoardCanvas），系统菜单与门禁宿主由 GameScreen
// 挂在两种布局之外（切换布局时不重建）。
import type { MapIndex } from '@rich4/shared/data';
import type { RoomView } from '@rich4/shared/net';
import { type GameView, isAutopilot } from '@rich4/shared/view';
import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useClient } from '../../app/services';
import type { Pt } from '../../game/iso/projection';
import { useTx } from '../../i18n/tx';
import { formatDate } from '../../presentation/names';
import type { BoardSurface, SurfaceRotation } from '../../skin/BoardSurface';
import { currentPackClient } from '../../skin/skinStore';
import { ORIGINAL_FONT_STACK } from '../../skin/theme';
import { useGameStore } from '../../store/gameStore';
import { mySeat } from '../../store/roomStore';
import { type PanelId, useUiStore } from '../../store/uiStore';
import { Modal } from '../components/Modal';
import { DecisionLayer } from '../hud/DecisionLayer';
import { GameOverPanel } from '../hud/GameOverPanel';
import { PausedBanner, TurnBanner } from '../hud/Overlays';
import { PanelHost } from '../hud/PanelHost';
import { AuctionBanner } from '../popups/AuctionBanner';
import { PopupLayer } from '../popups/PopupLayer';
import { RotateHint } from '../system/RotateHint';
import { SaveLoadMenu } from '../system/SaveLoadMenu';
import { openTrusteeSettings } from '../system/TrusteeSettings';
import { bindClassicAssets } from './assets';
import { CalendarPanel } from './CalendarPanel';
import { ClassicDice } from './ClassicDice';
import { ClassicStage, useClassicBox } from './ClassicStage';
import c from './classic.module.css';
import { GoButton, useRollControl } from './GoButton';
import { ensureClassicI18n } from './i18n';
import { useClassicHotkeys } from './keyboard';
import { ProfilePanel } from './ProfilePanel';
import { LeftRail, RailStatus, RightRail, useUnreadChat } from './SideRails';
import { Toolbar, type ToolId } from './Toolbar';

export interface ClassicLayoutProps {
  room: RoomView;
  view: GameView;
  map: MapIndex | null;
  /** 棋盘（BoardCanvas 或加载提示），放进棋盘视窗 */
  board: ReactNode;
  surface: BoardSurface | null;
  rotation: SurfaceRotation;
  onRotate(dir: number): void;
  onFocusMe(): void;
  onPan(p: Pt): void;
  viewport(): Pt[] | null;
  /** 打开系统菜单（菜单本身由 GameScreen 挂载，两种布局共用） */
  onOpenMenu(): void;
  onLeave(): void;
  /** 当前素材包（原版皮肤判定的 packId；null 时全部回退画法） */
  packId: string | null;
  /** 测试：固定舞台容器尺寸 */
  size?: { w: number; h: number };
}

/** 地块归属（visually-hidden；E2E 比对四个页面的归属，与程序化小地图的列表同形） */
function LotsList({ view }: { view: GameView }): ReactNode {
  const t = useTx();
  const all = useMemo(
    () => [
      ...view.lands.map((l) => ({ id: l.id, owner: l.owner, level: l.level })),
      ...view.facilities.map((f) => ({ id: f.id, owner: f.owner, level: f.level })),
    ],
    [view.lands, view.facilities],
  );
  return (
    <ul className={c.srOnly} data-testid="hud-lots">
      {all.map((l) => (
        <li key={l.id} data-lot={l.id} data-owner={l.owner ?? ''} data-level={l.level}>
          {l.id}: {l.owner === null ? t('hud:mini.unowned') : t('hud:mini.owner', { n: l.owner + 1 })} Lv{l.level}
        </li>
      ))}
    </ul>
  );
}

/**
 * 演出弹窗放进棋盘视窗叠层的下部并按视窗缩放：原版 FLIC（神明降临、警车救护车、爆炸……）在视窗中央播放，
 * 与之同时出现的弹窗（神明附身等）不再把它整个挡住；手机横屏（叠层为整个舞台）时缩小。
 */
function ClassicPopups({ map }: { map: MapIndex | null }): ReactNode {
  const box = useClassicBox();
  let scale = 1;
  if (box) {
    const w = box.board.w >= 420 ? box.board.w : box.stage.w;
    const h = box.board.w >= 420 ? box.board.h : box.scale * 440;
    scale = Math.min(1, Math.max(0.5, Math.min(w / 600, h / 520)));
  }
  return <PopupLayer map={map} placement="board" scale={Math.round(scale * 100) / 100} auction={false} />;
}

function ClassicHelp({ open, onOpenChange }: { open: boolean; onOpenChange(o: boolean): void }): ReactNode {
  const t = useTx();
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={t('classic:help.title')} width={480} testId="classic-help">
      <p>{t('classic:help.intro')}</p>
      <h3>{t('classic:help.keys')}</h3>
      <ul>
        <li>{t('classic:help.space')}</li>
        <li>{t('classic:help.dice')}</li>
        <li>{t('classic:help.rotate')}</li>
        <li>{t('classic:help.map')}</li>
      </ul>
      <p>{t('classic:help.tabs')}</p>
    </Modal>
  );
}

export function ClassicLayout({
  room,
  view,
  map,
  board,
  surface,
  rotation,
  onRotate,
  onFocusMe,
  onPan,
  viewport,
  onOpenMenu,
  onLeave,
  packId,
  size,
}: ClassicLayoutProps): ReactNode {
  // 文案命名空间要在子组件渲染前登记（幂等）
  ensureClassicI18n();
  const t = useTx();
  const client = useClient();
  const panel = useUiStore((s) => s.panel);
  const decision = useGameStore((s) => s.decision);
  const date = view.clock.date;
  const unread = useUnreadChat();
  const ctl = useRollControl(room);
  const [helpOpen, setHelpOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState<'load' | 'save' | null>(null);
  const [bigMap, setBigMap] = useState(false);
  const zoomBefore = useRef<number | null>(null);
  const me = mySeat(room);
  const spectator = me === null;
  const control = me === null ? 'human' : (room.seats[me]?.control ?? 'human');
  const auto = isAutopilot(control);
  const live = room.phase === 'playing' || room.phase === 'paused';

  // 布局阶段绑定（先于子组件的 effect：GO 钮取掩膜、日历取插画时素材包已绑定）
  useLayoutEffect(() => {
    bindClassicAssets(currentPackClient(), packId);
  }, [packId]);

  // 换了棋盘（重建）就不再处于大地图状态
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只随棋盘表面变化
  useEffect(() => {
    setBigMap(false);
    zoomBefore.current = null;
  }, [surface]);

  const toggleBigMap = (): void => {
    if (!surface) return;
    const cam = surface.camera;
    if (!bigMap) {
      zoomBefore.current = cam.zoom;
      cam.onUserGesture();
      void cam.fitAll(400);
      setBigMap(true);
    } else {
      const z = zoomBefore.current;
      zoomBefore.current = null;
      if (z !== null) void cam.zoomTo(z, 400);
      onFocusMe();
      setBigMap(false);
    }
  };

  const openPanel = (p: PanelId): void => {
    // 本人回合：展开回合菜单并直接打开对应子页（与程序化行动区一致）
    const turn = decision?.kind === 'TURN_MENU';
    if (turn && (p === 'cards' || p === 'items' || p === 'stock' || p === 'board')) {
      useUiStore.getState().openMenu(p);
      return;
    }
    useUiStore.getState().openPanel(panel === p ? null : p);
  };

  const onTool = (id: ToolId): void => {
    switch (id) {
      case 'help':
        setHelpOpen(true);
        return;
      case 'settings':
        onOpenMenu();
        return;
      case 'autopilot':
        if (!spectator) void client.autopilot(!auto);
        return;
      case 'load':
      case 'save':
        setSaveOpen(id);
        return;
      case 'bigMap':
        toggleBigMap();
        return;
      case 'info':
      case 'items':
      case 'cards':
      case 'board':
      case 'stock':
        openPanel(id);
        return;
    }
  };

  useClassicHotkeys({
    roll: ctl.roll,
    cycleDice: ctl.cycleDice,
    rotate: (d) => onRotate(d),
    bigMap: toggleBigMap,
  });

  // 面板类工具钮的按下态（aria-pressed）：对应的查看面板开着。本人回合时这几个钮打开的是回合菜单的子页
  // （子页请求由决策层立即取走，不留在 store 里），那时按下态不亮
  const panelTool: Partial<Record<ToolId, boolean>> = {
    info: panel === 'info',
    items: panel === 'items',
    cards: panel === 'cards',
    board: panel === 'board',
    stock: panel === 'stock',
    bigMap,
  };
  const disabled: Partial<Record<ToolId, boolean>> = spectator
    ? { autopilot: true, items: true, cards: true, board: true, stock: true, save: true, load: true }
    : { autopilot: !live };

  return (
    <main
      className={c.root}
      // 字体栈与原版主题同一份（skin/theme 的 ORIGINAL_FONT_STACK）
      style={{ '--classic-font': ORIGINAL_FONT_STACK } as CSSProperties}
      data-testid="screen-game"
      data-layout="classic"
      data-phase={room.phase}
    >
      <ClassicStage
        size={size}
        leftLabel={t('classic:rail.left')}
        rightLabel={t('classic:rail.right')}
        rightBadge={unread}
        board={board}
        front={
          <>
            {/* 工具列画在棋盘画布之上的舞台层：触控热区可以向下补到 44px（伸进棋盘视窗顶边） */}
            <Toolbar
              onTool={onTool}
              onAutopilotSettings={() => {
                if (!spectator && live) openTrusteeSettings();
              }}
              pressed={panelTool}
              disabled={disabled}
              autopilotOn={auto}
            />
            <GoButton ctl={ctl} />
            <ClassicDice />
          </>
        }
        status={<RailStatus room={room} view={view} map={map} />}
        overlay={
          <>
            <TurnBanner />
            <PausedBanner room={room} />
            <ClassicPopups map={map} />
            {map && <DecisionLayer view={view} map={map} room={room} />}
          </>
        }
        left={({ width, mode }) => (
          <LeftRail
            room={room}
            view={view}
            map={map}
            width={width}
            onFocusMe={onFocusMe}
            showStatus={mode === 'full'}
          />
        )}
        right={({ visible }) => <RightRail room={room} visible={visible} />}
      >
        <ProfilePanel view={view} room={room} map={map} />
        <CalendarPanel
          view={view}
          map={map}
          rotation={rotation}
          viewport={viewport}
          onPan={onPan}
          onRotate={(d) => onRotate(d)}
        />
      </ClassicStage>
      <LotsList view={view} />
      <AuctionBanner map={map} />
      {map && <PanelHost view={view} map={map} room={room} />}
      <GameOverPanel view={view} room={room} onLeave={onLeave} />
      <ClassicHelp open={helpOpen} onOpenChange={setHelpOpen} />
      <Modal
        open={saveOpen !== null}
        onOpenChange={(o) => !o && setSaveOpen(null)}
        title={saveOpen === 'load' ? t('classic:tool.load') : t('classic:tool.save')}
        width={560}
        testId="classic-saves"
      >
        {saveOpen === 'load' && (
          // 对局中不能读档（读档要在大厅由房主进行）：这里只列出存档（可导出），不放存档表单
          <p className={c.loadNote} data-testid="classic-load-note">
            {t('classic:tool.loadNote')}
          </p>
        )}
        {saveOpen !== null && (
          <SaveLoadMenu
            mode="game"
            isHost={room.you.isHost}
            defaultName={date ? formatDate(date) : ''}
            saveForm={saveOpen === 'save'}
          />
        )}
      </Modal>
      <RotateHint />
    </main>
  );
}
