// 原版皮肤的弹窗宿主（original-skin.md §4.2 通用；由 ui/popups/PopupLayer 在经典布局里懒加载挂载）：
// 1) 演出弹窗（popupStore）：新闻 → 新闻板、神明 → 老虎机 / 神明消息框、终局 → 排名画面；命运沿用程序化弹窗（命运插图
//    Data#436–475 与各条命运的对应未核实，guess 整体回退）；
//    出卡 → 卡片插画 + 消息框；乐透开奖交给场所组的 ClassicLotteryDraw（venues/a）；魔法屋沿用程序化弹窗（原版魔法屋
//    属于场所组）。每个弹窗按素材判定一次：
//    所需逻辑键全部就绪（sceneKeysStatus = ready）才用原版画面，否则整个弹窗用程序化版本（legacy），不半原版半程序化；
// 2) 事件后演出：轮盘、月结颁奖（./eventPopups，监听显示态日志）；
// 3) 工具列打开的原版界面：资产表（工具列「查询」→ uiStore 打开 info 面板时改开原版资产表）、托管设置
//    （openTrusteeSettings → 改开原版托管对话框）、存读档（工具列 LOAD / SAVE 经 ./screenRequests 请求 → 原版风格的 Data#479 窗）。
//    素材不可用时不接管，照旧打开程序化面板 / 对话框；精灵还在加载时等它就绪（有上限）再开原版界面。
// 挂载时（空闲时）预取这些弹窗与界面的精灵，演出出现时通常已就绪。
import type { MapIndex } from '@rich4/shared/data';
import type { SeatIndex } from '@rich4/shared/engine';
import { type ReactNode, useEffect, useState } from 'react';
import { currentSeat, useGameStore } from '../../../store/gameStore';
import { mySeat, useRoomStore } from '../../../store/roomStore';
import { useUiStore } from '../../../store/uiStore';
import { LotteryDrawPopup } from '../../popups/LotteryDrawPopup';
import { type OpenPopup, usePopupStore } from '../../popups/popupStore';
import { useTrusteeDialog } from '../../system/TrusteeSettings';
import { useClassicAssets } from '../assets';
import { ensureSceneSprite, prepareSceneKeys, sceneKeysStatus, scenePackClient } from '../common/sceneAssets';
import { ClassicLotteryDraw } from '../venues/a/LotteryDraw';
import { ASSETS_KEYS, AssetSheet } from './AssetSheet';
import { CardCast } from './CardCast';
import { EventPopupLayer, useEventPopupWatcher } from './eventPopups';
import { GodPopup } from './GodPopup';
import {
  ASSETS_SHEET,
  AUTOPLAY_SHEET,
  COMMON_SHEET,
  FACE_SHEET,
  MONTHLY_SHEET,
  NEWS_SHEET,
  newsArtKey,
  SAVELOAD_SHEET,
  SLOT_SHEET,
  WHEELS,
} from './layout';
import { NewsBoard } from './NewsBoard';
import { PopupScene } from './PopupScene';
import { Ranking } from './Ranking';
import { SAVELOAD_KEYS, type SaveLoadMode, SaveLoadScreen } from './SaveLoadScreen';
import { registerClassicScreenHandler } from './screenRequests';
import { TRUSTEE_KEYS, TrusteeScreen } from './TrusteeScreen';

/** 预取的精灵（弹窗与界面） */
export const CLASSIC_POPUP_SPRITES = [
  NEWS_SHEET,
  SLOT_SHEET,
  COMMON_SHEET,
  FACE_SHEET,
  ...Object.values(WHEELS).map((w) => w.key),
  MONTHLY_SHEET,
  ASSETS_SHEET,
  AUTOPLAY_SHEET,
  'ui.itemIcons',
  SAVELOAD_SHEET,
] as const;

/** 演出弹窗所需的逻辑键；没有原版画面的种类返回 null（用程序化弹窗） */
export function popupKeys(p: OpenPopup): string[] | null {
  switch (p.kind) {
    case 'news':
      return [NEWS_SHEET, newsArtKey(p.id)];
    case 'fate':
      // 命运插图（Data#436–475，illustration.fate.*）与 37 条命运的对应未核实（catalog 置信度 guess）：
      // 按「guess 整体回退」走程序化命运弹窗，不在原版紫板上拼程序化插图。核实后再接原版命运板。
      return null;
    case 'god':
      return p.slot ? [SLOT_SHEET, COMMON_SHEET] : [COMMON_SHEET, ASSETS_SHEET];
    case 'gameOver':
      return [MONTHLY_SHEET];
    case 'cardCast':
      return [COMMON_SHEET, `card.${p.card}`];
    default:
      return null;
  }
}

