// 观战输入流（design/minigames-ai.md §7.3；client.md §9 按 architecture 修订：缓冲 300ms 后本地用同一个 sim 重放）：
// - game:minigameFrames 按 seq 重组（乱序先暂存，缺口补齐后再拼接），得到玩家已上传的输入日志；
// - 观战端的目标 tick = 服务器时间减去缓冲后换算；超过 2 秒没有新帧就定格（显示「等待 X…」），直到有新帧或收到结算；
// - 收到比当前重放 tick 更早的输入（网络抖动超过缓冲）时标记需要从头重放（最多几百步，瞬间完成）。
import type { InputEvent } from '@rich4/shared/minigames';

export const SPECTATOR_BUFFER_MS = 300;
export const SPECTATOR_STALL_MS = 2000;

export interface FeedFrame {
  seq: number;
  events: readonly InputEvent[];
}

export class SpectatorFeed {
  readonly log: InputEvent[] = [];
  private nextSeq = 0;
  private readonly held = new Map<number, FeedFrame>();
  /** 最近一次收到帧的本机时间 */
  lastFrameAt: number;
  /** 已拼接的日志里最早的「迟到」tick（需要从头重放时为该 tick，否则 null） */
  private lateTick: number | null = null;
  /** 完整日志已知（replay 模式或结算后）：不再定格 */
  complete = false;

  constructor(
    now: number,
    readonly bufferMs = SPECTATOR_BUFFER_MS,
    readonly stallMs = SPECTATOR_STALL_MS,
  ) {
    this.lastFrameAt = now;
  }

  /** 收到一帧；playedTick 是本地重放已经完成的 step 数（用于判断是否迟到） */
  push(f: FeedFrame, now: number, playedTick: number): void {
    this.lastFrameAt = now;
    if (f.seq < this.nextSeq || this.held.has(f.seq)) return;
    this.held.set(f.seq, f);
    for (let g = this.held.get(this.nextSeq); g; g = this.held.get(this.nextSeq)) {
      this.held.delete(this.nextSeq);
      this.nextSeq++;
      for (const e of g.events) {
        if (e[0] < playedTick && (this.lateTick === null || e[0] < this.lateTick)) this.lateTick = e[0];
        this.log.push(e);
      }
    }
  }

  /** 一次性给出完整日志（replay 模式） */
  setComplete(log: readonly InputEvent[]): void {
    this.log.length = 0;
    this.log.push(...log);
    this.held.clear();
    this.complete = true;
    this.lateTick = null;
  }

  /** 取走「需要从头重放」标记 */
  takeRewind(): boolean {
    const r = this.lateTick !== null;
    this.lateTick = null;
    return r;
  }

  /** 超过 stallMs 没有新帧（完整日志已知时不定格） */
  stalled(now: number): boolean {
    return !this.complete && now - this.lastFrameAt > this.stallMs;
  }

  /** 缓冲后的服务器时间 */
  bufferedNow(serverNow: number): number {
    return serverNow - this.bufferMs;
  }

  /** tick 的全部输入 */
  inputsAt(tick: number): InputEvent[] {
    const out: InputEvent[] = [];
    for (const e of this.log) {
      if (e[0] === tick) out.push(e);
      else if (e[0] > tick) break;
    }
    return out;
  }

  get receivedSeq(): number {
    return this.nextSeq;
  }
}
