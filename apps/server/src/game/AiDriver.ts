/**
 * AI 调度与兜底（architecture §5.11；design/net.md §7；design/minigames-ai.md §9.10）。
 *
 * 同一个 AiDriver 服务四种情况：纯 AI 座位、托管、timeoutPolicy='ai' 的超时代决、小游戏 decline。
 * - AI 只拿到 projectState(state, {seat}) 的深拷贝与本座位的 DecisionForYou，看不到 secret。
 * - AI 的随机数按 (aiSeed, seat, decisionId) 或 (aiSeed, seat, turnNo, salt) 派生（Watcom LCG），
 *   不持久化 RNG 状态；AI 的决策作为 action 写进 journal，重放仍然确定。
 * - decide 抛异常，或 intent 不能通过 PlayerIntentSchema / ALLOWED_INTENTS，就退回 defaultIntent（fallback=true）。
 * 本文件不得引入 node:* 与 socket.io。
 */
import {
  type AiContext,
  type AiPolicy,
  type AiRng,
  aiRngFromSeed,
  type MakeAiContextParams,
  makeAiContext as sharedMakeAiContext,
} from '@rich4/shared/ai';
import type { MapIndex } from '@rich4/shared/data';
import {
  type GameState,
  isIntentAllowed,
  type PendingDecision,
  type PlayerIntent,
  PlayerIntentSchema,
} from '@rich4/shared/engine';
import { AI_ANIM_SCALE, AI_THINK_MS, type AiPace, type YourDecision } from '@rich4/shared/net';
import { type DecisionForYou, type GameView, type HandVisibility, projectState } from '@rich4/shared/view';
import type { Logger } from '../infra/logger';
import { animDelayMs, type TimingOptions } from './Deadlines';

/** AI 随机数与上下文的派生方式由 shared/ai 统一提供（模拟脚本、测试与服务器共用同一实现） */
export const makeAiRng: (seed: number) => AiRng = aiRngFromSeed;
export const makeAiContext: (p: MakeAiContextParams) => AiContext = sharedMakeAiContext;

/** 兜底策略：永远返回 defaultIntent（真实策略未注入时使用） */
export const defaultIntentPolicy: AiPolicy = Object.freeze({
  id: 'basic' as const,
  decide: (_view: GameView, d: DecisionForYou): PlayerIntent => d.defaultIntent,
});

export interface AiDecideInput {
  state: GameState;
  decision: PendingDecision;
  /** 本座位的 DecisionForYou（含截止时间与小游戏票据） */
  you: YourDecision;
  map: MapIndex;
  handVisibility: HandVisibility;
}

export type AiFallbackReason = 'threw' | 'schema' | 'notAllowed';

export interface AiDecideOutput {
  intent: PlayerIntent;
  fallback: AiFallbackReason | null;
  elapsedMs: number;
}

export interface AiDriverOptions {
  policy: AiPolicy;
  log: Logger;
  /** 计时用的毫秒时钟（只用于慢决策告警） */
  now?: () => number;
  /** [0,1) 随机数，只用于思考延迟 */
  random?: () => number;
  /** 覆盖思考延迟区间（测试用 [0,0]） */
  thinkMs?: Partial<Record<AiPace, readonly [number, number]>>;
  /** 超过这个耗时记 warn */
  slowMs?: number;
}

export class AiDriver {
  readonly policy: AiPolicy;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly thinkMs: Record<AiPace, readonly [number, number]>;
  private readonly slowMs: number;

  constructor(o: AiDriverOptions) {
    this.policy = o.policy;
    this.log = o.log;
    this.now = o.now ?? (() => Date.now());
    this.random = o.random ?? Math.random;
    this.thinkMs = { normal: o.thinkMs?.normal ?? AI_THINK_MS.normal, fast: o.thinkMs?.fast ?? AI_THINK_MS.fast };
    this.slowMs = o.slowMs ?? 50;
  }

  /**
   * delayMs = 剩余动画等待 + 思考时间；动画等待 = animMs × animScale × AI_ANIM_SCALE[pace]，
   * elapsedMs 为决策出现至今已过去的时间（中途接手时只等剩下的部分）。
   */
  delayMs(animMs: number, pace: AiPace, timing: TimingOptions, elapsedMs = 0): number {
    const anim = Math.max(0, animDelayMs(animMs, timing) * AI_ANIM_SCALE[pace] - Math.max(0, elapsedMs));
    const [lo, hi] = this.thinkMs[pace];
    return Math.max(0, Math.trunc(anim + lo + (hi - lo) * this.random()));
  }

  decide(i: AiDecideInput): AiDecideOutput {
    const seat = i.decision.seat;
    const player = i.state.players.find((p) => p.seat === seat);
    // 深拷贝：策略即使误改视图也不会碰到权威状态
    const view = structuredClone(projectState(i.state, { kind: 'seat', seat }, { handVisibility: i.handVisibility }));
    const ctx = makeAiContext({
      aiSeed: i.state.secret.aiSeed,
      seat,
      decisionId: i.decision.id,
      turnNo: i.state.clock.turnNo,
      traits: player ? { ...player.aiTraits } : AI_NEUTRAL_TRAITS,
      map: i.map,
      handVisibility: i.handVisibility,
    });
    const t0 = this.now();
    let raw: unknown;
    try {
      raw = this.policy.decide(view, structuredClone(i.you), ctx);
    } catch (err) {
      this.log.warn({ err, seat, kind: i.decision.kind, policy: this.policy.id }, 'ai decide threw');
      return { intent: i.decision.defaultIntent, fallback: 'threw', elapsedMs: this.now() - t0 };
    }
    const elapsedMs = this.now() - t0;
    if (elapsedMs > this.slowMs) {
      this.log.warn({ seat, kind: i.decision.kind, elapsedMs, policy: this.policy.id }, 'ai decide slow');
    }
    const parsed = PlayerIntentSchema.safeParse(raw);
    if (!parsed.success) {
      this.log.warn({ seat, kind: i.decision.kind, policy: this.policy.id }, 'ai intent failed schema');
      return { intent: i.decision.defaultIntent, fallback: 'schema', elapsedMs };
    }
    const intent = parsed.data as PlayerIntent;
    if (!isIntentAllowed(i.decision.kind, intent.type)) {
      this.log.warn({ seat, kind: i.decision.kind, type: intent.type }, 'ai intent not allowed');
      return { intent: i.decision.defaultIntent, fallback: 'notAllowed', elapsedMs };
    }
    return { intent, fallback: null, elapsedMs };
  }
}

const AI_NEUTRAL_TRAITS: AiContext['traits'] = Object.freeze({
  personality: 1,
  useCards: true,
  useItems: true,
  loanRatio: 0,
  cashRatio: 50,
  stockRatio: 0,
});
