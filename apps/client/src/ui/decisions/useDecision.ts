// 决策控制器：倒计时、提交后锁定、超时锁定、只读态（design/client.md §5.3「发出 intent 后立即锁定按钮，等 ack 或下一批事件」）。
// 锁有两层：组件内的 sentRef（挡同一帧连点）与全局的 gameStore.submitting（client.act 设置，直到换成新决策）。
// 批次播放期间保留的旧决策（REISSUED_KINDS）已经提交过，组件卸载重建后本地锁丢失，靠全局锁保持锁定。
import {
  type DecisionKind,
  isDecisionKind,
  isIntentAllowed,
  type PlayerIntent,
  PlayerIntentSchema,
} from '@rich4/shared/engine';
import { useCallback, useRef, useState } from 'react';
import { useGameStore } from '../../store/gameStore';
import { useRemainingMs } from '../components/Countdown';
import { useServerNow } from './clock';
import type { DecisionProps, SubmitOutcome } from './types';

export interface DecisionController {
  /** 可以操作：是自己的决策、未提交、未超时 */
  interactive: boolean;
  /** 已提交，等待服务器 */
  locked: boolean;
  /** 已过截止时间（服务器随后按 defaultIntent 代决） */
  expired: boolean;
  remainingMs: number | null;
  totalMs: number | null;
  /**
   * 提交 intent；被忽略（只读、已锁定、已超时）时返回 false。
   * onResult：submit 返回 Promise 时在 ack 后回调（被拒或 reject 为 false）；非 Promise 视为已发出，立即回调 true。
   */
  send(intent: PlayerIntent, onResult?: (ok: boolean) => void): boolean;
}

function failed(r: unknown): boolean {
  return r === false || (typeof r === 'object' && r !== null && (r as { ok?: unknown }).ok === false);
}

function isThenable(r: unknown): r is PromiseLike<SubmitOutcome> {
  return typeof r === 'object' && r !== null && typeof (r as { then?: unknown }).then === 'function';
}

/** 开发期检查：intent 结构合法且属于本决策允许的类型（不合法照样发送，由服务器 nack） */
function devCheck(kind: DecisionKind, intent: PlayerIntent): void {
  if (!import.meta.env.DEV) return;
  const r = PlayerIntentSchema.safeParse(intent);
  if (!r.success) console.warn('[decision] intent 结构不合法', intent, r.error.issues);
  if (isDecisionKind(kind) && !isIntentAllowed(kind, intent.type))
    console.warn(`[decision] ${kind} 不允许 ${intent.type}`);
}

export function useDecision<K extends DecisionKind>(p: DecisionProps<K>): DecisionController {
  const { decision, isMine, submit } = p;
  const now = useServerNow(p.now);
  const { remainingMs, totalMs } = useRemainingMs(decision.deadlineAt, now, decision.decisionId);
  const [sentId, setSentId] = useState<string | null>(null);
  // ref 挡住同一帧内的连点（state 要等下一次渲染才生效）
  const sentRef = useRef<string | null>(null);
  const id = decision.decisionId;
  const storeLocked = useGameStore((s) => s.submitting === id);
  const locked = sentId === id || storeLocked;
  const expired = remainingMs !== null && remainingMs <= 0;

  const send = useCallback(
    (intent: PlayerIntent, onResult?: (ok: boolean) => void): boolean => {
      if (!isMine) return false;
      if (sentRef.current === id || useGameStore.getState().submitting === id) return false;
      if (decision.deadlineAt !== null && now() >= decision.deadlineAt) return false;
      sentRef.current = id;
      setSentId(id);
      devCheck(decision.kind, intent);
      const unlock = (): void => {
        if (sentRef.current !== id) return;
        sentRef.current = null;
        setSentId((cur) => (cur === id ? null : cur));
      };
      let r: unknown;
      try {
        r = submit(intent);
      } catch (e) {
        unlock();
        throw e;
      }
      if (isThenable(r)) {
        r.then(
          (v) => {
            const bad = failed(v);
            if (bad) unlock();
            onResult?.(!bad);
          },
          () => {
            unlock();
            onResult?.(false);
          },
        );
      } else onResult?.(!failed(r));
      return true;
    },
    [isMine, id, decision.deadlineAt, decision.kind, now, submit],
  );

  return {
    interactive: isMine && !locked && !expired,
    locked,
    expired,
    remainingMs,
    totalMs,
    send,
  };
}
