/**
 * 小游戏裁判（architecture §5.10；design/minigames-ai.md §6.2；design/net.md §6.3 按 architecture 修订）。
 * 纯逻辑，不做 IO：时间由调用方传入，发送与提交由 GameRunner / 网络层完成。
 *
 * 会话随 MINIGAME 决策开关（GameRunner.syncPending 调 open / close）：
 * - input：seq 必须连续；每条输入 validateInput 通过、tick 单调不减、< maxTicks，且不能来自「未来」
 *   （tick ≤ floor((now − startsAt)/tickMs) + 20）；整条流通过 validateLog（条数、密度）。
 *   第一条被接受的消息（seq 0，可以不带事件）标记「已开局」：此后 MINIGAME_DECLINE 被拒。
 *   被接受的消息原样作为 game:minigameFrames 转发给观战者。
 * - submit：inputs 必须以已上传的流为前缀；整条日志 validateLog；服务器 replay；
 *   时序 now − startsAt ≥ endTick × tickMs × 0.85 − 500，否则 MINIGAME_TOO_EARLY；
 *   客户端报的分数与哈希只用来比对记日志，一律以服务器重放为准。
 * - settle（到期、暂停后恢复）：已开局 → 用已收到的输入重放结算（断线之后视为不操作）；未开局 → decline。
 *
 * 会话状态只在内存、不随快照持久化：服务器重启后房间以暂停状态恢复，继续时 GameRunner 按 minigameWindow 重开计时
 * （新 sessionId，之前已开局的会话从头开始）；同一进程内暂停后继续，已开局的会话按已收到的输入结算。
 */
import {
  hashLog,
  type InputEvent,
  isLogPrefix,
  MINIGAME_SIMS,
  type MinigameSim,
  type MinigameTicket,
  replay,
  type SimBase,
  spectatorTicket,
  ticksAt,
  validateSimLog,
} from '@rich4/shared/minigames';
import {
  fail,
  MINIGAME_FUTURE_TICK_TOLERANCE,
  MINIGAME_SUBMIT_MIN_RATIO,
  MINIGAME_SUBMIT_SLACK_MS,
  type MinigameFramesMsg,
  type MinigameInputMsg,
  type MinigameSubmitMsg,
  ok,
  type Result,
} from '@rich4/shared/net';
import type { Logger } from '../infra/logger';

/** 开局消息（seq 0）最多可以比 startsAt 早这么多（客户端时钟偏差） */
export const MINIGAME_EARLY_START_MS = 1000;
/** 保留最近多少个已结算（玩过）的会话，供 replay 观战模式下发完整日志 */
export const MINIGAME_RECENT_SETTLED = 8;

export interface RefereeSession {
  /** 玩家票据（含种子） */
  readonly ticket: MinigameTicket;
  /** 已接受的输入（按到达顺序拼接） */
  readonly log: InputEvent[];
  /** 已接受的消息（按 seq），观战迟到者补发用 */
  readonly frames: MinigameFramesMsg[];
  nextSeq: number;
  started: boolean;
  startedAt: number | null;
}

export interface MinigameOutcome {
  score: number;
  logHash: number;
  endTick: number;
  hash: number;
}

export type Settlement = ({ kind: 'result' } & MinigameOutcome) | { kind: 'decline' };

/** 已结算（玩过）的会话：replay 观战模式在结算后下发 */
export interface SettledSession {
  ticket: MinigameTicket;
  log: InputEvent[];
  score: number;
}

export interface RefereeStats {
  acceptedInputs: number;
  rejectedInputs: number;
  submits: number;
  rejectedSubmits: number;
  /** 客户端报的分数或哈希与服务器重放不一致（bug 或作弊） */
  mismatches: number;
}

export interface RefereeDeps {
  log: Logger;
  /** 截止之后还接受提交的网络宽限（与定时器一致） */
  graceMs: number;
  /** 测试注入；缺省为三个原版小游戏 */
  sims?: Readonly<Record<MinigameTicket['minigameId'], MinigameSim<SimBase>>>;
}

export class MinigameReferee {
  private readonly byDecision = new Map<string, RefereeSession>();
  private readonly bySession = new Map<string, RefereeSession>();
  private readonly settled: SettledSession[] = [];
  readonly stats: RefereeStats = {
    acceptedInputs: 0,
    rejectedInputs: 0,
    submits: 0,
    rejectedSubmits: 0,
    mismatches: 0,
  };

  constructor(private readonly deps: RefereeDeps) {}

