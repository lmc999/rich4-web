/**
 * 落点码 6 / 7 / 8：企鹅挖宝、七彩气球、喜从天降（architecture §5.10；design/minigames-ai.md §2.1）。
 *
 * - 电脑座位（controller='ai'）或 config.minigames='skip'（= 原版关闭「動畫過程」）：直接走不玩分支，不产生决策。
 * - 真人座位（包括托管、超时，由服务器代答）：MINIGAME_STARTED + MINIGAME 决策；种子只写进 PendingDecision.minigame。
 *   允许的回答：MINIGAME_DECLINE（不玩分支）；系统 action MINIGAME_RESULT（裁判重放后的分数，点券 = score）。
 * - 不玩分支：score = 50 + rand15()%20，speechSlot = rand15()&1，恰好消耗 2 次 'minigameSkip'。@source v311:0x415457..0x4154bb
 * - 点券按 u16 饱和（原版是 add word 回绕，这里有意改为饱和，DEV-01）。
 * - 梦游者不触发（squares/index.settleSquare 已按梦游过滤特殊格）。
 *
 * 分层：engine 不能依赖 shared/minigames，所以各游戏的分数上限在这里另记一份（与 MinigameSpec.scoreSanityMax 相同，
 * 由 minigame.test.ts 对照）。
 */
import { ECON } from '../../data/tables/economy';
import { addU16 } from '../../util/int32';
import type { Ctx } from '../core/ctx';
import { EngineInvariantError, EngineRuleError } from '../errors';
import type { AskHandler } from '../flow/ask';
import type { PendingMinigame } from '../types/decision';
import type { FrameOf } from '../types/frames';
import type { MinigameId, SeatIndex } from '../types/ids';
import type { SystemAction } from '../types/intent';
import type { SquareHandler } from './index';

/** 服务器重放结果的防呆上限（= 各 sim 的 spec.scoreSanityMax） */
export const MINIGAME_SCORE_CAP: Readonly<Record<MinigameId, number>> = Object.freeze({
  penguin: 188,
  balloon: 65535,
  xicong: 999,
});

/** 决策 options 里的规则上限：只有企鹅有固定满分（188） */
export const MINIGAME_MAX_SCORE: Readonly<Record<MinigameId, number | null>> = Object.freeze({
  penguin: 188,
  balloon: null,
  xicong: null,
});

/**
 * 种子只取 31 位：Watcom rand 只输出状态的 16..30 位，bit31 永远不影响输出，只差 bit31 的两个种子局面完全相同。
 * 强制值（SYS_DEBUG forceNext minigameSeed）小于 2^31 时原样使用。
 */
export const MINIGAME_SEED_MASK = 0x7fffffff;

const PARAMS = Object.freeze({ ruleset: 'exe311' } as const);

function minigameOfKind(kind: string): MinigameId {
  if (kind === 'penguin' || kind === 'balloon' || kind === 'xicong') return kind;
  throw new EngineInvariantError('MINIGAME_KIND', `tile kind ${kind} is not a minigame`);
}

type AskFrame = FrameOf<'ASK'>;

function frameMinigame(f: AskFrame): MinigameId {
  const id = f.data.minigameId;
  if (typeof id !== 'string') throw new EngineInvariantError('ASK_DATA', 'ASK MINIGAME without minigameId');
  return minigameOfKind(id);
}

function frameSeed(f: AskFrame): number {
  const seed = f.data.seed;
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0) {
    throw new EngineInvariantError('ASK_DATA', 'ASK MINIGAME without seed');
  }
  return seed;
}

/** 不玩分支（电脑座位、skip 设置、托管 / 超时 / 主动跳过的 MINIGAME_DECLINE） */
export function settleSkipped(ctx: Ctx, seat: SeatIndex, id: MinigameId): void {
  const score = ECON.MINIGAME_SKIP_BASE + (ctx.rand15('minigameSkip') % ECON.MINIGAME_SKIP_RANGE);
  const speechSlot = (ctx.rand15('minigameSkip') & 1) as 0 | 1;
  const p = ctx.player(seat);
  p.points = addU16(p.points, score, 'saturate');
  ctx.emit('MINIGAME_ENDED', { seat, minigameId: id, mode: 'skipped', score, speechSlot });
}

