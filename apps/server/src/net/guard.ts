/**
 * 统一的 C2S 处理包装（design/net.md §6.2 第 1–2 步）：限流（按会话）→ zod 校验 → 访问作用域（房间邀请授权的会话只对
 * 那个房间有效，net/accessScope.ts）→ 调用 → 统一 ack 与错误。
 * - 客户端只传 ack、不传 payload 时，payload 视为 {}。
 * - 处理函数抛异常一律回 INTERNAL（记日志，不把异常细节发给客户端）。
 * - seat 只从 session 取，payload 里不带 seat。
 */
import {
  C2S_SCHEMAS,
  type C2SAckData,
  type C2SEventName,
  type C2SPayload,
  type ClientToServerEvents,
  fail,
  type Result,
  type ServerToClientEvents,
} from '@rich4/shared/net';
import type { Socket } from 'socket.io';
import type { Clock } from '../infra/clock';
import type { Logger } from '../infra/logger';
import type { SaveService } from '../persistence/SaveService';
import type { RoomManager } from '../rooms/RoomManager';
import { type AccessScope, checkScope } from './accessScope';
import { bucketOf, type RateLimiter } from './rateLimit';
import type { Session, SessionRegistry } from './sessions';

export interface SocketData {
  tokenHash: string;
  nickname: string;
  ip: string;
  /** 握手时访问 cookie 是房间邀请授权（kind g）：只能在这个房间实例里活动；其他情况为 null */
  scope: AccessScope | null;
}

// biome-ignore lint/complexity/noBannedTypes: Socket.IO 的 InterServerEvents 占位
export type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, {}, SocketData>;

export interface HandlerCtx {
  rooms: RoomManager;
  sessions: SessionRegistry;
  limiter: RateLimiter;
  log: Logger;
  clock: Clock;
  testMode: boolean;
  /** 存档服务（saves:list / saves:delete）；null 表示持久化不可用 */
  saves: SaveService | null;
}

export type Handler<E extends C2SEventName> = (
  p: C2SPayload<E>,
  s: Session,
  socket: AppSocket,
) => Result<C2SAckData<E>>;

type LooseSocket = { id: string; on(ev: string, fn: (...args: unknown[]) => void): void };

/** 注册一个带限流与校验的 C2S 事件处理器 */
export function handle<E extends C2SEventName>(ctx: HandlerCtx, socket: AppSocket, event: E, fn: Handler<E>): void {
  const group = bucketOf(event);
  const schema = C2S_SCHEMAS[event];
  (socket as unknown as LooseSocket).on(event, (...args: unknown[]) => {
    let payload = args[0];
    let ack = args[1];
    if (typeof payload === 'function') {
      ack = payload;
      payload = {};
    }
    const reply = typeof ack === 'function' ? (ack as (r: Result<unknown>) => void) : () => {};
    // 按会话限流（tokenHash 在握手时写入 socket.data）：重连不重置额度
    if (!ctx.limiter.take(socket.data.tokenHash, group)) return reply(fail('RATE_LIMITED'));
    const parsed = schema.safeParse(payload ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 5).map((i) => ({ path: i.path.map(String).join('.'), code: i.code }));
      return reply(fail('BAD_REQUEST', { issues }));
    }
    const session = ctx.sessions.bySocketId(socket.id);
    if (!session) return reply(fail('BAD_HANDSHAKE'));
    const scoped = checkScope(socket.data.scope ?? null, event, parsed.data, session.roomCode, ctx.rooms);
    if (!scoped.ok) return reply(scoped);
    try {
      reply(fn(parsed.data as C2SPayload<E>, session, socket));
    } catch (err) {
      ctx.log.error({ err, event, token: session.tokenHash.slice(0, 8) }, 'handler threw');
      reply(fail('INTERNAL'));
    }
  });
}
