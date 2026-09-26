/**
 * Ctx：一次 applyAction 的执行上下文（design/engine.md §6.2、§12.1）。
 *
 * - s 是草稿（applyAction 先 structuredClone；applyInPlace 直接用入参）。
 * - emit 时对公开世界做实体级 diff，自动生成 post（受影响实体各字段的绝对值）。**handler 必须先改状态再 emit**。
 * - ask 把决策压入 pending（id = d${++counters.decision}），run 循环随之停下。
 * - 帧栈：push / pop / replace；unwindActor 删除破产者的帧并把他的 TURN 转入 end。
 * - 资金：pay（级联扣款，付不起就压 BANKRUPT 帧并返回 bankrupt=true，调用方必须立刻 return）、spendCash、mint。
 * - 随机：roll* 都走 core/random 的语义层（读 secret.debugQueue）。
 */
import { DECISION_TIMING_CLASS } from '../decisions/timing';
import { EngineInvariantError } from '../errors';
import { playerAt, spendCash, type TransferOptions, type TransferResult, transfer } from '../rules/payment';
import { buildResult, type EndCheck } from '../rules/victory';
import type {
  DecisionKind,
  DecisionOptionsMap,
  DecisionPublicInfo,
  PendingDecision,
  PendingMinigame,
} from '../types/decision';
import type { GameEvent, GameEventPayloads, GameEventType, PostPatch } from '../types/events';
import type { Frame, FrameKind, FrameOf } from '../types/frames';
import type { Cause, DiceFace, MoneyReason, Party, RandPurpose, SeatIndex } from '../types/ids';
import type { PlayerIntent } from '../types/intent';
import type { GameState, PlayerState, PublicWorld } from '../types/state';
import { nextDecisionId, nextFrameId } from './ids';
import type { EngineMap } from './mapCache';
import { applyPostPatch, type DiffableWorld, diffPublic, publicWorld } from './postPatch';
import { next32, pick, rand15, rollDie } from './random';

/** 去掉 fid 的帧（push 时分配 fid），按 k 分布 */
export type FrameInit = Frame extends infer F ? (F extends Frame ? Omit<F, 'fid'> : never) : never;

export interface CtxOptions {
  /** 出现 SYNC（未经事件公布的公开变化）时抛 EngineInvariantError（开发 / 测试模式） */
  strictSync: boolean;
}

export interface PayOptions extends TransferOptions {
  reason: MoneyReason;
  /** 破产时写进 BANKRUPT 帧与事件 */
  cause: Cause;
}

export class Ctx {
  readonly events: GameEvent[] = [];
  private shadow: DiffableWorld;

  constructor(
    readonly s: GameState,
    readonly map: EngineMap,
    baseline: DiffableWorld,
    readonly opts: CtxOptions,
  ) {
    this.shadow = baseline;
  }

  // ───────────────────────── 事件 ─────────────────────────

  /** 先改状态再 emit：post = diff(上一个事件之后的公开世界, 现在的公开世界) */
  emit<T extends GameEventType>(type: T, payload: GameEventPayloads[T]): void {
    const post = diffPublic(this.shadow, this.s);
    const e: Record<string, unknown> = { type, ...payload };
    if (post) {
      this.shadow = applyPostPatch(this.shadow, post);
      e.post = post;
    }
    this.events.push(e as GameEvent);
  }

  /** 还没被任何事件公布的公开变化（没有返回 undefined） */
  pendingPost(): PostPatch | undefined {
    return diffPublic(this.shadow, this.s);
  }

  /** action 结束时补发 SYNC；strictSync 下视为缺陷 */
  flushSync(reason: 'flush' | 'timeRewind' = 'flush'): void {
    const post = this.pendingPost();
    if (!post) return;
    if (this.opts.strictSync && reason === 'flush') {
      throw new EngineInvariantError(
        'UNANNOUNCED_CHANGE',
        `public changes without event: ${Object.keys(post).join(',')}`,
        {
          post,
        },
      );
    }
    this.emit('SYNC', { reason });
  }

  // ───────────────────────── 帧栈 ─────────────────────────

  top(): Frame {
    const f = this.s.flow[this.s.flow.length - 1];
    if (!f) throw new EngineInvariantError('FLOW_EMPTY');
    return f;
  }

  push<F extends FrameInit>(init: F): FrameOf<F['k']> {
    const f = { ...init, fid: nextFrameId(this.s) } as unknown as FrameOf<F['k']>;
    this.s.flow.push(f);
    return f;
  }

  /** 弹出 f（必须是栈顶） */
  pop(f: Frame): void {
    const top = this.s.flow[this.s.flow.length - 1];
    if (top !== f) throw new EngineInvariantError('FLOW_POP_NOT_TOP', `frame ${f.k}#${f.fid} is not on top`);
    this.s.flow.pop();
  }

  /** 用新帧替换栈顶的 f（新帧分配新 fid） */
  replace<F extends FrameInit>(f: Frame, init: F): FrameOf<F['k']> {
    this.pop(f);
    return this.push(init);
  }

  findFrame(fid: number): Frame | null {
    for (const f of this.s.flow) if (f.fid === fid) return f;
    return null;
  }

  frameOf<K extends FrameKind>(f: Frame, k: K): FrameOf<K> {
    if (f.k !== k) throw new EngineInvariantError('FRAME_KIND', `expected ${k}, got ${f.k}`);
    return f as FrameOf<K>;
  }

