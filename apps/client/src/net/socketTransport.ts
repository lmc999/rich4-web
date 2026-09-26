// socket.io-client 实现的 Transport（architecture §5.8；design/net.md §4.1、§5.1–5.2）。
// - auth 回调每次（重）连都会重新取值：{token, nickname, protocolVersion, clientVersion}；
// - 断线自动重连（0.5s 起、上限 8s、±20% 抖动）；握手被拒（PROTOCOL_MISMATCH / BAD_HANDSHAKE）不再重试；
// - 服务器主动断开（'io server disconnect'：优雅停机 / 重启）socket.io 不会自动重连：按 server:notice 的 reconnectInMs
//   （缺省 SERVER_RECONNECT_MS）加抖动后手动 connect()，连不上时由 socket.io 的退避接着重试（net.md §8.5 第 4 步）；
// - 被同一 token 的另一页面顶替（session:replaced）时不自动重连，request 立即返回 replaced 错误，由用户在遮罩上接管；
// - 不启用 connectionStateRecovery：断线恢复完全由应用层 room:resume 负责。
import {
  type AppError,
  appError,
  type C2SAckData,
  type C2SEventName,
  type C2SPayload,
  type HandshakeAuth,
  isErrorCode,
  type Result,
  type S2CEventName,
  type S2CPayload,
} from '@rich4/shared/net';
import { io, type Socket } from 'socket.io-client';
import {
  type ConnStatus,
  DEFAULT_REQUEST_TIMEOUT_MS,
  disconnectedError,
  Listeners,
  type RequestOptions,
  replacedError,
  type StatusInfo,
  type Transport,
  timeoutError,
} from './transport';

export interface SocketTransportOptions {
  /** 缺省为当前页面同源（开发期由 Vite 代理 /socket.io） */
  url?: string;
  getAuth(): HandshakeAuth;
  /** SERVER_BUSY 被拒后的手动重试间隔 */
  busyRetryMs?: number;
  /** 服务器主动断开后、没有 server:notice 指定时间时的重连延迟（ms，另加 0..50% 抖动） */
  serverReconnectMs?: number;
}

/** 服务器主动断开后的缺省重连延迟 */
export const SERVER_RECONNECT_MS = 3000;

/** 只用到的 socket 方法（类型化事件表对 ack 回调的推导过于复杂，这里按运行时形状收窄） */
interface LooseSocket {
  connected: boolean;
  active: boolean;
  connect(): void;
  disconnect(): void;
  on(ev: string, cb: (...a: never[]) => void): void;
  timeout(ms: number): { emit(ev: string, payload: unknown, cb: (err: unknown, res: unknown) => void): void };
  io: { on(ev: string, cb: (...a: never[]) => void): void };
}

function handshakeError(err: unknown): AppError | null {
  const data = (err as { data?: unknown } | null)?.data as { code?: unknown; message?: unknown } | undefined;
  if (data && isErrorCode(data.code)) {
    return appError(data.code, undefined, typeof data.message === 'string' ? data.message : undefined);
  }
  return null;
}

