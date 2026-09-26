/**
 * 显式帧栈解释器（design/engine.md §6.2）。
 *
 * - FRAME_HANDLERS 对 FrameKind 穷举（satisfies）；M1 未实现的帧注册为抛 NOT_IMPLEMENTED 的占位（flow/stubs.ts）。
 * - run：没有待决策且对局进行中就不断推进栈顶帧；演员已出局的帧直接丢弃（TURN 除外，由它自己转入 end）；
 *   设守卫上限，防止死循环。
 * - executeAction：校验顺序为 pending 是否存在（STALE_DECISION）→ seat 是否匹配（NOT_YOUR_DECISION）
 *   → ALLOWED_INTENTS（INTENT_NOT_ALLOWED）→ intent 结构（BAD_ACTION）；系统 action 另走 handleSystem。
 *   然后 run、补 SYNC、action 计数 +1。
 */
import { isIntentAllowed } from '../decisions/allowed';
import { EngineInvariantError, EngineRuleError } from '../errors';
import { ASK } from '../flow/ask';
import { BANKRUPT } from '../flow/bankruptcy';
import { DAY } from '../flow/day';
import { LAND } from '../flow/land';
import { MOVE } from '../flow/move';
import { PAYX } from '../flow/pay';
import { ROOT } from '../flow/root';
import {
  AUCTION,
  BANK,
  CARD,
  CONFINE,
  FATE,
  FEE,
  GOD,
  ITEM,
  MAGIC,
  NEWS,
  SHOP,
  SURRENDER,
  VILLAIN,
} from '../flow/stubs';
import { TOLL } from '../flow/toll';
import { TURN } from '../flow/turn';
import type { Frame, FrameKind, FrameOf } from '../types/frames';
import { isSeatIndex } from '../types/ids';
import { type GameAction, isSystemAction, type PlayerAction, PlayerIntentSchema } from '../types/intent';
import { type Ctx, frameOwner } from './ctx';
import type { FrameHandler } from './frameHandler';
import { handleSystem } from './system';

export const FRAME_HANDLERS = Object.freeze({
  ROOT,
  TURN,
  MOVE,
  LAND,
  ASK,
  TOLL,
  FEE,
  PAYX,
  CONFINE,
  CARD,
  ITEM,
  GOD,
  NEWS,
  FATE,
  MAGIC,
  BANK,
  SHOP,
  AUCTION,
  BANKRUPT,
  SURRENDER,
  DAY,
  VILLAIN,
} satisfies { readonly [K in FrameKind]: FrameHandler<FrameOf<K>> });

/** 单个 action 内 run 循环的步数上限（远大于一天的正常步数） */
export const RUN_GUARD = 200_000;

function handlerOf(f: Frame): FrameHandler<Frame> {
  return FRAME_HANDLERS[f.k] as unknown as FrameHandler<Frame>;
}

export function run(ctx: Ctx): void {
  const s = ctx.s;
  let guard = 0;
  while (s.pending.length === 0 && s.status === 'playing') {
    guard += 1;
    if (guard > RUN_GUARD) throw new EngineInvariantError('FLOW_LOOP', `run exceeded ${RUN_GUARD} steps`);
    const f = ctx.top();
    const owner = frameOwner(f);
    if (owner !== null && s.players.some((p) => p.seat === owner && !p.alive)) {
      ctx.pop(f);
      continue;
    }
    handlerOf(f).step(ctx, f);
  }
}

function resumeDecision(ctx: Ctx, action: PlayerAction): void {
  const s = ctx.s;
  const { seat, decisionId, ...intent } = action;
  const d = s.pending.find((p) => p.id === decisionId);
  if (!d) throw new EngineRuleError('STALE_DECISION', `decision ${String(decisionId)} is not pending`);
  if (!isSeatIndex(seat) || d.seat !== seat) throw new EngineRuleError('NOT_YOUR_DECISION');
  if (!isIntentAllowed(d.kind, intent.type)) {
    throw new EngineRuleError('INTENT_NOT_ALLOWED', `${String(intent.type)} is not allowed for ${d.kind}`);
  }
  const parsed = PlayerIntentSchema.safeParse(intent);
  if (!parsed.success) throw new EngineRuleError('BAD_ACTION', parsed.error.message);
  const f = ctx.findFrame(d.frameId);
  if (!f) throw new EngineInvariantError('PENDING_FRAME_MISSING', `frame ${d.frameId} for ${d.id}`);
  const h = handlerOf(f);
  if (!h.resume) throw new EngineInvariantError('NO_RESUME', `frame ${f.k}`);
  ctx.clearPending(d.id);
  h.resume(ctx, f, { ...parsed.data, seat, decisionId } as PlayerAction, d);
}

/** 在草稿上执行一个 action（调用方负责克隆与冻结） */
export function executeAction(ctx: Ctx, action: GameAction): void {
  const s = ctx.s;
  if (s.status !== 'playing') throw new EngineRuleError('GAME_OVER');
  if (action === null || typeof action !== 'object' || typeof action.type !== 'string') {
    throw new EngineRuleError('BAD_ACTION', 'action must be an object with a type');
  }
  if (isSystemAction(action)) handleSystem(ctx, action);
  else resumeDecision(ctx, action);
  run(ctx);
  ctx.flushSync();
  s.counters.action += 1;
}
