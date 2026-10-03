// 原版皮肤的弹窗宿主（original-skin.md §4.2 通用；由 ui/popups/PopupLayer 在经典布局里懒加载挂载）：
// 1) 演出弹窗（popupStore）：新闻 → 新闻板、命运 → 命运板（Panel#66 图1 + 命运插图表 exe 0x473dd8 选的插图，加持另出
//    消息框）、神明 → 老虎机 / 神明消息框、终局 → 排名画面；出卡、被动卡、卡片格与聖誕節得卡 → 卡片插画 + 消息框（私密手牌下
//    别人的得卡只有消息框）；魔法屋点名与施法 → 宝石消息框（原版魔法屋的结果用通用消息框）；乐透开奖交给场所组的
//    ClassicLotteryDraw（venues/a）。每个弹窗按素材判定一次：
//    所需逻辑键全部就绪（sceneKeysStatus = ready）才用原版画面，否则整个弹窗用程序化版本（legacy），不半原版半程序化；
//    挂载时把这个判定登记给 handler（popupStore.opensClassic：原版亮卡不叠网页版的气泡、粒子与光束），正以原版画面显示的
//    弹窗记在 popupStore.classicShown（原版亮卡期间缺省位置的 toast 暂缓）；亮卡与命运板照原版任意鼠标键 / 按键放开就结束
//    （anyInputSkips；原版亮卡 fcn.00450f9a、命运板 fcn.00452c39 都没有最短时间）；新闻板、命运板盖着工具列，板面上接住
//    指针、暂停经典快捷键（boardShield），点板子不会点到下面看不见的工具列钮；
// 2) 事件后演出：轮盘、月结颁奖（./eventPopups，监听显示态日志）；
// 3) 工具列打开的原版界面：资产表（工具列「查询」→ uiStore 打开 info 面板时改开原版资产表）、托管设置
//    （openTrusteeSettings → 改开原版托管对话框）、存读档（工具列 LOAD / SAVE 经 ./screenRequests 请求 → 原版风格的 Data#479 窗）。
//    素材不可用时不接管，照旧打开程序化面板 / 对话框；精灵还在加载时等它就绪（有上限）再开原版界面。
//    开原版界面时收起系统菜单（closeSystemMenu）：菜单是挂在 body 上的模态框，盖在经典舞台之上，托管设置又是从菜单里
//    打开的——不收起的话原版托管画面被菜单挡住、点不到（程序化对话框同样挂在 body 上，照旧叠在菜单之上）。
// 挂载时（空闲时）预取这些弹窗与界面的精灵，演出出现时通常已就绪；亮卡要用的消息框图集页（ui.common）与新闻 / 命运板的
// 图集页（ui.newsBoard）直接下载位图，再低优先级逐张预取 30 张卡片插画（手牌里看得到的在前）、本图会用到的命运插图与
// 36 张新闻插图：亮卡只停 1.2–1.5 秒、命运板 1.6–3.8 秒，插画或板面要是等弹窗出现才下载，慢网络下整段都是空框、字浮在
// 棋盘上（出卡人、别的玩家、观战者都一样）。
import type { MapIndex } from '@rich4/shared/data';
import { CARD_IDS, type CardId, type SeatIndex } from '@rich4/shared/engine';
import type { GameView } from '@rich4/shared/view';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { currentSeat, useGameStore } from '../../../store/gameStore';
import { mySeat, useRoomStore } from '../../../store/roomStore';
import { useUiStore } from '../../../store/uiStore';
import { LotteryDrawPopup } from '../../popups/LotteryDrawPopup';
import { type OpenPopup, type PopupSpec, registerClassicPopupProbe, usePopupStore } from '../../popups/popupStore';
import { closeSystemMenu } from '../../system/SystemMenu';
import { useTrusteeDialog } from '../../system/TrusteeSettings';
import { preloadClassicImage, preloadSpritePages, useClassicAssets } from '../assets';
import { ensureSceneSprite, prepareSceneKeys, sceneKeysStatus, scenePackClient } from '../common/sceneAssets';
import { cardArtKey } from '../dialogs/parts';
import { ClassicLotteryDraw } from '../venues/a/LotteryDraw';
import { ASSETS_KEYS, AssetSheet } from './AssetSheet';
import { CardCast } from './CardCast';
import { EventPopupLayer, useEventPopupWatcher } from './eventPopups';
import { FateBlessingBox, FateBoard, fateSlotOf } from './FateBoard';
import { GodPopup } from './GodPopup';
import {
  ASSETS_SHEET,
  AUTOPLAY_SHEET,
  COMMON_SHEET,
  FACE_SHEET,
  FATE_BOARD,
  fateArtKey,
  MONTHLY_SHEET,
  NEWS_BOARD,
  NEWS_SHEET,
  newsArtKey,
  SAVELOAD_SHEET,
  SLOT_SHEET,
  WHEELS,
} from './layout';
import { MagicBox } from './MagicBox';
import { NewsBoard } from './NewsBoard';
import { PopupScene, type SceneRect } from './PopupScene';
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

