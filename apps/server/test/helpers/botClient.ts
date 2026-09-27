/**
 * 机器人客户端（design/net.md §11.2）：socket.io-client + 与真实前端相同的 seq/epoch 规则。
 * - 记录收到的全部 S2C 消息（反作弊深度扫描用）与 game:batch；
 * - epoch 不同或 seq 不连续时记录缺口并发 game:resync；seq ≤ lastSeq 的重复 batch 忽略；
 * - autoPlay：收到 yourDecision 就提交（默认 pickIntent，失败时退回 defaultIntent）。
 */
import { randomBytes } from 'node:crypto';
import type { PlayerIntent } from '@rich4/shared/engine';
import {
  type AppError,
  type C2SAckData,
  type C2SEventName,
  type C2SPayload,
  type ClientToServerEvents,
  type GameBatchMsg,
  type GameOverMsg,
  PROTOCOL_VERSION,
  type Result,
  type RoomView,
  type S2CEventName,
  type S2CPayload,
  type ServerToClientEvents,
  type YourDecision,
} from '@rich4/shared/net';
import type { GameView, PendingView } from '@rich4/shared/view';
import { io, type Socket } from 'socket.io-client';
import { pickIntent } from './localPolicy';

export type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export interface Received {
  event: string;
  payload: unknown;
}

export type BotPolicy = (d: YourDecision, rand01: () => number) => PlayerIntent;

export interface BotOptions {
  token?: string;
  nickname?: string;
  protocolVersion?: number;
  /** autoPlay 的随机种子 */
  seed?: number;
  /** 使用 WebSocket 以外的传输（默认只用 websocket，测试更快） */
  transports?: ('websocket' | 'polling')[];
  /** 握手请求的额外头（访问门禁测试用 cookie） */
  extraHeaders?: Record<string, string>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function lcg(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function newToken(): string {
  return randomBytes(16).toString('base64url');
}

export class BotClient {
  socket!: ClientSocket;
  readonly token: string;
  readonly nickname: string;
  readonly received: Received[] = [];
  readonly batches: GameBatchMsg[] = [];
  readonly errors: AppError[] = [];
  /** seq 连续性问题（应当为空） */
  readonly gaps: string[] = [];
  readonly acts: { decisionId: string; intent: PlayerIntent; result: Result<unknown> }[] = [];
  lastSeq = 0;
  epoch = -1;
  view: GameView | undefined;
  room: RoomView | undefined;
  pending: PendingView[] = [];
  yourDecision: YourDecision | undefined;
  over: GameOverMsg | undefined;
  replaced = false;
  closedReason: string | null = null;
  private autoPolicy: BotPolicy | null = null;
  private submitted = new Set<string>();
  private readonly rand: () => number;
  private actSeq = 0;
  private actDelayMs = 0;

  constructor(
    readonly url: string,
    private readonly opts: BotOptions = {},
  ) {
    this.token = opts.token ?? newToken();
    this.nickname = opts.nickname ?? `bot-${this.token.slice(0, 4)}`;
    this.rand = lcg(opts.seed ?? 42);
  }

  /** 建立连接；失败时抛出带 connect_error.data 的错误 */
  async connect(): Promise<void> {
    const socket: ClientSocket = io(this.url, {
      path: '/socket.io/',
      transports: this.opts.transports ?? ['websocket'],
      reconnection: false,
      forceNew: true,
      timeout: 5000,
      ...(this.opts.extraHeaders ? { extraHeaders: this.opts.extraHeaders } : {}),
      auth: {
        token: this.token,
        nickname: this.nickname,
        protocolVersion: this.opts.protocolVersion ?? PROTOCOL_VERSION,
        clientVersion: 'bot',
      },
    });
    this.socket = socket;
    socket.onAny((event: string, payload: unknown) => {
      this.received.push({ event, payload });
      this.onMessage(event, payload);
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', (err: Error & { data?: unknown }) => {
        const e = new Error(`connect_error: ${err.message}`) as Error & { data?: unknown };
        e.data = err.data;
        reject(e);
      });
    });
  }

  private onMessage(event: string, p: unknown): void {
    switch (event) {
      case 'room:state':
        this.room = p as RoomView;
        break;
      case 'room:closed':
        this.closedReason = (p as { reason: string }).reason;
        break;
      case 'session:replaced':
        this.replaced = true;
        break;
      case 'app:error':
        this.errors.push(p as AppError);
        break;
      case 'game:snapshot': {
        const m = p as S2CPayload<'game:snapshot'>;
        this.epoch = m.epoch;
        this.lastSeq = m.seq;
        this.view = m.view;
        this.pending = m.pending;
        this.setDecision(m.yourDecision);
        break;
      }
      case 'game:batch': {
        const m = p as GameBatchMsg;
        if (m.epoch === this.epoch && m.seq <= this.lastSeq) break;
        if (m.epoch !== this.epoch || m.seq !== this.lastSeq + 1) {
          this.gaps.push(`batch epoch ${m.epoch}/${this.epoch} seq ${m.seq} after ${this.lastSeq}`);
          void this.req('game:resync', {});
          break;
        }
        this.batches.push(m);
        this.lastSeq = m.seq;
        this.view = m.view;
        this.pending = m.pending;
        this.setDecision(m.yourDecision);
        break;
      }
      case 'game:catchup': {
        const m = p as S2CPayload<'game:catchup'>;
        let expect = this.lastSeq + 1;
        for (const b of m.batches) {
          if (b.seq !== expect) this.gaps.push(`catchup seq ${b.seq} expected ${expect}`);
          expect = b.seq + 1;
        }
        this.epoch = m.epoch;
        this.lastSeq = m.seq;
        this.view = m.view;
        this.pending = m.pending;
        this.setDecision(m.yourDecision);
        break;
      }
      case 'game:pending': {
        const m = p as S2CPayload<'game:pending'>;
        if (m.epoch === this.epoch && m.seq === this.lastSeq) {
          this.pending = m.pending;
          this.setDecision(m.yourDecision);
        }
        break;
      }
      case 'game:over':
        this.over = p as GameOverMsg;
        break;
    }
  }

