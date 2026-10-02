// 界面状态（design/client.md §10.1）：打开的面板、查看的玩家、镜头跟随、目标选择、toast、横幅、骰子、HUD 数字闪动。
// 事件演出（UiPresenter）与 HUD 组件通过它通信；对话框代理的面板可读 panel / targeting 决定显示内容。
import type { DiceCount, SeatIndex } from '@rich4/shared/engine';
import { create } from 'zustand';

/** 面板 id：cards/items/stock/board 由对话框代理的 ui/panels 实现；其余为 HUD 自带 */
export type PanelId = 'cards' | 'items' | 'stock' | 'board' | 'info' | 'log' | 'settings' | 'saves' | 'menu';

/** 回合菜单里要直接打开的子页（ActionPad 的卡片 / 道具 / 股票 / 公布栏按钮） */
export type MenuSheet = 'cards' | 'items' | 'stock' | 'board';

export type ToastKind = 'info' | 'success' | 'warn' | 'error';

export interface Toast {
  id: number;
  text: string;
  kind: ToastKind;
  /** 自动消失的毫秒数（真实时间） */
  ttl: number;
}

export type BannerKind = 'turn' | 'start' | 'bankrupt' | 'holiday' | 'gameOver' | 'info';

export interface Banner {
  id: number;
  kind: BannerKind;
  title: string;
  subtitle?: string;
  seat?: SeatIndex;
}

export interface DiceState {
  id: number;
  seat: SeatIndex;
  faces: number[];
  rolling: boolean;
  /** 骰子 FLC 每帧（ms，1x；原版按游戏速度取，见 shared/view 的 DICE_TIMING）；缺省按 FLC 头部 */
  frameMs?: number;
  /** 落定后的停留（ms，1x）：原版皮肤停留结束即收起骰子（起步时棋盘重画） */
  holdMs?: number;
  /** 骰子 FLC 画点的方向槽（原版表 0x4730ac 的下标）；null / 缺省用默认位置 */
  slot?: number | null;
  /** 掷骰的人在棋盘画布上的位置与镜头缩放（原版皮肤按它把 FLC 摆在人物头顶一带）；null / 缺省按人物在视窗中心 */
  at?: DiceAnchor | null;
  /**
   * 随时读取人物当前的画面位置（骰子显示期间镜头仍可能移动：手动拖动后 4 秒恢复跟随、窗口缩放）：原版皮肤逐帧读取，
   * 让骰子一直贴着人物；缺省只用 at
   */
  locate?: (() => DiceAnchor | null) | undefined;
}

/**
 * 掷骰的人在棋盘画布上的位置（BoardPort.actorScreen）：原版镜头每 tick 对准行动者、FLC 画点相对人物固定，
 * 我们的镜头与缩放不一定满足这个前提，所以骰子按人物实际的画面位置摆（ui/classic/layout 的 diceFlcPlacement）
 */
export interface DiceAnchor {
  /** 人物脚下锚点（boardPos）在棋盘画布上的坐标（CSS 像素） */
  x: number;
  y: number;
  /** 棋盘画布的尺寸（CSS 像素） */
  w: number;
  h: number;
  /** 镜头缩放：1 个棋盘源像素 = zoom 个画布 CSS 像素 */
  zoom: number;
}

export type StatField = 'cash' | 'deposit' | 'points';

export interface StatFlash {
  id: number;
  seat: SeatIndex;
  field: StatField;
  delta: number;
}

export interface UiState {
  panel: PanelId | null;
  /** PlayerPanel 查看的座位；null = 跟随当前行动者 */
  inspectSeat: SeatIndex | null;
  /** 镜头跟随的座位（观战者可切换）；null = 自动跟随当前行动者 */
  followSeat: SeatIndex | null;
  /** 画布内目标选择（对话框代理的 TargetPicker 使用，结构由其定义） */
  targeting: unknown;
  toasts: Toast[];
  banner: Banner | null;
  dice: DiceState | null;
  flashes: StatFlash[];
  chatOpen: boolean;
  logOpen: boolean;
  /**
   * 选中的骰子颗数（只在 diceChoiceScope 这个作用域里有效；null 或作用域变了 = 沿用 options.dice.current）。
   * 作用域是「本座位本回合、交通工具没换」：回合菜单里用卡、用道具、买卖股票后引擎换 decisionId 重发 TURN_MENU，选择照样有效；
   * 换车时引擎把 current 置为新上限，旧的选择不再压过它（见 DiceChoiceScope）
   */
  diceChoice: DiceCount | null;
  diceChoiceScope: DiceChoiceScope | null;
  /** 展开回合菜单时要直接打开的子页（TurnMenuDialog 打开后清空） */
  menuSheet: MenuSheet | null;
  /** 原版片头或开局飞行动画正在播放（音频导演层期间不放标题曲 / 棋盘曲） */
  introPlaying: boolean;
  openPanel(p: PanelId | null): void;
  /** 展开回合菜单并直接打开某个子页 */
  openMenu(sheet: MenuSheet | null): void;
  clearMenuSheet(): void;
  togglePanel(p: PanelId): void;
  setInspectSeat(s: SeatIndex | null): void;
  setFollowSeat(s: SeatIndex | null): void;
  setTargeting(t: unknown): void;
  toast(text: string, kind?: ToastKind, ttl?: number): number;
  dismissToast(id: number): void;
  showBanner(b: Omit<Banner, 'id'>): number;
  hideBanner(id?: number): void;
  setDice(d: Omit<DiceState, 'id'> | null): number;
  flash(seat: SeatIndex, field: StatField, delta: number): void;
  clearFlash(id: number): void;
  setChatOpen(b: boolean): void;
  setLogOpen(b: boolean): void;
  setDiceChoice(n: DiceCount | null, scope?: DiceChoiceScope | null): void;
  setIntroPlaying(b: boolean): void;
  /** 关闭所有临时演出（reset / skipAll） */
  closeTransient(): void;
  clear(): void;
}