/** 卡片插画的预取顺序：显示态里看得到的手牌在前（去重，按持有顺序），其余按卡号 */
export function cardArtPrefetchOrder(view: GameView | null): CardId[] {
  const seen = new Set<CardId>();
  for (const p of view?.players ?? []) for (const c of p.cards ?? []) seen.add(c);
  return [...seen, ...CARD_IDS.filter((c) => !seen.has(c))];
}

/** 同时在下载的卡片插画张数（后台预取，不和棋盘素材抢带宽） */
export const CARD_ART_PREFETCH_CONCURRENCY = 2;

/** 按顺序低优先级预取整图（alive 为 false 时停下，同时 CARD_ART_PREFETCH_CONCURRENCY 张）；素材包里没有的键跳过 */
export async function prefetchImageKeys(keys: readonly string[], alive: () => boolean): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (alive() && next < keys.length) {
      const key = keys[next++]!;
      await preloadClassicImage(key);
    }
  };
  await Promise.all(Array.from({ length: CARD_ART_PREFETCH_CONCURRENCY }, worker));
}

/** 按顺序预取卡片插画（alive 为 false 时停下）；素材包里没有的键跳过 */
export async function prefetchCardArt(cards: readonly CardId[], alive: () => boolean): Promise<void> {
  await prefetchImageKeys(
    cards.map((c) => cardArtKey(c)),
    alive,
  );
}

/** 第 33 条起的命运按地图换插图（与 presentation/eventText 的 FATE_BY_MAP_FROM 相同） */
const FATE_BY_MAP_FROM = 33;
const FATE_COUNT = 37;

/**
 * 这张地图会用到的命运插图键（去重，按命运编号）：k < 33 用表[k]，33–36 用表[k + 4·gm]（gm 不是 1–3 时按台湾）。
 * 慢网络下命运板要是等弹窗出现才下载插图，板上的白框会空一阵。
 */
export function fateArtPrefetchKeys(globalMapId: number | null | undefined): string[] {
  const gm = globalMapId === 1 || globalMapId === 2 || globalMapId === 3 ? globalMapId : 0;
  const out = new Set<string>();
  for (let k = 0; k < FATE_COUNT; k++) out.add(fateArtKey(k < FATE_BY_MAP_FROM ? k : k + 4 * gm));
  return [...out];
}

/** 36 张新闻插图的键 */
export const NEWS_ART_KEYS: readonly string[] = Object.freeze(Array.from({ length: 36 }, (_, i) => newsArtKey(i)));

/** 演出弹窗所需的逻辑键；没有原版画面的种类返回 null（用程序化弹窗） */
export function popupKeys(p: PopupSpec): string[] | null {
  switch (p.kind) {
    case 'news':
      return [NEWS_SHEET, newsArtKey(p.id)];
    case 'fate':
      // 命运板：Panel#66 图1 + 插图表 0x473dd8 选的插图（表情头像只是点缀，加载中先不画，不进判定）；
      // 加持段只有通用消息框
      return p.phase === 'blessing' ? [COMMON_SHEET] : [NEWS_SHEET, fateArtKey(fateSlotOf(p))];
    case 'god':
      return p.slot ? [SLOT_SHEET, COMMON_SHEET] : [COMMON_SHEET, ASSETS_SHEET];
    case 'gameOver':
      return [MONTHLY_SHEET];
    case 'cardCast':
      // 私密手牌下别人的得卡没有卡号：只有消息框
      return p.card === null ? [COMMON_SHEET] : [COMMON_SHEET, cardArtKey(p.card)];
    case 'magic':
      return [COMMON_SHEET];
    default:
      return null;
  }
}

