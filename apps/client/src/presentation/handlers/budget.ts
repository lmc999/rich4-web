// 客户端的演出预算（original-skin.md U3、§3 修正 1）：按当前房间的演出节奏（RoomSettings.pacing）取
// shared/view/pacing 的 EVENT_BUDGET_MS[profile]。服务器用同一张表计算截止时间，所以：
// - handler 包装（wrap.ts）把每个事件封顶在这个预算内，客户端永远不会比服务器的预算更慢；
// - EventPlayer 开发模式下按它告警超预算的 handler；
// - 原版皮肤的 playFit 按「预算 − 其他等待」安排 FLIC：original 节奏下能按原速播完，compact 节奏下加速或截取。
// 节奏在开局后不可改；还没有房间信息（测试、刚进房的瞬间）时按默认节奏。测试可以用 setPacingOverride 固定节奏。
import type { GameEvent } from '@rich4/shared/engine';
import { DEFAULT_PACING, eventBudgetMs, type PacingProfile } from '@rich4/shared/view';
import { useRoomStore } from '../../store/roomStore';

let override: PacingProfile | null = null;

/** 固定演出节奏（测试、开发工具用）；null 恢复为跟随房间设置 */
export function setPacingOverride(p: PacingProfile | null): void {
  override = p;
}

/** 当前房间的演出节奏 */
export function currentPacing(): PacingProfile {
  if (override !== null) return override;
  const room = useRoomStore.getState().room;
  const p = room?.settings.pacing;
  return p === 'original' || p === 'compact' ? p : DEFAULT_PACING;
}

/** 事件在当前节奏下的预算（ms）；profile 可显式指定 */
export function budgetMs(e: GameEvent, profile: PacingProfile = currentPacing()): number {
  return eventBudgetMs(e, profile);
}
