// 界面状态（design/client.md §10.1）：打开的面板、查看的玩家、镜头跟随、目标选择、toast、横幅、骰子、HUD 数字闪动。
// 事件演出（UiPresenter）与 HUD 组件通过它通信；对话框代理的面板可读 panel / targeting 决定显示内容。
import type { SeatIndex } from '@rich4/shared/engine';
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
  /** 选中的骰子颗数（TURN_MENU；null = 沿用 options.dice.current） */
  diceChoice: 1 | 2 | 3 | null;
  /** 展开回合菜单时要直接打开的子页（TurnMenuDialog 打开后清空） */
  menuSheet: MenuSheet | null;
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
  setDiceChoice(n: 1 | 2 | 3 | null): void;
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
  diceChoice: null,
  menuSheet: null as MenuSheet | null,
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
  setDiceChoice: (diceChoice) => set({ diceChoice }),
  closeTransient: () => set({ banner: null, dice: null, flashes: [] }),
  clear: () => set({ ...initial, toasts: [], flashes: [] }),
}));
