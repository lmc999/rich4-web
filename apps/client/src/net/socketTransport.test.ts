// socketTransport 的传输选项与断线处理：WebSocket 被拦时降级长轮询；服务器主动断开（停机 / 重启）后自动重连；被顶替后不重连、请求立即失败（socket.io-client 用假实现）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnStatus } from './transport';

type Handler = (...a: unknown[]) => void;

class FakeSocket {
  connected = false;
  active = false;
  connectCalls = 0;
  readonly handlers = new Map<string, Handler[]>();
  readonly ioHandlers = new Map<string, Handler[]>();
  readonly emitted: { ev: string; payload: unknown }[] = [];
  readonly io = {
    on: (ev: string, cb: Handler) => {
      this.ioHandlers.set(ev, [...(this.ioHandlers.get(ev) ?? []), cb]);
    },
  };
  on(ev: string, cb: Handler): void {
    this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), cb]);
  }
  off(): void {}
  connect(): void {
    this.connectCalls++;
    this.active = true;
  }
  disconnect(): void {
    this.connected = false;
    this.active = false;
    this.fire('disconnect', 'io client disconnect');
  }
  timeout(_ms: number) {
    return {
      emit: (ev: string, payload: unknown, cb: (err: unknown, res: unknown) => void) => {
        this.emitted.push({ ev, payload });
        cb(null, { ok: true, data: { ev } });
      },
    };
  }
  fire(ev: string, ...a: unknown[]): void {
    for (const h of this.handlers.get(ev) ?? []) h(...a);
  }
  /** 模拟连接建立 */
  open(): void {
    this.connected = true;
    this.fire('connect');
  }
}

let fake: FakeSocket;
/** 最近一次 io() 收到的选项 */
let ioOpts: Record<string, unknown> | null = null;

vi.mock('socket.io-client', () => ({
  io: (...a: unknown[]) => {
    ioOpts = (a.find((x) => typeof x === 'object' && x !== null) as Record<string, unknown> | undefined) ?? null;
    return fake;
  },
}));

const { createSocketTransport, SERVER_RECONNECT_MS } = await import('./socketTransport');

function make(o: { serverReconnectMs?: number } = {}) {
  const t = createSocketTransport({
    getAuth: () => ({ token: 'x'.repeat(22), nickname: 'n', protocolVersion: 1, clientVersion: 'test' }),
    ...o,
  });
  const statuses: ConnStatus[] = [];
  t.onStatus((s) => statuses.push(s));
  return { t, statuses };
}

beforeEach(() => {
  fake = new FakeSocket();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('socketTransport：传输方式', () => {
  it('先试 WebSocket，握手失败（代理拦 Upgrade）时本次连接改试长轮询', () => {
    make();
    expect(ioOpts).toMatchObject({ transports: ['websocket', 'polling'], tryAllTransports: true });
  });
});

describe('socketTransport：服务器主动断开', () => {
  it('停机通知后被服务器断开：按 reconnectInMs（加抖动）自动 connect，而不是停在 closed', () => {
    const { t, statuses } = make();
    t.connect();
    fake.open();
    expect(t.status).toBe('open');
    fake.fire('server:notice', { kind: 'shutdown', message: 'bye', reconnectInMs: 1000 });
    fake.connected = false;
    fake.fire('disconnect', 'io server disconnect');
    expect(t.status).toBe('reconnecting');
    expect(statuses.at(-1)).toBe('reconnecting');
    const before = fake.connectCalls;
    vi.advanceTimersByTime(999);
    expect(fake.connectCalls).toBe(before);
    vi.advanceTimersByTime(600);
    expect(fake.connectCalls).toBe(before + 1);
    fake.open();
    expect(t.status).toBe('open');
  });

  it('没有停机通知时按缺省延迟重连；等待期间发请求立即重连', async () => {
    const { t } = make();
    t.connect();
    fake.open();
    fake.connected = false;
    fake.fire('disconnect', 'io server disconnect');
    const before = fake.connectCalls;
    const p = t.request('lobby:list', {});
    expect(fake.connectCalls).toBe(before + 1);
    fake.open();
    await expect(p).resolves.toMatchObject({ ok: true });
    // 缺省延迟的定时器已被请求取消，不会再重复 connect
    vi.advanceTimersByTime(SERVER_RECONNECT_MS * 2);
    expect(fake.connectCalls).toBe(before + 1);
  });

  it('被顶替：不自动重连，请求立即返回 replaced；用户接管（connect）后恢复', async () => {
    const { t } = make();
    t.connect();
    fake.open();
    fake.fire('session:replaced', {});
    fake.connected = false;
    fake.fire('disconnect', 'io server disconnect');
    expect(t.status).toBe('closed');
    const before = fake.connectCalls;
    vi.advanceTimersByTime(SERVER_RECONNECT_MS * 3);
    expect(fake.connectCalls).toBe(before);
    const r = await t.request('room:create', {});
    expect(r).toMatchObject({ ok: false, error: { code: 'INTERNAL', details: { reason: 'replaced' } } });
    expect(fake.emitted).toEqual([]);
    t.connect();
    expect(fake.connectCalls).toBe(before + 1);
    fake.open();
    await expect(t.request('lobby:list', {})).resolves.toMatchObject({ ok: true });
  });

  it('连接已关闭（非用户主动）时请求会先发起连接，而不是等满超时', async () => {
    const { t } = make();
    t.connect();
    fake.open();
    // 握手之外的原因导致 closed（例如之前被拒后），request 触发 connect
    fake.connected = false;
    fake.fire('disconnect', 'io server disconnect');
    vi.advanceTimersByTime(SERVER_RECONNECT_MS * 2);
    fake.fire('connect_error', new Error('down'));
    const calls = fake.connectCalls;
    t.close();
    expect(await t.request('lobby:list', {})).toMatchObject({
      ok: false,
      error: { details: { reason: 'disconnected' } },
    });
    expect(fake.connectCalls).toBe(calls);
  });
});

describe('socketTransport：握手被访问门禁拒绝', () => {
  it('ACCESS_REQUIRED：断开并停在 closed（带错误码），不再自动重试', () => {
    const { t } = make();
    const errors: (string | undefined)[] = [];
    t.onStatus((_s, info) => errors.push(info.error?.code));
    t.connect();
    const calls = fake.connectCalls;
    const err = Object.assign(new Error('access'), {
      data: { code: 'ACCESS_REQUIRED', details: { reason: 'missing' } },
    });
    fake.fire('connect_error', err);
    expect(t.status).toBe('closed');
    expect(errors).toContain('ACCESS_REQUIRED');
    vi.advanceTimersByTime(60_000);
    expect(fake.connectCalls).toBe(calls);
  });
});