  private setDecision(d: YourDecision | undefined): void {
    this.yourDecision = d;
    if (d && this.autoPolicy && !this.submitted.has(d.decisionId)) {
      const policy = this.autoPolicy;
      setImmediate(() => this.play(d, policy));
    }
  }

  private async play(d: YourDecision, policy: BotPolicy): Promise<void> {
    if (this.submitted.has(d.decisionId) || this.yourDecision?.decisionId !== d.decisionId) return;
    this.submitted.add(d.decisionId);
    try {
      if (this.actDelayMs > 0) await sleep(this.actDelayMs);
      let intent = policy(d, this.rand);
      for (let attempt = 0; attempt < 20; attempt++) {
        const r = await this.act(d.decisionId, intent);
        if (r.ok) return;
        if (r.error.code === 'RATE_LIMITED') {
          await sleep(200);
          continue;
        }
        if (r.error.code !== 'INVALID_ACTION' || intent === d.defaultIntent) return;
        intent = d.defaultIntent;
      }
    } catch {
      // 连接已关闭（测试收尾或模拟断线）：丢弃
    }
  }

  /** 提交 game:act（clientActionId 自动生成） */
  async act(decisionId: string, intent: PlayerIntent, clientActionId?: string): Promise<Result<{ seq: number }>> {
    const id = clientActionId ?? `${this.token.slice(0, 6)}-${++this.actSeq}`;
    const r = await this.req('game:act', { decisionId, intent, clientActionId: id });
    this.acts.push({ decisionId, intent, result: r });
    return r;
  }

  req<E extends C2SEventName>(event: E, payload: C2SPayload<E>, timeoutMs = 5000): Promise<Result<C2SAckData<E>>> {
    return new Promise((resolve, reject) => {
      const s = this.socket as unknown as {
        timeout(ms: number): { emit(ev: string, p: unknown, cb: (err: Error | null, r: unknown) => void): void };
      };
      s.timeout(timeoutMs).emit(event, payload, (err, res) => {
        if (err) reject(new Error(`${event} ack timeout`));
        else resolve(res as Result<C2SAckData<E>>);
      });
    });
  }

  /** 原样发送（用于构造非法 payload） */
  rawReq(event: string, payload: unknown, timeoutMs = 5000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const s = this.socket as unknown as {
        timeout(ms: number): { emit(ev: string, p: unknown, cb: (err: Error | null, r: unknown) => void): void };
      };
      s.timeout(timeoutMs).emit(event, payload, (err, res) => (err ? reject(err) : resolve(res)));
    });
  }

  /** 等待某个条件成立（轮询） */
  async until(pred: () => boolean, timeoutMs = 5000, what = 'condition'): Promise<void> {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > timeoutMs) throw new Error(`${this.nickname}: timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  /** 等待下一条某事件（只看调用之后收到的） */
  waitFor<E extends S2CEventName>(
    event: E,
    pred: (p: S2CPayload<E>) => boolean = () => true,
    timeoutMs = 5000,
  ): Promise<S2CPayload<E>> {
    const from = this.received.length;
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        for (let i = from; i < this.received.length; i++) {
          const r = this.received[i]!;
          if (r.event === event && pred(r.payload as S2CPayload<E>)) return resolve(r.payload as S2CPayload<E>);
        }
        if (Date.now() - t0 > timeoutMs) return reject(new Error(`${this.nickname}: timed out waiting for ${event}`));
        setTimeout(tick, 5);
      };
      tick();
    });
  }

  /** 收到 yourDecision 就提交；返回停止函数 */
  autoPlay(policy: BotPolicy = pickIntent, o: { delayMs?: number } = {}): () => void {
    this.autoPolicy = policy;
    this.actDelayMs = o.delayMs ?? 0;
    if (this.yourDecision) this.setDecision(this.yourDecision);
    return () => {
      this.autoPolicy = null;
    };
  }

  /** 模拟断网：直接关闭底层传输（服务器看到 transport close） */
  drop(): void {
    (this.socket.io as unknown as { engine: { close(): void } }).engine.close();
  }

  /** 用同一 token 新建连接并 room:resume */
  async reconnect(code: string): Promise<Result<{ mode: 'lobby' | 'events' | 'snapshot' }>> {
    this.socket.offAny();
    this.socket.removeAllListeners();
    this.socket.disconnect();
    await this.connect();
    return this.req('room:resume', { code, lastSeq: Math.max(0, this.lastSeq), epoch: Math.max(0, this.epoch) });
  }

  close(): void {
    this.autoPolicy = null;
    this.socket?.disconnect();
  }
}

export async function connectBot(url: string, opts: BotOptions = {}): Promise<BotClient> {
  const b = new BotClient(url, opts);
  await b.connect();
  return b;
}
