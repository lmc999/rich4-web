// Transport 接口（architecture §14 client：按 C2S/S2C 类型化的 request / on；实现为 socketTransport，测试用 FakeTransport）
import {
  type AppError,
  appError,
  type C2SAckData,
  type C2SEventName,
  type C2SPayload,
  type Result,
  type S2CEventName,
  type S2CPayload,
} from '@rich4/shared/net';

export type ConnStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface StatusInfo {
  /** 当前重连尝试次数（首连为 0） */
  attempt: number;
  /** 握手被拒（PROTOCOL_MISMATCH / BAD_HANDSHAKE / SERVER_BUSY）或其他致命原因 */
  error?: AppError;
}

export interface RequestOptions {
  /** ack 超时（默认 10 秒） */
  timeoutMs?: number;
}

export interface Transport {
  readonly status: ConnStatus;
  /** 开始连接（幂等）；之后断线由实现自动重连 */
  connect(): void;
  /** 主动断开（不再重连） */
  close(): void;
  /** 发 C2S 事件并等 ack；未连接时等待连接（超时返回 INTERNAL{reason:'timeout'}） */
  request<E extends C2SEventName>(event: E, payload: C2SPayload<E>, o?: RequestOptions): Promise<Result<C2SAckData<E>>>;
  on<E extends S2CEventName>(event: E, cb: (p: S2CPayload<E>) => void): () => void;
  onStatus(cb: (s: ConnStatus, info: StatusInfo) => void): () => void;
  /** 每次（重）连上都会回调（用于 room:resume） */
  onConnect(cb: () => void): () => void;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export function timeoutError(): Result<never> {
  return { ok: false, error: appError('INTERNAL', { reason: 'timeout' }, '请求超时，请检查网络') };
}

/** 同一 token 已在其他页面连接，本页被顶替（不自动重连，由用户选择「在这里继续」） */
export function replacedError(): Result<never> {
  return {
    ok: false,
    error: appError('INTERNAL', { reason: 'replaced' }, '已在其他页面打开，请在本页选择「在这里继续」'),
  };
}

export function disconnectedError(): Result<never> {
  return { ok: false, error: appError('INTERNAL', { reason: 'disconnected' }, '连接已断开') };
}

/** 监听器集合（transport 实现共用） */
export class Listeners<A extends unknown[]> {
  private readonly set = new Set<(...a: A) => void>();

  add(cb: (...a: A) => void): () => void {
    this.set.add(cb);
    return () => {
      this.set.delete(cb);
    };
  }

  emit(...a: A): void {
    for (const cb of [...this.set]) {
      try {
        cb(...a);
      } catch (err) {
        console.error('[rich4] listener threw', err);
      }
    }
  }

  get size(): number {
    return this.set.size;
  }
}
