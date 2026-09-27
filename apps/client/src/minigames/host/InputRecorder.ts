// 输入记录与上传（design/minigames-ai.md §7.2；architecture §5.8 game:minigameInput）：
// - 记录：tick 单调不减；按 spec 的每 tick 条数、每秒条数与日志总长在本地先限流（超出的点击直接丢弃），
//   保证整条日志一定能通过服务器的 validateLog；
// - 上传：seq 从 0 连续递增（seq 0 可以不带事件，表示「已开局」）；有新输入时每 200ms 或攒够 8 条发一批，
//   没有新输入时每 1 秒发一次空批（观战端据此判断玩家仍在线）；同一时刻只有一批在路上，失败的批按原样重发
//   （同 seq、同一组事件，不重新截取：服务器可能已经收下，只是 ack 丢了，重发批变大会让两端的前缀错位）。
import {
  type InputEvent,
  MINIGAME_MAX_LOG,
  type MinigameSpec,
  ticksPerSecond,
  validateInputForSpec,
} from '@rich4/shared/minigames';
import { MINIGAME_INPUT_BATCH_MAX, MINIGAME_INPUT_FLUSH_MS } from '@rich4/shared/net';

/** 没有新输入时的心跳间隔 */
export const MINIGAME_HEARTBEAT_MS = 1000;

export interface UploadBatch {
  seq: number;
  events: InputEvent[];
}

export class InputRecorder {
  readonly log: InputEvent[] = [];
  /** 已被服务器接受的条数（前缀长度） */
  private acked = 0;
  /** 在路上的批（未确认） */
  private inflight: (UploadBatch & { count: number }) | null = null;
  /** 传输失败、等待原样重发的批 */
  private retry: (UploadBatch & { count: number }) | null = null;
  private nextSeq = 0;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  /** 上传是否已放弃（服务器拒绝了某一批：之后只靠最终提交） */
  private stopped = false;

  constructor(readonly spec: MinigameSpec) {}

  get lastTick(): number {
    return this.log.length > 0 ? this.log[this.log.length - 1]![0] : -1;
  }

  /** tick 上已有的条数 */
  countAt(tick: number): number {
    let n = 0;
    for (let i = this.log.length - 1; i >= 0 && this.log[i]![0] >= tick; i--) if (this.log[i]![0] === tick) n++;
    return n;
  }

  /** 能否在 tick 上再记一条（单调、每 tick 与每秒上限、总长） */
  canRecord(tick: number): boolean {
    if (this.log.length >= MINIGAME_MAX_LOG) return false;
    if (tick < this.lastTick || tick >= this.spec.maxTicks) return false;
    if (this.countAt(tick) >= this.spec.maxInputsPerTick) return false;
    // 窗口 [tick − 1s + 1, tick]；之后的 tick 更大，窗口只会右移，所以现在满足即可
    const from = tick - ticksPerSecond(this.spec) + 1;
    let inWindow = 0;
    for (let i = this.log.length - 1; i >= 0 && this.log[i]![0] >= from; i--) inWindow++;
    return inWindow < this.spec.maxInputsPerSecond;
  }

  /** 记录一条输入；不合法或超限时返回 false（丢弃） */
  record(e: InputEvent): boolean {
    if (!validateInputForSpec(this.spec, e) || !this.canRecord(e[0])) return false;
    this.log.push(e);
    return true;
  }

  /** tick 的全部输入（按记录顺序） */
  inputsAt(tick: number): InputEvent[] {
    const out: InputEvent[] = [];
    for (let i = this.log.length - 1; i >= 0; i--) {
      const t = this.log[i]![0];
      if (t < tick) break;
      if (t === tick) out.push(this.log[i]!);
    }
    return out.reverse();
  }

  get uploadStopped(): boolean {
    return this.stopped;
  }

  /** 已确认上传的条数 */
  get uploaded(): number {
    return this.acked;
  }

  /**
   * 该发下一批了吗（force：开局的 seq 0、收尾时把剩下的都发出去）。没有在路上的批时才返回。
   */
  takeBatch(now: number, force = false): UploadBatch | null {
    if (this.stopped || this.inflight) return null;
    const retry = this.retry;
    if (retry) {
      if (!force && now - this.lastSentAt < MINIGAME_INPUT_FLUSH_MS) return null;
      this.retry = null;
      this.inflight = retry;
      this.lastSentAt = now;
      return { seq: retry.seq, events: retry.events };
    }
    const from = this.acked;
    const fresh = this.log.length - from;
    const due =
      force ||
      this.nextSeq === 0 ||
      fresh >= MINIGAME_INPUT_BATCH_MAX ||
      (fresh > 0 && now - this.lastSentAt >= MINIGAME_INPUT_FLUSH_MS) ||
      now - this.lastSentAt >= MINIGAME_HEARTBEAT_MS;
    if (!due) return null;
    const count = Math.min(fresh, MINIGAME_INPUT_BATCH_MAX);
    const batch = { seq: this.nextSeq, events: this.log.slice(from, from + count), count };
    this.inflight = batch;
    this.lastSentAt = now;
    return { seq: batch.seq, events: batch.events };
  }

  /**
   * 批的结果：ok → 前移；seq 不对且服务器期望的正好是下一个（这批其实已到达、只是 ack 丢了）→ 视为已接受
   * （服务器带了 logLength 时以它为准）；传输失败（超时、断线）→ 下次原样重发同一批；其他拒绝 → 停止上传
   * （最终提交仍带完整日志）。
   */
  settle(
    seq: number,
    r: { ok: true } | { ok: false; code: string; expected?: number; logLength?: number; transient?: boolean },
  ): void {
    const b = this.inflight;
    if (!b || b.seq !== seq) return;
    this.inflight = null;
    if (r.ok) {
      this.acked += b.count;
      this.nextSeq = seq + 1;
      return;
    }
    if (r.code === 'seq' && r.expected === seq + 1) {
      const n = r.logLength;
      this.acked = n !== undefined && n >= this.acked && n <= this.log.length ? n : this.acked + b.count;
      this.nextSeq = seq + 1;
      return;
    }
    if (r.transient) {
      this.retry = b;
      return;
    }
    this.stopped = true;
  }

  /** 续玩：已被服务器接受的历史批（重连后补收的自己的帧） */
  restore(frames: readonly { seq: number; events: readonly InputEvent[] }[]): void {
    for (const f of frames) {
      if (f.seq !== this.nextSeq) continue;
      this.log.push(...f.events);
      this.acked = this.log.length;
      this.nextSeq = f.seq + 1;
      this.lastSentAt = Number.NEGATIVE_INFINITY;
    }
  }

  get seq(): number {
    return this.nextSeq;
  }

  get busy(): boolean {
    return this.inflight !== null || this.retry !== null;
  }
}