/** 玩过的结算：score 先截断成整数并夹到 [0, 上限] */
export function settlePlayed(ctx: Ctx, seat: SeatIndex, id: MinigameId, rawScore: number): void {
  const cap = MINIGAME_SCORE_CAP[id];
  const t = Math.trunc(rawScore);
  const score = t > 0 ? (t > cap ? cap : t) : 0;
  const p = ctx.player(seat);
  p.points = addU16(p.points, score, 'saturate');
  ctx.emit('MINIGAME_ENDED', { seat, minigameId: id, mode: 'played', score, speechSlot: null });
}

export const minigameSquare: SquareHandler = (ctx, sq) => {
  const id = minigameOfKind(sq.tile.kind);
  const p = ctx.player(sq.seat);
  // 原版 who_plays≠1（非真人）或关闭「動畫過程」时直接走不玩分支（@source v311:0x41560d / 0x41561a）
  if (p.controller !== 'human' || ctx.s.config.minigames === 'skip') {
    settleSkipped(ctx, sq.seat, id);
    return;
  }
  const seed = ctx.next32('minigameSeed') & MINIGAME_SEED_MASK;
  ctx.emit('MINIGAME_STARTED', { seat: sq.seat, minigameId: id });
  ctx.push({ k: 'ASK', seat: sq.seat, kind: 'MINIGAME', data: { minigameId: id, seed }, stage: 'ask' });
};

/** ASK 帧的 MINIGAME 构造与回答（flow/ask.ts 注册） */
export const MINIGAME_ASK: AskHandler<'MINIGAME'> = {
  build(_ctx, f) {
    const minigameId = frameMinigame(f);
    const minigame: PendingMinigame = { minigameId, seed: frameSeed(f), params: { ...PARAMS } };
    return {
      options: { minigameId, maxScore: MINIGAME_MAX_SCORE[minigameId] },
      defaultIntent: { type: 'MINIGAME_DECLINE' },
      lot: null,
      amount: null,
      minigame,
    };
  },
  resolve(ctx, f, a) {
    if (a.type === 'MINIGAME_DECLINE') settleSkipped(ctx, f.seat, frameMinigame(f));
  },
};

/**
 * 系统 action MINIGAME_RESULT（core/system.ts 调用）：结束 MINIGAME 决策并按服务器重放的分数结算。
 * 之后由 executeAction 的 run 继续推进（ASK 帧已标记 done，随即出栈）。
 */
export function resolveMinigameResult(ctx: Ctx, a: Extract<SystemAction, { type: 'MINIGAME_RESULT' }>): void {
  const d = ctx.s.pending.find((p) => p.id === a.decisionId);
  if (!d) throw new EngineRuleError('STALE_DECISION', `decision ${String(a.decisionId)} is not pending`);
  if (d.seat !== a.seat) throw new EngineRuleError('NOT_YOUR_DECISION');
  if (d.kind !== 'MINIGAME' || d.minigame === null) throw new EngineRuleError('INTENT_NOT_ALLOWED');
  if (typeof a.score !== 'number' || !Number.isFinite(a.score) || !Number.isInteger(a.logHash)) {
    throw new EngineRuleError('BAD_ACTION', 'MINIGAME_RESULT needs a finite score and an integer logHash');
  }
  const f = ctx.findFrame(d.frameId);
  if (f?.k !== 'ASK' || f.kind !== 'MINIGAME') {
    throw new EngineInvariantError('PENDING_FRAME_MISSING', `frame ${d.frameId} for ${d.id}`);
  }
  ctx.clearPending(d.id);
  f.stage = 'done';
  settlePlayed(ctx, d.seat, d.minigame.minigameId, a.score);
}