/** 这个弹窗能否用原版画面（按当前素材同步判定） */
export function classicPopupReady(p: OpenPopup): boolean {
  const keys = popupKeys(p);
  if (!keys) return false;
  return sceneKeysStatus(keys, scenePackClient()) === 'ready';
}

function ClassicPopupBody({ p }: { p: OpenPopup }): ReactNode {
  switch (p.kind) {
    case 'news':
      return <NewsBoard spec={p} ms={p.realMs} />;
    case 'god':
      return <GodPopup spec={p} ms={p.realMs} />;
    case 'cardCast':
      return <CardCast spec={p} />;
    case 'gameOver':
      return (
        <Ranking
          rows={p.rows.map((r) => ({
            seat: r.seat,
            character: r.character,
            name: r.name,
            rank: r.rank,
            netWorth: r.netWorth,
            alive: r.alive,
          }))}
          title={p.title}
          subtitle={p.subtitle}
          testId="game-over-screen"
          rowTestId={(rank) => `over-rank-${rank}`}
        />
      );
    default:
      return null;
  }
}

function PopupSwitch({ p, legacy }: { p: OpenPopup; legacy: LegacyPopup }): ReactNode {
  // 按弹窗判定一次：同一个弹窗不在原版与程序化之间来回切换
  const [classic] = useState(() => classicPopupReady(p));
  useEffect(() => {
    if (classic) return;
    const keys = popupKeys(p);
    // 这次来不及（素材还在加载）：先准备好，下一个同类弹窗就用原版画面
    if (keys) void prepareSceneKeys(keys, scenePackClient());
  }, [classic, p]);
  // 乐透开奖：原版画面属于场所组（venues/a 的 ClassicLotteryDraw 自己判定素材，不可用时画程序化弹窗）
  if (p.kind === 'lottery') {
    return (
      <>
        {legacy(
          p,
          <ClassicLotteryDraw
            spec={p}
            ms={p.realMs}
            minMs={p.minMs}
            onSkip={() => usePopupStore.getState().skip(p.popupId)}
            fallback={<LotteryDrawPopup spec={p} ms={p.realMs} />}
          />,
        )}
      </>
    );
  }
  if (!classic) return <>{legacy(p)}</>;
  const title =
    p.kind === 'news'
      ? p.headline
      : p.kind === 'fate'
        ? p.title
        : p.kind === 'god'
          ? p.title
          : p.kind === 'gameOver'
            ? p.title
            : p.kind;
  return (
    <PopupScene
      kind={p.kind}
      label={title}
      minMs={p.minMs}
      onSkip={() => usePopupStore.getState().skip(p.popupId)}
      backdrop={p.kind === 'gameOver' ? 'opaque' : 'none'}
    >
      <ClassicPopupBody p={p} />
    </PopupScene>
  );
}

type Screen = null | { k: 'assets'; seat: SeatIndex } | { k: 'trustee' } | { k: 'saves'; mode: SaveLoadMode };

/** 接管时精灵还在加载（开局后空闲预取没完成）：最多等这么久，就绪开原版界面，否则照旧开程序化面板 */
export const SCREEN_PREPARE_MS = 3000;

function prepareWithin(keys: readonly string[], ms: number): Promise<boolean> {
  return Promise.race([
    prepareSceneKeys(keys, scenePackClient()),
    new Promise<boolean>((r) => setTimeout(() => r(false), ms)),
  ]);
}

/**
 * 工具列打开的原版界面（接管 uiStore 的 info 面板与托管设置对话框）。素材不可用时不接管；素材可用但精灵还在加载时
 * 先收起程序化面板、等精灵就绪（最多 SCREEN_PREPARE_MS）再开原版界面——同一局里按早按晚打开的都是同一种画面，
 * 等不到才照旧打开程序化面板（此时不再接管）。
 */