  // ───────────────────────── 决策 ─────────────────────────

  ask<K extends DecisionKind>(
    frame: Frame,
    seat: SeatIndex,
    kind: K,
    options: DecisionOptionsMap[K],
    defaultIntent: PlayerIntent,
    info: Partial<Pick<DecisionPublicInfo<K>, 'lot' | 'amount' | 'labelKey'>> = {},
    extra: { budgetKey?: string | null; minigame?: PendingMinigame | null } = {},
  ): PendingDecision<K> {
    if (this.s.pending.some((p) => p.seat === seat)) {
      throw new EngineInvariantError('DUPLICATE_PENDING', `seat ${seat} already has a pending decision`);
    }
    const d: PendingDecision<K> = {
      id: nextDecisionId(this.s),
      frameId: frame.fid,
      seat,
      kind,
      options,
      publicInfo: { kind, seat, lot: info.lot ?? null, amount: info.amount ?? null, labelKey: info.labelKey ?? null },
      defaultIntent,
      timing: DECISION_TIMING_CLASS[kind],
      budgetKey: extra.budgetKey ?? null,
      minigame: extra.minigame ?? null,
    };
    this.s.pending.push(d as unknown as PendingDecision);
    return d;
  }

  clearPending(id: string): void {
    this.s.pending = this.s.pending.filter((p) => p.id !== id);
  }

  // ───────────────────────── 玩家与随机 ─────────────────────────

  player(seat: SeatIndex): PlayerState {
    return playerAt(this.s, seat);
  }

  rollDie(): DiceFace {
    return rollDie(this.s);
  }

  pick(purpose: RandPurpose, n: number): number {
    return pick(this.s, purpose, n);
  }

  rand15(purpose: RandPurpose): number {
    return rand15(this.s, purpose);
  }

  next32(purpose: RandPurpose): number {
    return next32(this.s, purpose);
  }

  // ───────────────────────── 资金 ─────────────────────────

  /** 玩家付款可能破产：此时已压 BANKRUPT 帧，调用方 emit 完本事件后必须立刻 return */
  pay(from: Party, to: Party, amount: number, o: PayOptions): TransferResult {
    const r = transfer(this.s, from, to, amount, o);
    if (r.bankrupt && from.t === 'seat') this.pushBankrupt(from.seat, o.cause, to);
    return r;
  }

  spendCash(seat: SeatIndex, amount: number): boolean {
    return spendCash(this.s, seat, amount);
  }

  /** 银行铸造给玩家（奖金、利息、放款…），计入 ledger.minted */
  mint(seat: SeatIndex, amount: number, where: 'cash' | 'deposit' = 'cash', accident = false): void {
    transfer(this.s, { t: 'bank' }, { t: 'seat', seat }, amount, { credit: where, accident });
  }

  /** 玩家付给银行（罚款、还款…），计入 ledger.burned；付不起同样破产（调用方须立刻 return） */
  burn(seat: SeatIndex, amount: number, o: PayOptions): TransferResult {
    return this.pay({ t: 'seat', seat }, { t: 'bank' }, amount, o);
  }

  pushBankrupt(seat: SeatIndex, cause: Cause, creditor: Party | null): void {
    // 同一座位只压一个 BANKRUPT 帧
    if (this.s.flow.some((f) => f.k === 'BANKRUPT' && f.seat === seat)) return;
    this.push({ k: 'BANKRUPT', seat, cause, creditor, stage: 'detach', auctionLots: [] });
  }

  /**
   * 破产展开（design/engine.md §6.2）：删掉栈里属于 seat 的帧；如果他的 TURN 帧在栈中，改为 stage='end'。
   * 同时清掉他的待决策。ROOT、DAY、BANKRUPT 等全局帧不受影响。
   */
  unwindActor(seat: SeatIndex): void {
    this.s.flow = this.s.flow.filter((f) => {
      if (f.k === 'TURN' && f.seat === seat) {
        f.stage = 'end';
        return true;
      }
      return frameOwner(f) !== seat;
    });
    this.s.pending = this.s.pending.filter((p) => p.seat !== seat);
  }

  // ───────────────────────── 终局 ─────────────────────────

  endGame(end: EndCheck): void {
    const result = buildResult(this.s, this.map, end);
    this.s.status = 'over';
    this.s.result = result;
    this.s.pending = [];
    this.emit('GAME_OVER', { result });
  }
}

/** 帧所属的座位（破产展开与「演员已出局」判定用）；全局帧返回 null */
export function frameOwner(f: Frame): SeatIndex | null {
  switch (f.k) {
    case 'MOVE':
    case 'LAND':
    case 'CONFINE':
      return f.actor.t === 'seat' ? f.actor.seat : null;
    case 'ASK':
    case 'CARD':
    case 'ITEM':
    case 'GOD':
    case 'FATE':
    case 'BANK':
    case 'SHOP':
      return f.seat;
    case 'TOLL':
    case 'FEE':
    case 'PAYX':
      return f.payer;
    case 'MAGIC':
      return f.caster;
    default:
      return null;
  }
}

/** 公开世界的快照基线（applyInPlace 用：入参会被原地修改，所以基线必须是拷贝） */
export function snapshotBaseline(s: GameState): DiffableWorld {
  return structuredClone(publicWorld(s) as PublicWorld);
}