export function createSocketTransport(o: SocketTransportOptions): Transport {
  const statusL = new Listeners<[ConnStatus, StatusInfo]>();
  const connectL = new Listeners<[]>();
  const openWaiters = new Set<() => void>();
  let status: ConnStatus = 'idle';
  let attempt = 0;
  let busyTimer: ReturnType<typeof setTimeout> | null = null;
  let serverTimer: ReturnType<typeof setTimeout> | null = null;
  let closedByUser = false;
  /** 被同一 token 的另一页面顶替：不自动重连，直到用户选择在此处继续（connect） */
  let replaced = false;
  /** 最近一次 server:notice{shutdown} 给出的重连延迟 */
  let noticeReconnectMs: number | null = null;

  const opts = {
    path: '/socket.io/',
    transports: ['websocket', 'polling'],
    autoConnect: false,
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 8000,
    randomizationFactor: 0.2,
    auth: (cb: (data: object) => void) => cb(o.getAuth()),
  };
  const socket = (o.url ? io(o.url, opts) : io(opts)) as unknown as Socket & LooseSocket;
  const s = socket as unknown as LooseSocket;

  const setStatus = (next: ConnStatus, error?: AppError): void => {
    status = next;
    statusL.emit(next, error ? { attempt, error } : { attempt });
    if (next === 'open') {
      for (const w of [...openWaiters]) w();
      openWaiters.clear();
    }
  };

  s.on('connect', () => {
    attempt = 0;
    setStatus('open');
    connectL.emit();
  });
  const clearServerTimer = (): void => {
    if (serverTimer) clearTimeout(serverTimer);
    serverTimer = null;
  };
  /** 服务器主动断开后按延迟手动重连（socket.io 对这种断开不会自动重连） */
  const scheduleServerReconnect = (): void => {
    clearServerTimer();
    const base = noticeReconnectMs ?? o.serverReconnectMs ?? SERVER_RECONNECT_MS;
    noticeReconnectMs = null;
    const delay = Math.max(0, base) * (1 + Math.random() * 0.5);
    serverTimer = setTimeout(() => {
      serverTimer = null;
      if (!closedByUser && !replaced && !s.connected) s.connect();
    }, delay);
  };

  s.on('session:replaced', (() => {
    replaced = true;
  }) as (...a: never[]) => void);
  s.on('server:notice', ((n: { kind?: string; reconnectInMs?: unknown }) => {
    if (n?.kind === 'shutdown' && typeof n.reconnectInMs === 'number' && Number.isFinite(n.reconnectInMs)) {
      noticeReconnectMs = n.reconnectInMs;
    }
  }) as (...a: never[]) => void);
  s.on('disconnect', ((reason: string) => {
    if (closedByUser || reason === 'io client disconnect' || replaced) setStatus('closed');
    else if (reason === 'io server disconnect') {
      // 停机 / 重启：稍后自动重连（重连成功后由 GameClient 发 room:resume）
      setStatus('reconnecting');
      scheduleServerReconnect();
    } else setStatus('reconnecting');
  }) as (...a: never[]) => void);
  s.io.on('reconnect_attempt', ((n: number) => {
    attempt = n;
    setStatus('reconnecting');
  }) as (...a: never[]) => void);
  s.on('connect_error', ((err: unknown) => {
    const e = handshakeError(err);
    if (e && (e.code === 'PROTOCOL_MISMATCH' || e.code === 'BAD_HANDSHAKE')) {
      s.disconnect();
      setStatus('closed', e);
      return;
    }
    if (e?.code === 'SERVER_BUSY') {
      // 中间件拒绝后 socket.io 不会自动重试
      setStatus('reconnecting', e);
      busyTimer ??= setTimeout(() => {
        busyTimer = null;
        if (!closedByUser && !s.connected) s.connect();
      }, o.busyRetryMs ?? 3000);
      return;
    }
    if (!s.active && !closedByUser) {
      // 被中间件拒绝的其他情况：稍后手动重试
      busyTimer ??= setTimeout(() => {
        busyTimer = null;
        if (!closedByUser && !s.connected) s.connect();
      }, o.busyRetryMs ?? 3000);
    }
    setStatus(status === 'open' || status === 'reconnecting' ? 'reconnecting' : 'connecting', e ?? undefined);
  }) as (...a: never[]) => void);

  const waitOpen = (ms: number): Promise<boolean> => {
    if (s.connected) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (ok: boolean): void => {
        clearTimeout(timer);
        openWaiters.delete(onOpen);
        resolve(ok);
      };
      const onOpen = (): void => done(true);
      const timer = setTimeout(() => done(false), ms);
      openWaiters.add(onOpen);
    });
  };

  return {
    get status() {
      return status;
    },
    connect() {
      closedByUser = false;
      replaced = false;
      clearServerTimer();
      if (s.connected || status === 'connecting') return;
      if (status === 'idle' || status === 'closed') setStatus('connecting');
      s.connect();
    },
    close() {
      closedByUser = true;
      if (busyTimer) clearTimeout(busyTimer);
      busyTimer = null;
      clearServerTimer();
      s.disconnect();
      setStatus('closed');
    },
    async request<E extends C2SEventName>(
      event: E,
      payload: C2SPayload<E>,
      ro: RequestOptions = {},
    ): Promise<Result<C2SAckData<E>>> {
      const ms = ro.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      if (closedByUser) return disconnectedError();
      if (replaced) return replacedError();
      if (!s.connected) {
        // 从未连接，或连接已关闭（服务器断开后等待重连中）：立即发起连接，而不是干等到超时
        if (status === 'idle' || status === 'closed') this.connect();
        else if (serverTimer !== null) {
          clearServerTimer();
          s.connect();
        }
        if (!(await waitOpen(ms))) return replaced ? replacedError() : timeoutError();
      }
      return new Promise((resolve) => {
        s.timeout(ms).emit(event, payload, (err, res) => {
          if (err) resolve(timeoutError());
          else resolve(res as Result<C2SAckData<E>>);
        });
      });
    },
    on<E extends S2CEventName>(event: E, cb: (p: S2CPayload<E>) => void): () => void {
      const h = cb as unknown as (...a: never[]) => void;
      s.on(event, h);
      return () => {
        (socket as unknown as { off(ev: string, cb: unknown): void }).off(event, h);
      };
    },
    onStatus: (cb) => statusL.add(cb),
    onConnect: (cb) => connectL.add(cb),
  };
}