function ClassicScreens({ map }: { map: MapIndex | null }): ReactNode {
  const [screen, setScreen] = useState<Screen>(null);
  const view = useGameStore((s) => s.view);
  const room = useRoomStore((s) => s.room);

  useEffect(() => {
    let live = true;
    const status = (keys: readonly string[]) => sceneKeysStatus(keys, scenePackClient());
    const ready = (keys: readonly string[]): boolean => status(keys) === 'ready';
    /** 接管：就绪 → 立即开；加载中 → 等待后开，等不到调用 fallback（重新打开程序化面板，这一次不接管） */
    const takeOver = (keys: readonly string[], open: () => void, fallback: () => void): void => {
      if (status(keys) === 'ready') {
        open();
        return;
      }
      void prepareWithin(keys, SCREEN_PREPARE_MS).then((ok) => {
        if (!live) return;
        if (ok) open();
        else fallback();
      });
    };
    let bypassInfo = false;
    let bypassTrustee = false;
    const offUi = useUiStore.subscribe((st, prev) => {
      if (st.panel !== 'info' || prev.panel === 'info') return;
      if (bypassInfo) {
        bypassInfo = false;
        return;
      }
      if (status(ASSETS_KEYS) === 'missing') return;
      const g = useGameStore.getState();
      const r = useRoomStore.getState().room;
      const seat = (st.inspectSeat ??
        (r ? mySeat(r) : null) ??
        (g.view ? currentSeat(g.view) : null) ??
        0) as SeatIndex;
      // 在 React 渲染之前（store 通知是同步的）把面板关掉，程序化的查看面板不会出现
      useUiStore.getState().openPanel(null);
      takeOver(
        ASSETS_KEYS,
        () => setScreen({ k: 'assets', seat }),
        () => {
          bypassInfo = true;
          useUiStore.getState().openPanel('info');
        },
      );
    });
    const offTrustee = useTrusteeDialog.subscribe((st, prev) => {
      if (!st.open || prev.open) return;
      if (bypassTrustee) {
        bypassTrustee = false;
        return;
      }
      if (status(TRUSTEE_KEYS) === 'missing') return;
      const r = useRoomStore.getState().room;
      if (!r || mySeat(r) === null || r.phase === 'lobby') return;
      useTrusteeDialog.getState().setOpen(false);
      takeOver(
        TRUSTEE_KEYS,
        () => setScreen({ k: 'trustee' }),
        () => {
          bypassTrustee = true;
          useTrusteeDialog.getState().setOpen(true);
        },
      );
    });
    // 工具列的 LOAD / SAVE 钮：经典外壳先经 requestClassicScreen 问这里（./screenRequests），素材就绪就开原版风格的窗，
    // 否则返回 false，由外壳照旧开程序化存读档窗
    const offSaves = registerClassicScreenHandler((req) => {
      if (req.k !== 'saves' || !ready(SAVELOAD_KEYS)) return false;
      const r = useRoomStore.getState().room;
      if (!r || mySeat(r) === null) return false;
      setScreen({ k: 'saves', mode: req.mode });
      return true;
    });
    return () => {
      live = false;
      offUi();
      offTrustee();
      offSaves();
    };
  }, []);

  if (!screen) return null;
  const close = (): void => setScreen(null);
  if (screen.k === 'assets') {
    if (!view) return null;
    return <AssetSheet view={view} map={map} seat={screen.seat} onClose={close} />;
  }
  if (!room) return null;
  if (screen.k === 'saves') return <SaveLoadScreen key={screen.mode} mode={screen.mode} room={room} onClose={close} />;
  return <TrusteeScreen room={room} onClose={close} />;
}

/** 程序化弹窗层（body 给出时替换弹窗内容） */
export type LegacyPopup = (p: OpenPopup, body?: ReactNode) => ReactNode;

export interface ClassicPopupHostProps {
  current: OpenPopup | null;
  map: MapIndex | null;
  /** 程序化弹窗（素材不可用或没有原版画面的种类） */
  legacy: LegacyPopup;
}

export default function ClassicPopupHost({ current, map, legacy }: ClassicPopupHostProps): ReactNode {
  const packId = useClassicAssets((s) => s.packId);
  useEventPopupWatcher(map);

  // 空闲时预取弹窗与界面的精灵（素材包里没有的键跳过）
  useEffect(() => {
    if (packId === null) return;
    let live = true;
    const run = (): void => {
      if (!live) return;
      const client = scenePackClient();
      if (!client) return;
      for (const key of CLASSIC_POPUP_SPRITES) if (client.usableEntry(key)) void ensureSceneSprite(key, client);
    };
    const w = window as Window & { requestIdleCallback?: (cb: () => void) => number };
    if (w.requestIdleCallback) w.requestIdleCallback(run);
    else setTimeout(run, 800);
    return () => {
      live = false;
    };
  }, [packId]);

  return (
    <>
      {current && <PopupSwitch key={current.popupId} p={current} legacy={legacy} />}
      <EventPopupLayer />
      <ClassicScreens map={map} />
    </>
  );
}