/** 这个弹窗能否用原版画面（按当前素材同步判定；也登记给 handler 用，见 popupStore 的 opensClassic） */
export function classicPopupReady(p: PopupSpec): boolean {
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
    case 'fate':
      return p.phase === 'blessing' ? <FateBlessingBox spec={p} /> : <FateBoard spec={p} />;
    case 'magic':
      return <MagicBox spec={p} />;
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

/**
 * 整块盖住工具列与棋盘视窗的板子（新闻板、命运板，440×480 贴舞台 (0,0)）：板面上接住指针、暂停经典快捷键
 * （PopupScene 的 shield）。命运的加持消息框、亮卡、魔法屋消息框都在棋盘视窗里（y ≥ 48），不盖工具列，照旧只听不拦
 */
export function boardShield(p: PopupSpec): SceneRect | undefined {
  if (p.kind === 'news') return { x: 0, y: 0, w: NEWS_BOARD.w, h: NEWS_BOARD.h };
  if (p.kind === 'fate' && p.phase !== 'blessing') return { x: 0, y: 0, w: FATE_BOARD.w, h: FATE_BOARD.h };
  return undefined;
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
  // 登记「正以原版画面显示」（原版亮卡期间缺省位置的 toast 暂缓，见 popupStore.classicShown）；布局阶段登记，toast 不会与亮卡同框一帧
  const { popupId, kind } = p;
  useLayoutEffect(() => {
    if (!classic || kind === 'lottery') return;
    usePopupStore.getState().setClassicShown({ popupId, kind });
    return () => {
      if (usePopupStore.getState().classicShown?.popupId === popupId) usePopupStore.getState().setClassicShown(null);
    };
  }, [classic, popupId, kind]);
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
  // 场景的无障碍标签：新闻用标题，其余种类都有 title（乐透在上面已分流）
  const title = p.kind === 'news' ? p.headline : p.title;
  return (
    <PopupScene
      kind={p.kind}
      label={title}
      minMs={p.minMs}
      onSkip={() => usePopupStore.getState().skip(p.popupId)}
      anyInputSkips={p.kind === 'cardCast' || p.kind === 'fate'}
      shield={boardShield(p)}
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
    /** 开原版界面（先收起盖在舞台之上的系统菜单） */
    const show = (s: Exclude<Screen, null>): void => {
      closeSystemMenu();
      setScreen(s);
    };
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
        () => show({ k: 'assets', seat }),
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
        () => show({ k: 'trustee' }),
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
      show({ k: 'saves', mode: req.mode });
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
  // 预取命运插图时按当前地图（33–36 按图换图）；地图晚到不重跑预取
  const mapRef = useRef(map);
  mapRef.current = map;
  useEventPopupWatcher(map);
  // handler 打开弹窗之前据此判断会不会用原版画面（原版亮卡时不叠网页版的气泡、粒子与光束）
  useEffect(() => registerClassicPopupProbe(classicPopupReady), []);

  // 空闲时预取弹窗与界面的精灵（素材包里没有的键跳过），再逐张预取卡片插画
  useEffect(() => {
    if (packId === null) return;
    let live = true;
    const run = (): void => {
      if (!live) return;
      const client = scenePackClient();
      if (!client) return;
      for (const key of CLASSIC_POPUP_SPRITES) if (client.usableEntry(key)) void ensureSceneSprite(key, client);
      // 亮卡的宝石消息框（ui.common）与新闻 / 命运板（ui.newsBoard）的图集页先下，再低优先级逐张下卡片插画、
      // 本图的命运插图与新闻插图
      for (const key of [COMMON_SHEET, NEWS_SHEET]) {
        if (!client.usableEntry(key)) continue;
        void ensureSceneSprite(key, client).then((sheet) => {
          if (live && sheet) void preloadSpritePages(sheet);
        });
      }
      const gm = mapRef.current?.def.globalMapId ?? null;
      void prefetchCardArt(cardArtPrefetchOrder(useGameStore.getState().view), () => live).then(() =>
        prefetchImageKeys([...fateArtPrefetchKeys(gm), ...NEWS_ART_KEYS], () => live),
      );
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