export const TOAST_LIMIT = 5;
export const DEFAULT_TOAST_MS = 3200;

let seq = 0;

const initial = {
  panel: null,
  inspectSeat: null,
  followSeat: null,
  targeting: null,
  toasts: [] as Toast[],
  banner: null,
  dice: null,
  flashes: [] as StatFlash[],
  chatOpen: false,
  logOpen: false,
  diceChoice: null as DiceCount | null,
  diceChoiceScope: null as DiceChoiceScope | null,
  menuSheet: null as MenuSheet | null,
  introPlaying: false,
};

export const useUiStore = create<UiState>()((set, get) => ({
  ...initial,
  openPanel: (panel) => set(panel === 'menu' ? { panel } : { panel, menuSheet: null }),
  openMenu: (menuSheet) => set({ panel: 'menu', menuSheet }),
  clearMenuSheet: () => set({ menuSheet: null }),
  togglePanel: (p) => set({ panel: get().panel === p ? null : p }),
  setInspectSeat: (inspectSeat) => set({ inspectSeat }),
  setFollowSeat: (followSeat) => set({ followSeat }),
  setTargeting: (targeting) => set({ targeting }),
  toast: (text, kind = 'info', ttl = DEFAULT_TOAST_MS) => {
    const id = ++seq;
    set((s) => ({ toasts: [...s.toasts, { id, text, kind, ttl }].slice(-TOAST_LIMIT) }));
    return id;
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  showBanner: (b) => {
    const id = ++seq;
    set({ banner: { ...b, id } });
    return id;
  },
  hideBanner: (id) => {
    const cur = get().banner;
    if (cur && (id === undefined || cur.id === id)) set({ banner: null });
  },
  setDice: (d) => {
    if (d === null) {
      set({ dice: null });
      return 0;
    }
    const id = ++seq;
    set({ dice: { ...d, id } });
    return id;
  },
  flash: (seat, field, delta) => {
    if (delta === 0) return;
    const id = ++seq;
    set((s) => ({ flashes: [...s.flashes, { id, seat, field, delta }].slice(-12) }));
  },
  clearFlash: (id) => set((s) => ({ flashes: s.flashes.filter((f) => f.id !== id) })),
  setChatOpen: (chatOpen) => set({ chatOpen }),
  setLogOpen: (logOpen) => set({ logOpen }),
  setDiceChoice: (diceChoice, scope = null) => set({ diceChoice, diceChoiceScope: diceChoice === null ? null : scope }),
  setIntroPlaying: (introPlaying) => set({ introPlaying }),
  closeTransient: () => set({ banner: null, dice: null, flashes: [] }),
  clear: () => set({ ...initial, toasts: [], flashes: [] }),
}));

/**
 * 骰子颗数选择的作用域。原版把选中的颗数立刻写进玩家结构 +0x0A（点竖槽 fcn.00417623 0x417a68 / 0x417a9a，D 键
 * 0x4012c9–0x4012ff），之后用卡、用道具都不动它，只有换车时改写（机车 0x445a32 写 2、汽车 0x445aea 写 3）。我们的颗数随 ROLL
 * 提交、由引擎写回 p.diceCount（下一次的 current），所以选择只需在「本座位本回合、交通工具没换」时保留：
 * - 回合菜单里做一次非终结操作（用卡、用道具、买卖股票）后，引擎以新的 decisionId 重发 TURN_MENU（flow/turn.ts 'menu'），
 *   current 要到 ROLL 才写回，作用域不变，选择照样有效；
 * - 换车时引擎把 current 置为新上限（effects/items/vehicle.ts），上限或 current 变了，作用域随之不同，选择作废；
 * - 换了回合（turnNo）或座位也作废。
 */
export interface DiceChoiceScope {
  seat: SeatIndex;
  turnNo: number;
  /** 交通工具的上限（options.dice.allowed.length） */
  cap: number;
  /** 选择时引擎记着的颗数（options.dice.current） */
  current: DiceCount;
}

/** 本人的 TURN_MENU 对应的作用域；不是 TURN_MENU、没有骰子选项或还没有显示态时为 null */
export function diceScopeOf(
  turn: { seat: SeatIndex; options: { dice: { allowed: readonly DiceCount[]; current: DiceCount } } } | null,
  turnNo: number | null | undefined,
): DiceChoiceScope | null {
  if (turn === null || turnNo === null || turnNo === undefined) return null;
  const d = turn.options.dice;
  return { seat: turn.seat, turnNo, cap: d.allowed.length, current: d.current };
}

export function sameDiceScope(a: DiceChoiceScope | null, b: DiceChoiceScope | null): boolean {
  return (
    a !== null && b !== null && a.seat === b.seat && a.turnNo === b.turnNo && a.cap === b.cap && a.current === b.current
  );
}

/**
 * 本次 TURN_MENU 实际要掷的颗数：同一作用域里选过且仍被允许的颗数，否则引擎给的 current（上一次提交的颗数，换车时为新上限）
 */
export function chosenDice(
  s: Pick<UiState, 'diceChoice' | 'diceChoiceScope'>,
  scope: DiceChoiceScope | null,
  allowed: readonly DiceCount[],
  current: DiceCount | undefined,
): DiceCount {
  const c = s.diceChoice;
  return c !== null && sameDiceScope(s.diceChoiceScope, scope) && allowed.includes(c) ? c : (current ?? 1);
}