  private sim(t: MinigameTicket): MinigameSim<SimBase> {
    return (this.deps.sims ?? MINIGAME_SIMS)[t.minigameId] as MinigameSim<SimBase>;
  }

  // ───────────────────────── 会话生命周期 ─────────────────────────

  /** 决策出现时开会话（同一决策重复 open 返回已有会话） */
  open(ticket: MinigameTicket): RefereeSession {
    const cur = this.byDecision.get(ticket.decisionId);
    if (cur) return cur;
    const s: RefereeSession = { ticket, log: [], frames: [], nextSeq: 0, started: false, startedAt: null };
    this.byDecision.set(ticket.decisionId, s);
    this.bySession.set(ticket.sessionId, s);
    return s;
  }

  /** 未开局的会话换新窗口（暂停恢复）：旧 sessionId 作废 */
  reopen(ticket: MinigameTicket): RefereeSession {
    this.drop(ticket.decisionId);
    return this.open(ticket);
  }

  /** 决策消失时关闭；played 给出时记入已结算列表 */
  close(decisionId: string, played?: { score: number }): void {
    const s = this.byDecision.get(decisionId);
    if (!s) return;
    this.drop(decisionId);
    if (played && s.started) {
      this.settled.push({ ticket: s.ticket, log: s.log.slice(), score: played.score });
      while (this.settled.length > MINIGAME_RECENT_SETTLED) this.settled.shift();
    }
  }

  private drop(decisionId: string): void {
    const s = this.byDecision.get(decisionId);
    if (!s) return;
    this.byDecision.delete(decisionId);
    this.bySession.delete(s.ticket.sessionId);
  }

  clear(): void {
    this.byDecision.clear();
    this.bySession.clear();
    this.settled.length = 0;
  }

  session(decisionId: string): RefereeSession | undefined {
    return this.byDecision.get(decisionId);
  }

  sessionById(sessionId: string): RefereeSession | undefined {
    return this.bySession.get(sessionId);
  }

  /** 进行中的会话（按座位排序） */
  active(): RefereeSession[] {
    return [...this.byDecision.values()].sort((a, b) => a.ticket.seat - b.ticket.seat);
  }

  /** 最近结算（玩过）的会话，新的在后 */
  recentSettled(): readonly SettledSession[] {
    return this.settled;
  }

  started(decisionId: string): boolean {
    return this.byDecision.get(decisionId)?.started === true;
  }

  spectatorTicket(s: RefereeSession): MinigameTicket {
    return spectatorTicket(s.ticket);
  }

  // ───────────────────────── 输入流 ─────────────────────────

  private owned(seat: number, sessionId: string): Result<RefereeSession> {
    const s = this.bySession.get(sessionId);
    if (!s) return fail('MINIGAME_INVALID', { reason: 'noSession' });
    if (s.ticket.seat !== seat) return fail('NOT_YOUR_DECISION');
    return ok(s);
  }

  /** game:minigameInput：成功时返回要转发给观战者的帧 */
  input(seat: number, msg: MinigameInputMsg, now: number): Result<MinigameFramesMsg> {
    const r = this.inputInner(seat, msg, now);
    if (r.ok) this.stats.acceptedInputs += msg.events.length;
    else this.stats.rejectedInputs++;
    return r;
  }

  private inputInner(seat: number, msg: MinigameInputMsg, now: number): Result<MinigameFramesMsg> {
    const own = this.owned(seat, msg.sessionId);
    if (!own.ok) return own;
    const s = own.data;
    const t = s.ticket;
    if (now > t.deadlineAt) return fail('MINIGAME_TOO_LATE');
    if (now < t.startsAt - MINIGAME_EARLY_START_MS) return fail('MINIGAME_TOO_EARLY', { startsAt: t.startsAt });
    // logLength：已接受的日志长度（客户端丢了 ack 时据此对齐已上传的前缀）
    if (msg.seq !== s.nextSeq) {
      return fail('MINIGAME_INVALID', { reason: 'seq', expected: s.nextSeq, logLength: s.log.length });
    }
    const sim = this.sim(t);
    const horizon = ticksAt(now, t.startsAt, t.tickMs) + MINIGAME_FUTURE_TICK_TOLERANCE;
    let last = s.log.length > 0 ? s.log[s.log.length - 1]![0] : 0;
    for (let i = 0; i < msg.events.length; i++) {
      const e = msg.events[i]!;
      if (!sim.validateInput(e)) return fail('MINIGAME_INVALID', { reason: 'badInput', index: i });
      if (e[0] < last) return fail('MINIGAME_INVALID', { reason: 'notMonotonic', index: i });
      if (e[0] >= t.maxTicks) return fail('MINIGAME_INVALID', { reason: 'badTick', index: i });
      if (e[0] > horizon) return fail('MINIGAME_INVALID', { reason: 'futureTick', index: i, horizon });
      last = e[0];
    }
    if (msg.events.length > 0) {
      const bad = validateSimLog(sim, [...s.log, ...msg.events]);
      if (bad) return fail('MINIGAME_INVALID', { reason: 'badLog', code: bad.code, index: bad.index - s.log.length });
      s.log.push(...msg.events);
    }
    const frame: MinigameFramesMsg = { sessionId: t.sessionId, seq: msg.seq, events: msg.events.slice() };
    s.frames.push(frame);
    s.nextSeq++;
    if (!s.started) {
      s.started = true;
      s.startedAt = now;
    }
    return ok(frame);
  }

