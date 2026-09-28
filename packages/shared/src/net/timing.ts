/**
 * 决策计时常量（architecture §5.9；design/net.md §5.4）。计时完全在服务器层，引擎里没有真实时间。
 *
 * deadlineAt = now + estimateAnimMs(rawEvents) × animScale + timeout × presetScale；服务器定时器在 deadlineAt + NET_GRACE_MS 才触发。
 * - TURN_MENU 链：与上一个决策 budgetKey 相同时，截止 = max(上一个 deadline, now + MENU_CHAIN_MIN_S)，但不超过本回合首次出现 + MENU_TURN_CAP_S。
 * - AUCTION_BID：每人独立计时，每次重新 ask 都重新计时。
 * - MINIGAME：deadlineAt = startsAt + maxTicks × tickMs + MINIGAME_GRACE_MS，startsAt = now + animMs + MINIGAME_COUNTDOWN_MS。
 */
import type { DecisionTimingClass } from '../engine/types/decision';
import type { SeatControl } from '../view/types';

/** 房间计时档位；off 不限时（断线托管照常生效） */
export type TimerPreset = 'fast' | 'normal' | 'slow' | 'off';

/**
 * 算作「真人座位」的控制方式（有效计时档位的判定，design/net.md §5.4）：真人在线、断线宽限中、各种托管
 * （manual / afk / disconnect：本人还在这局里，只是临时交给电脑）都算；电脑补位与被踢（ai）、对局中离开
 * （autopilot:left，由电脑接管到本人 room:resume 回来为止）不算。观战者不占座位，不影响判定。
 */
export function isHumanSeatControl(c: SeatControl): boolean {
  return c !== 'ai' && c !== 'autopilot:left';
}

/** 真人座位不超过这么多时不限时：只有一名真人、其余都是电脑的房间和单机（/solo 本来就是 off）一样 */
export const UNTIMED_MAX_HUMAN_SEATS = 1;

/**
 * 有效计时档位（服务器权威；GameRunner 按它计算截止时间，RoomView.effectiveTimerPreset 下发）：
 * 房间设置的档位，但真人座位 ≤ UNTIMED_MAX_HUMAN_SEATS 时为 off。房间设置本身不变（多名真人时仍按设置）。
 */
export function effectiveTimerPreset(preset: TimerPreset, humanSeats: number): TimerPreset {
  return humanSeats <= UNTIMED_MAX_HUMAN_SEATS ? 'off' : preset;
}

/** normal 档的超时（秒）；minigame 按票据计算 */
export const DECISION_TIMEOUT_S = Object.freeze({
  menu: 30,
  confirm: 15,
  pick: 20,
  shop: 30,
  bank: 20,
  auction: 15,
  lottery: 15,
} as const satisfies { readonly [C in Exclude<DecisionTimingClass, 'minigame'>]: number });

export const PRESET_SCALE = Object.freeze({
  fast: 0.5,
  normal: 1,
  slow: 2,
  off: null,
} as const satisfies { readonly [P in TimerPreset]: number | null });

/** 服务器定时器在 deadlineAt 之后再等这么久才触发 */
export const NET_GRACE_MS = 800;
/** TURN_MENU 链：新截止至少 now + 8s */
export const MENU_CHAIN_MIN_S = 8;
/** TURN_MENU 链：整回合不超过首次出现 + 90s */
export const MENU_TURN_CAP_S = 90;
/** 暂停恢复后每个待决策至少剩 5s */
export const RESUME_MIN_S = 5;
/** 解除托管后至少剩 10s */
export const RELEASE_MIN_S = 10;

/** 小游戏开局前的倒计时（期间显示操作说明与「跳过」） */
export const MINIGAME_COUNTDOWN_MS = 3000;
/** 小游戏截止的额外宽限 */
export const MINIGAME_GRACE_MS = 5000;

/** 连续超时多少次进入 autopilot:afk */
export const AFK_TIMEOUT_STREAK = 2;
/** 断线宽限默认值（RoomSettings.reconnectGraceSec） */
export const DEFAULT_RECONNECT_GRACE_S = 15;
/** 房间设置里断线宽限的取值范围（客户端补丁与读档后的设置都按它夹取；测试模式例外） */
export const RECONNECT_GRACE_MIN_S = 5;
export const RECONNECT_GRACE_MAX_S = 120;
/** 全员离线多久后自动存档并回收房间 */
export const ROOM_ABANDON_TTL_MIN = 30;

export type AiPace = 'normal' | 'fast';

/** AI 思考延迟区间（ms），在动画预算之后再加上 */
export const AI_THINK_MS = Object.freeze({
  normal: [400, 1200],
  fast: [150, 300],
} as const satisfies { readonly [P in AiPace]: readonly [number, number] });

/** AI 等待动画时的动画倍率（aiPace='fast' 时减半） */
export const AI_ANIM_SCALE = Object.freeze({ normal: 1, fast: 0.5 } as const satisfies {
  readonly [P in AiPace]: number;
});

/** 单个非小游戏决策的超时（ms）；off 档返回 null（不限时） */
export function decisionTimeoutMs(
  timing: Exclude<DecisionTimingClass, 'minigame'>,
  preset: TimerPreset,
): number | null {
  const scale = PRESET_SCALE[preset];
  if (scale === null) return null;
  return DECISION_TIMEOUT_S[timing] * scale * 1000;
}

/**
 * 演出节奏（original-skin.md U3；RoomSettings.pacing）：original 以原版 FLIC 原长为准、完整播放原版演出；
 * compact 用紧凑预算（原版 FLIC 加速或截取）。服务器按所选节奏的动画预算（shared/view/pacing 的 EVENT_BUDGET_MS）
 * 计算截止时间与 AI 等待。与 view/pacing 的同名类型相同（net 不能依赖 view/pacing，两处字面量由测试对齐）。
 */
export type PacingProfile = 'original' | 'compact';
export const PACING_PROFILES = Object.freeze(['original', 'compact'] as const) satisfies readonly PacingProfile[];
/** 新房间的默认节奏 */
export const DEFAULT_PACING: PacingProfile = 'original';
