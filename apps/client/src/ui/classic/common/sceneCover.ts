// 铺满整个舞台的原版场景登记（Stage4x3 背板为 opaque / dim 的模态场景：银行、百货、乐透、股市、魔法屋、拍卖、监狱医院、
// 资产、公布栏、存读档、托管设置…）。画面中央的决策倒计时（ui/classic/ClassicCountdown）据此避让：这类场景盖住整个舞台，
// 棋盘视窗中线与上缘都可能是场景内容，倒计时的小牌改放到场景登记的位置（场景坐标，小牌上缘中点）。位置由场景决定：
// 缺省是舞台顶端中线 STAGE_BADGE_TOP——Stage4x3 状态条（等待 X… / 已提交 / 时间到）的位置，本人的决策在倒计时显示期间
// 不会出现状态条；画满舞台的场景（银行、百货、乐透、监狱医院、资产）顶端正中是背景画。顶端正中有内容、或场景只画在中间
// 一块的，自己挑空处（Stage4x3 的 countdownBadgeAt）：股市放到自己的圆环左边、拍卖放到价格牌右边、魔法屋避开画里的
// 「1998」字样、公布栏放在工具列与软木板之间（选资产的表格时挪到表格左边）、托管设置与存档窗放在工具列与窗口上缘之间
// （读档窗口几乎顶满舞台，贴舞台顶端）。
// 进出场动画可能重叠：按登记顺序记，取最后登记的那个（新开的场景在上面）。
import { useLayoutEffect } from 'react';
import { create } from 'zustand';

/** 小牌位置：场景坐标（640×480），小牌上缘中点 */
export interface StageBadgeAt {
  x: number;
  y: number;
}

/** 缺省位置：舞台顶端中线（场景状态条的位置） */
export const STAGE_BADGE_TOP: StageBadgeAt = { x: 320, y: 2 };

interface SceneCoverState {
  /** 当前打开着的铺满舞台的场景登记的小牌位置（按登记顺序） */
  covers: readonly { id: number; at: StageBadgeAt }[];
  /** 登记一个场景，返回注销函数（重复调用无害） */
  add(at?: StageBadgeAt): () => void;
}

let nextId = 1;

export const useSceneCoverStore = create<SceneCoverState>()((set) => ({
  covers: [],
  add: (at = STAGE_BADGE_TOP) => {
    const id = nextId++;
    set((s) => ({ covers: [...s.covers, { id, at }] }));
    return () => set((s) => (s.covers.some((c) => c.id === id) ? { covers: s.covers.filter((c) => c.id !== id) } : s));
  },
}));

/**
 * 场景在 at 不为 null 期间登记为「铺满舞台」，倒计时小牌摆到 at。在布局阶段登记（场景挂上的同一帧就换位置，
 * 不会先在棋盘视窗上缘闪一下）
 */
export function useFullStageCover(at: StageBadgeAt | null): void {
  const x = at?.x ?? null;
  const y = at?.y ?? null;
  useLayoutEffect(() => {
    if (x === null || y === null) return;
    return useSceneCoverStore.getState().add({ x, y });
  }, [x, y]);
}

/** 最后登记的铺满舞台的场景要的小牌位置；没有场景开着为 null */
export function useStageBadgeAt(): StageBadgeAt | null {
  return useSceneCoverStore((s) => s.covers.at(-1)?.at ?? null);
}
