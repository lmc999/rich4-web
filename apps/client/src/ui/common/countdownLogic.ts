// 画面中央的决策倒计时（本人决策、有截止时间时）：显示条件、剩余整秒、定时器对齐、提示音去重——纯函数与小状态机，不碰 DOM。
// 截止时间来自服务器（已扣掉这批动画的预算，见 shared/view/pacing 与 server/game/Deadlines），剩余时间按 time:ping 校准的
// 服务器时钟计算；显示剩余整秒（向上取整）。最后 COUNTDOWN_URGENT_S 秒每跨过一个整秒响一次「嘀」，最后 COUNTDOWN_FINAL_S 秒
// 换成更高的双响；同一截止时间下每个整秒最多一声（回合菜单重发决策换了 decisionId、截止时间没变时也不重响），
// 定时器被后台节流后回来也只响当前这一秒，不补播积压的；断线期间（重连遮罩挡住画面）不显示、不响。
import type { DecisionKind } from '@rich4/shared/engine';
import type { YourDecision } from '@rich4/shared/net';
import { isAutopilot, type SeatControl } from '@rich4/shared/view';
import type { ConnStatus } from '../../net/transport';

/** 进入最后这么多秒：数字变红、脉动、每秒一声「嘀」 */
export const COUNTDOWN_URGENT_S = 10;
/** 最后这么多秒：提示音换成更高的双响 */
export const COUNTDOWN_FINAL_S = 3;

/** 提示音档位：tick 单响、final 高音双响 */
export type BeepLevel = 'tick' | 'final';

/** 中央倒计时跟随的决策 */
export interface CountdownTarget {
  decisionId: string;
  kind: DecisionKind;
  /** 服务器时间戳（ms） */
  deadlineAt: number;
}

/**
 * 连接是否在线：只有 open 算（idle 为还没连过——单测、预览，也算）。重连中、已断开、断开后重新连接中都不算：
 * 断线时 gameStore.decision 不会被清掉，但重连遮罩已挡住画面、玩家什么都做不了，服务器给别人看的截止时间也换成了
 * min(截止时间, 断线时刻 + 宽限)；重连后 resetTo 带回新的决策与截止时间再重新计时。
 */
export function countdownOnline(status: ConnStatus): boolean {
  return status === 'open' || status === 'idle';
}

/**
 * 中央倒计时跟随哪个决策：本人的（观战者与别人的决策不会出现在 gameStore.decision 里）、有截止时间（不限时与暂停中为 null）、
 * 还没提交（gameStore.submitting，client.act 发出时立即设置）、本人没在托管（托管时由电脑代决，决策框只读）、
 * 不是小游戏（小游戏开局有自己的 3 秒倒计时与游玩计时）、连接在线（countdownOnline；断线期间不显示、不响）。
 * control 为本人座位的控制方式（观战者传 null）。
 */
export function countdownTarget(
  decision: YourDecision | null,
  submitting: string | null,
  control: SeatControl | null,
  online = true,
): CountdownTarget | null {
  if (!decision || control === null || !online) return null;
  if (decision.deadlineAt === null) return null;
  if (decision.kind === 'MINIGAME') return null;
  if (submitting === decision.decisionId) return null;
  if (control === 'ai' || isAutopilot(control)) return null;
  return { decisionId: decision.decisionId, kind: decision.kind, deadlineAt: decision.deadlineAt };
}

/** 剩余整秒（向上取整；到点或已过为 0） */
export function secsLeft(remainingMs: number): number {
  return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
}

/**
 * 距离显示的整秒数下一次变化还有多久（ms）：剩余 7.3 秒显示 8，0.3 秒后变成 7。定时器按它对齐到整秒边界，
 * 数字与提示音在跨秒的那一刻更新（而不是每 250ms 轮询时才跟上）。结果至少 1ms。
 */
export function msToNextSecond(remainingMs: number): number {
  if (remainingMs <= 0) return 1;
  const s = secsLeft(remainingMs);
  return Math.max(1, Math.round(remainingMs - (s - 1) * 1000));
}

/** 这一秒该响哪一档（不在最后 10 秒、或已到点时为 null） */
export function beepLevelFor(secs: number): BeepLevel | null {
  if (secs <= 0 || secs > COUNTDOWN_URGENT_S) return null;
  return secs <= COUNTDOWN_FINAL_S ? 'final' : 'tick';
}

/**
 * 去重键：只看截止时间（服务器时间戳），不带 decisionId——键相同就是同一条时间轴上的同一批整秒。回合菜单里做不结束回合
 * 的操作（用卡、买股票…）后，服务器用新的 decisionId 重发 TURN_MENU，截止时间常常不变（server/game/Deadlines 的
 * computeDeadline 取 max(上一个截止时间, 可见时间 + 8 秒)），这时沿用已响记录，同一秒不会因为换了 decisionId 再响一次；
 * 截止时间真正变了（暂停恢复、解除托管、链被延长）才重新计。每页只有本人一个座位的决策，不用再带座位。
 */
export function beepKey(t: CountdownTarget): string {
  return `@${t.deadlineAt}`;
}

/**
 * 提示音闸门：同一个键（截止时间）下每个整秒最多放行一次。时钟偏移重新校准可能让显示的秒数回跳一格，
 * 回跳后再跨过同一秒也不会重复响。换了键就重新计。
 */
export class BeepGate {
  private key = '';
  private readonly done = new Set<number>();

  /** 这一秒要不要响、响哪一档；放行后记下，同一秒再问返回 null */
  take(key: string, secs: number): BeepLevel | null {
    if (key !== this.key) {
      this.key = key;
      this.done.clear();
    }
    const level = beepLevelFor(secs);
    if (level === null || this.done.has(secs)) return null;
    this.done.add(secs);
    return level;
  }

  reset(): void {
    this.key = '';
    this.done.clear();
  }
}