  // ───────────────────────── 提交与结算 ─────────────────────────

  /**
   * game:minigameSubmit：校验通过返回服务器重放的结果（调用方随即提交 MINIGAME_RESULT）。
   * 校验通过后会话日志替换为完整日志（若提交 action 失败，到期结算也用它）。
   */
  submit(seat: number, msg: MinigameSubmitMsg, now: number): Result<{ decisionId: string } & MinigameOutcome> {
    this.stats.submits++;
    const r = this.submitInner(seat, msg, now);
    if (!r.ok) {
      this.stats.rejectedSubmits++;
      this.deps.log.info({ seat, sessionId: msg.sessionId, error: r.error }, 'minigame submit rejected');
    }
    return r;
  }

  private submitInner(
    seat: number,
    msg: MinigameSubmitMsg,
    now: number,
  ): Result<{ decisionId: string } & MinigameOutcome> {
    const own = this.owned(seat, msg.sessionId);
    if (!own.ok) return own;
    const s = own.data;
    const t = s.ticket;
    if (now > t.deadlineAt + this.deps.graceMs) return fail('MINIGAME_TOO_LATE');
    if (!isLogPrefix(s.log, msg.inputs)) {
      return fail('MINIGAME_INVALID', { reason: 'notPrefix', uploaded: s.log.length });
    }
    const sim = this.sim(t);
    const horizon = ticksAt(now, t.startsAt, t.tickMs) + MINIGAME_FUTURE_TICK_TOLERANCE;
    for (let i = s.log.length; i < msg.inputs.length; i++) {
      if (msg.inputs[i]![0] > horizon) return fail('MINIGAME_INVALID', { reason: 'futureTick', index: i, horizon });
    }
    const bad = validateSimLog(sim, msg.inputs);
    if (bad) return fail('MINIGAME_INVALID', { reason: 'badLog', code: bad.code, index: bad.index });
    const r = replay(sim, t.seed, t.params, msg.inputs);
    const minElapsed = r.endTick * t.tickMs * MINIGAME_SUBMIT_MIN_RATIO - MINIGAME_SUBMIT_SLACK_MS;
    if (now - t.startsAt < minElapsed) {
      return fail('MINIGAME_TOO_EARLY', { waitMs: Math.ceil(minElapsed - (now - t.startsAt)) });
    }
    if (msg.claimedScore !== r.score || msg.finalHash !== r.hash) {
      this.stats.mismatches++;
      this.deps.log.warn(
        {
          seat,
          sessionId: t.sessionId,
          minigameId: t.minigameId,
          claimed: { score: msg.claimedScore, hash: msg.finalHash },
          server: { score: r.score, hash: r.hash, endTick: r.endTick },
          clientElapsedMs: msg.clientElapsedMs,
        },
        'minigame result mismatch (server replay wins)',
      );
    }
    s.log.length = 0;
    s.log.push(...msg.inputs);
    if (!s.started) {
      s.started = true;
      s.startedAt = now;
    }
    return ok({
      decisionId: t.decisionId,
      score: r.score,
      logHash: hashLog(msg.inputs),
      endTick: r.endTick,
      hash: r.hash,
    });
  }

  /** 到期或暂停后恢复：已开局用已收到的输入重放，未开局走 decline（会话保留，由决策消失时 close） */
  settle(decisionId: string): Settlement {
    const s = this.byDecision.get(decisionId);
    if (!s?.started) return { kind: 'decline' };
    const t = s.ticket;
    const r = replay(this.sim(t), t.seed, t.params, s.log);
    return { kind: 'result', score: r.score, logHash: hashLog(s.log), endTick: r.endTick, hash: r.hash };
  }
}
