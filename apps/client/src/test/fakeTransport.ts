// 测试用 Transport：记录 C2S 请求、按事件名返回预设 ack、手动推送 S2C 事件。
import type { C2SAckData, C2SEventName, C2SPayload, Result, S2CEventName, S2CPayload } from '@rich4/shared/net';
import { tx } from '../i18n/tx';
import { GameClient, type GameClientOptions } from '../net/client';
import { type ConnStatus, Listeners, type StatusInfo, type Transport } from '../net/transport';

type Responder<E extends C2SEventName> = (p: C2SPayload<E>) => Result<C2SAckData<E>> | Promise<Result<C2SAckData<E>>>;

export interface SentRequest {
  event: C2SEventName;
  payload: unknown;
}

/** 缺省 ack：大部分事件 ok(undefined)，少数给出最小数据 */
function defaultAck(event: C2SEventName, payload: unknown): Result<unknown> {
  switch (event) {
    case 'room:create':
      return { ok: true, data: { code: '123456', inviteUrl: 'http://x/r/123456' } };
    case 'room:join':
      return {
        ok: true,
        data: {
          you: {
            role: (payload as { role: string }).role === 'spectator' ? 'spectator' : 'player',
            seat: 1,
            isHost: false,
          },
        },
      };
    case 'room:resume':
      return { ok: true, data: { mode: 'snapshot' } };
    case 'game:act':
      return { ok: true, data: { seq: 1 } };
    case 'time:ping':
      return { ok: true, data: { t0: (payload as { t0: number }).t0, serverNow: Date.now() } };
    case 'lobby:list':
      return { ok: true, data: { rooms: [] } };
    case 'saves:list':
      return { ok: true, data: { saves: [] } };
    case 'debug:act':
      return { ok: true, data: { seq: 1 } };
    default:
      return { ok: true, data: undefined };
  }
}

export class FakeTransport implements Transport {
  status: ConnStatus = 'idle';
  readonly sent: SentRequest[] = [];
  private readonly responders = new Map<C2SEventName, (p: unknown) => Result<unknown> | Promise<Result<unknown>>>();
  private readonly s2c = new Map<string, Set<(p: unknown) => void>>();
  private readonly statusL = new Listeners<[ConnStatus, StatusInfo]>();
  private readonly connectL = new Listeners<[]>();

  respond<E extends C2SEventName>(event: E, fn: Responder<E>): this {
    this.responders.set(event, fn as (p: unknown) => Result<unknown>);
    return this;
  }

  connect(): void {
    if (this.status === 'open') return;
    this.status = 'open';
    this.statusL.emit('open', { attempt: 0 });
    this.connectL.emit();
  }

  close(): void {
    this.status = 'closed';
    this.statusL.emit('closed', { attempt: 0 });
  }

  /** 模拟断线 / 重连状态 */
  setStatus(s: ConnStatus, attempt = 0): void {
    this.status = s;
    this.statusL.emit(s, { attempt });
    if (s === 'open') this.connectL.emit();
  }

  async request<E extends C2SEventName>(event: E, payload: C2SPayload<E>): Promise<Result<C2SAckData<E>>> {
    this.sent.push({ event, payload });
    const r = this.responders.get(event);
    return (r ? await r(payload) : defaultAck(event, payload)) as Result<C2SAckData<E>>;
  }

  on<E extends S2CEventName>(event: E, cb: (p: S2CPayload<E>) => void): () => void {
    let set = this.s2c.get(event);
    if (!set) {
      set = new Set();
      this.s2c.set(event, set);
    }
    set.add(cb as (p: unknown) => void);
    return () => set.delete(cb as (p: unknown) => void);
  }

  /** 服务器推送 */
  push<E extends S2CEventName>(event: E, payload: S2CPayload<E>): void {
    for (const cb of [...(this.s2c.get(event) ?? [])]) cb(payload);
  }

  onStatus(cb: (s: ConnStatus, info: StatusInfo) => void): () => void {
    return this.statusL.add(cb);
  }

  onConnect(cb: () => void): () => void {
    return this.connectL.add(cb);
  }

  /** 某事件的全部请求 payload */
  payloads<E extends C2SEventName>(event: E): C2SPayload<E>[] {
    return this.sent.filter((s) => s.event === event).map((s) => s.payload as C2SPayload<E>);
  }

  clearSent(): void {
    this.sent.length = 0;
  }
}

/** 假传输的 GameClient（不驱动 rAF；动画时钟由测试手动推进） */
export function makeTestClient(o: Partial<GameClientOptions> = {}): { client: GameClient; transport: FakeTransport } {
  const transport = new FakeTransport();
  const client = new GameClient({
    transport,
    t: tx,
    driveClock: false,
    dev: true,
    maxHandlerMs: 0,
    warn: () => {},
    ...o,
  });
  return { client, transport };
}
