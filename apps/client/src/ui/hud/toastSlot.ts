// toast 的落点（Overlays 的 Toasts 读取）。缺省（null）在页面上部正中（hud.module.css .toasts）；原版皮肤的对局画面在
// 舞台缩小（手机横屏）时由经典舞台登记一块棋盘视窗以外的空位（ui/classic/layout 的 classicToastSlot），toast 改排在那里。
// 与 uiStore 分开放：落点跟着经典舞台的挂载与布局走，uiStore.clear()（进出房间）不能把它清掉。
import { create } from 'zustand';

/** 一块空位（视口坐标，CSS 像素） */
export interface ToastSlot {
  x: number;
  y: number;
  w: number;
  /** 空位的高：top 排法时是列表的最大高度，bottom 排法时是列表本身的高度 */
  h: number;
  /** top：从上缘往下排；bottom：贴下缘往上长。两种都是新的在下，放不下时截掉最旧的 */
  align: 'top' | 'bottom';
  /** 空位在哪（列表的 data-place；缺省位置为 page） */
  place: string;
}

interface ToastSlotState {
  slot: ToastSlot | null;
  owner: symbol | null;
  /** 登记或更新落点（null 等于撤销）；与现有的相同时不触发更新 */
  set(owner: symbol, slot: ToastSlot | null): void;
  /** 登记者卸载：只撤销自己登记的 */
  release(owner: symbol): void;
}

function same(a: ToastSlot | null, b: ToastSlot | null): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && a.align === b.align && a.place === b.place;
}

export const useToastSlot = create<ToastSlotState>()((set, get) => ({
  slot: null,
  owner: null,
  set: (owner, slot) => {
    const cur = get();
    if (slot === null) {
      if (cur.owner === owner) set({ slot: null, owner: null });
      return;
    }
    if (cur.owner === owner && same(cur.slot, slot)) return;
    set({ slot, owner });
  },
  release: (owner) => {
    if (get().owner === owner) set({ slot: null, owner: null });
  },
}));
