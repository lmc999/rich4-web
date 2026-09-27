/**
 * 截止时间计算（architecture §5.9；design/net.md §5.4）。纯函数，不持有定时器；GameRunner 负责调度。
 *
 * - deadlineAt = visibleAt + timeout × presetScale × timerScale，visibleAt = now + min(animMs, maxAnimMs) × animScale
 *   （动画不占用思考时间）。服务器定时器在 deadlineAt + NET_GRACE_MS 才触发。
 * - animMs 由 GameRunner 按房间演出节奏（RoomSettings.pacing：original 以原版 FLIC 原长为准，compact 为紧凑预算）
 *   用 estimateAnimMs(events, pacing) 算出；AI / 托管行动前等待的也是这批 animMs（AiDriver.delayMs）。
 * - TURN_MENU 链（budgetKey 相同）：deadline = max(上一个 deadline, visibleAt + MENU_CHAIN_MIN_S)，
 *   但不超过本回合首次可见时间 + MENU_TURN_CAP_S（上限随档位缩放）。
 * - MINIGAME：startsAt = visibleAt + 3s 倒计时；deadlineAt = startsAt + maxTicks × tickMs + 5s（票据公式）。
 *   计时档位对小游戏不生效（游戏本身有固定时长），off 档同样有截止时间。
 * - timerScale 只给测试缩短所有等待（倒计时、宽限、链下限与上限）；小游戏的游玩时长不缩放。
 */
import type { DecisionTimingClass } from '@rich4/shared/engine';
import { MINIGAME_TIMING, type MinigameId } from '@rich4/shared/minigames';
import {
  decisionTimeoutMs,
  MENU_CHAIN_MIN_S,
  MENU_TURN_CAP_S,
  MINIGAME_COUNTDOWN_MS,
  MINIGAME_GRACE_MS,
  NET_GRACE_MS,
  PRESET_SCALE,
  RELEASE_MIN_S,
  RESUME_MIN_S,
  type TimerPreset,
} from '@rich4/shared/net';

export interface TimingOptions {
  /** 所有等待时长的倍率（测试用 0.02）；生产为 1 */
  timerScale: number;
  /** 动画时长的倍率（测试用 0 表示不等动画）；生产为 1 */
  animScale: number;
  /** 计入截止时间的动画上限，防止异常长的批次拖住对局 */
  maxAnimMs: number;
}

export const DEFAULT_TIMING: Readonly<TimingOptions> = Object.freeze({
  timerScale: 1,
  animScale: 1,
  maxAnimMs: 60_000,
});

/** 同一 budgetKey 的计时链状态 */
export interface BudgetEntry {
  /** 本回合第一个决策可见的时间 */
  firstVisibleAt: number;
  /** 链上最后一个决策的截止时间 */
  lastDeadline: number;
}

/** 计入等待的动画时长 */
export function animDelayMs(animMs: number, o: TimingOptions): number {
  return Math.min(Math.max(0, animMs), o.maxAnimMs) * o.animScale;
}

/** 客户端播完这批动画的时间 */
export function visibleAt(now: number, animMs: number, o: TimingOptions): number {
  return now + animDelayMs(animMs, o);
}

export interface DeadlineInput {
  now: number;
  animMs: number;
  timing: Exclude<DecisionTimingClass, 'minigame'>;
  preset: TimerPreset;
  /** 同一 budgetKey 的上一个决策（没有则 null） */
  budget: BudgetEntry | null;
  /** 本决策是否带 budgetKey */
  chained: boolean;
}

export interface DeadlineResult {
  deadlineAt: number | null;
  /** 更新后的链状态（决策不带 budgetKey 或不限时时为 null） */
  budget: BudgetEntry | null;
}

export function computeDeadline(i: DeadlineInput, o: TimingOptions): DeadlineResult {
  const base = decisionTimeoutMs(i.timing, i.preset);
  if (base === null) return { deadlineAt: null, budget: null };
  const vis = visibleAt(i.now, i.animMs, o);
  if (i.chained && i.budget) {
    const scale = PRESET_SCALE[i.preset] ?? 1;
    const chainMin = vis + MENU_CHAIN_MIN_S * 1000 * o.timerScale;
    const cap = i.budget.firstVisibleAt + MENU_TURN_CAP_S * 1000 * scale * o.timerScale;
    const deadlineAt = Math.min(Math.max(i.budget.lastDeadline, chainMin), cap);
    return { deadlineAt, budget: { firstVisibleAt: i.budget.firstVisibleAt, lastDeadline: deadlineAt } };
  }
  const deadlineAt = vis + base * o.timerScale;
  return { deadlineAt, budget: i.chained ? { firstVisibleAt: vis, lastDeadline: deadlineAt } : null };
}

/**
 * 计时链整体平移 shiftMs（暂停恢复、解除托管把当前决策的截止时间往后挪时调用）：
 * 首次可见时间与上一个截止时间一起后移，保持「本回合上限 − 当前截止时间」不变，暂停与托管期间不消耗 90 秒整回合上限。
 */
export function shiftBudget(b: BudgetEntry, shiftMs: number): BudgetEntry {
  if (shiftMs <= 0) return b;
  return { firstVisibleAt: b.firstVisibleAt + shiftMs, lastDeadline: b.lastDeadline + shiftMs };
}

/** 小游戏窗口（写进 MinigameTicket） */
export function minigameWindow(
  now: number,
  animMs: number,
  id: MinigameId,
  o: TimingOptions,
): { startsAt: number; deadlineAt: number } {
  const t = MINIGAME_TIMING[id];
  const startsAt = visibleAt(now, animMs, o) + MINIGAME_COUNTDOWN_MS * o.timerScale;
  return { startsAt, deadlineAt: startsAt + t.maxTicks * t.tickMs + MINIGAME_GRACE_MS * o.timerScale };
}

/** 服务器定时器的触发时间（截止之后再给网络宽限） */
export function fireAt(deadlineAt: number, o: TimingOptions): number {
  return deadlineAt + NET_GRACE_MS * o.timerScale;
}

/** 暂停恢复：每个待决策至少剩 RESUME_MIN_S */
export function resumeDeadline(now: number, remainingMs: number, o: TimingOptions): number {
  return now + Math.max(remainingMs, RESUME_MIN_S * 1000 * o.timerScale);
}

/** 解除托管：给玩家至少 RELEASE_MIN_S；不限时仍为 null */
export function releaseDeadline(now: number, deadlineAt: number | null, o: TimingOptions): number | null {
  if (deadlineAt === null) return null;
  return now + Math.max(deadlineAt - now, RELEASE_MIN_S * 1000 * o.timerScale);
}

/** 断线宽限期内展示给所有人的截止时间：min(deadline, 断线时间 + 宽限) */
export function effectiveDeadline(
  deadlineAt: number | null,
  disconnectedAt: number | null,
  graceMs: number,
): number | null {
  if (disconnectedAt === null) return deadlineAt;
  const graceEnd = disconnectedAt + graceMs;
  return deadlineAt === null ? graceEnd : Math.min(deadlineAt, graceEnd);
}
