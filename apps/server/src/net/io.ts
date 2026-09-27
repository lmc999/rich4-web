/**
 * Socket.IO 服务（design/net.md §1、§4、§5.1）：握手校验、会话挂载与顶替、连接数限制、注册处理器。
 * 不启用 connectionStateRecovery：断线恢复完全由应用层 room:resume 负责。
 */
import { createHash } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { BlockList, isIP } from 'node:net';
import {
  appError,
  type ClientToServerEvents,
  HandshakeAuthSchema,
  isValidNickname,
  MAX_CONNECTIONS_PER_IP,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  type S2CEventName,
  type S2CPayload,
  type ServerToClientEvents,
  sanitizeNickname,
} from '@rich4/shared/net';
import { Server } from 'socket.io';
import type { Emitter } from '../rooms/RoomBroadcaster';
import type { AppSocket, HandlerCtx, SocketData } from './guard';
import { registerChatHandlers } from './handlers/chat';
import { registerDebugHandlers } from './handlers/debug';
import { registerGameHandlers } from './handlers/game';
import { registerLobbyHandlers } from './handlers/lobby';
import { MinigameRelay, type RawEmit, registerMinigameHandlers } from './handlers/minigame';
import { registerRoomHandlers } from './handlers/room';
import { registerSavesHandlers } from './handlers/saves';
import { registerTimeHandlers } from './handlers/time';

// biome-ignore lint/complexity/noBannedTypes: Socket.IO 的 InterServerEvents 占位
export type AppServer = Server<ClientToServerEvents, ServerToClientEvents, {}, SocketData>;

export interface IoOptions {
  trustProxy: boolean;
  devCorsOrigin: string | null;
  maxConnectionsPerIp?: number;
}

export function createIo(http: HttpServer, o: IoOptions): AppServer {
  return new Server(http, {
    path: '/socket.io/',
    serveClient: false,
    transports: ['websocket', 'polling'],
    pingInterval: 10_000,
    pingTimeout: 8_000,
    maxHttpBufferSize: MAX_MESSAGE_BYTES,
    perMessageDeflate: { threshold: 2048 },
    httpCompression: { threshold: 2048 },
    cleanupEmptyChildNamespaces: true,
    ...(o.devCorsOrigin ? { cors: { origin: o.devCorsOrigin } } : {}),
  });
}

/** 直接按 socket id 发送 */
function rawEmit(io: AppServer): RawEmit {
  return (ids, event, payload) => {
    if (ids.length === 0) return;
    (io.to([...ids]) as unknown as { emit(ev: string, p: unknown): void }).emit(event, payload);
  };
}

/** 每个 io 的小游戏投递（attachIo 时建立；emitter 在发出对局消息之后调用它补发观战票据与积压帧） */
const relays = new WeakMap<AppServer, MinigameRelay>();

export function ioEmitter(io: AppServer): Emitter {
  const send = rawEmit(io);
  return {
    emit<E extends S2CEventName>(ids: readonly string[], event: E, payload: S2CPayload<E>): void {
      if (ids.length === 0) return;
      send(ids, event, payload);
      relays.get(io)?.afterEmit(ids, event, payload);
    },
  };
}

/** 可信代理网段：本机与私有网段（compose / 容器网络、同机反代）（design/net.md §10.3） */
const TRUSTED_PROXIES = (() => {
  const b = new BlockList();
  b.addSubnet('127.0.0.0', 8, 'ipv4');
  b.addSubnet('10.0.0.0', 8, 'ipv4');
  b.addSubnet('172.16.0.0', 12, 'ipv4');
  b.addSubnet('192.168.0.0', 16, 'ipv4');
  b.addSubnet('169.254.0.0', 16, 'ipv4');
  b.addAddress('::1', 'ipv6');
  b.addSubnet('fc00::', 7, 'ipv6');
  b.addSubnet('fe80::', 10, 'ipv6');
  return b;
})();

/** 去掉 IPv4-mapped IPv6 前缀（::ffff:1.2.3.4 → 1.2.3.4） */
function normalizeIp(addr: string): string {
  const a = addr.trim();
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  return m ? m[1]! : a;
}

export function isTrustedProxy(addr: string): boolean {
  const a = normalizeIp(addr);
  const v = isIP(a);
  if (v === 0) return false;
  return TRUSTED_PROXIES.check(a, v === 4 ? 'ipv4' : 'ipv6');
}

/**
 * 客户端 IP：TRUST_PROXY=1 且直连对端是可信代理（本机或私有网段）时才看 X-Forwarded-For，
 * 从右往左跳过可信代理，取第一个不可信的地址（nginx 的 $proxy_add_x_forwarded_for 会把真实对端追加在最右，
 * 最左段可以被客户端伪造）；否则一律用直连地址。
 */
export function clientIp(socket: Pick<AppSocket, 'handshake'>, trustProxy: boolean): string {
  const peer = normalizeIp(socket.handshake.address || '');
  if (trustProxy && peer !== '' && isTrustedProxy(peer)) {
    const xff = socket.handshake.headers['x-forwarded-for'];
    const hops = (Array.isArray(xff) ? xff.join(',') : (xff ?? ''))
      .split(',')
      .map(normalizeIp)
      .filter((x) => isIP(x) !== 0);
    for (let i = hops.length - 1; i >= 0; i--) if (!isTrustedProxy(hops[i]!)) return hops[i]!;
    if (hops.length > 0) return hops[0]!;
  }
  return peer || 'unknown';
}

function handshakeError(code: 'BAD_HANDSHAKE' | 'PROTOCOL_MISMATCH' | 'SERVER_BUSY'): Error {
  const err = new Error(code) as Error & { data: unknown };
  err.data = appError(code);
  return err;
}

export function tokenHashOf(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 挂上握手中间件与连接处理 */
export function attachIo(io: AppServer, ctx: HandlerCtx, o: IoOptions): void {
  const perIp = new Map<string, number>();
  const relay = new MinigameRelay(ctx, rawEmit(io));
  relays.set(io, relay);
  const limit = o.maxConnectionsPerIp ?? MAX_CONNECTIONS_PER_IP;

  io.use((socket, next) => {
    const parsed = HandshakeAuthSchema.safeParse(socket.handshake.auth);
    if (!parsed.success) return next(handshakeError('BAD_HANDSHAKE'));
    if (parsed.data.protocolVersion !== PROTOCOL_VERSION) return next(handshakeError('PROTOCOL_MISMATCH'));
    const nickname = sanitizeNickname(parsed.data.nickname);
    if (!isValidNickname(nickname)) return next(handshakeError('BAD_HANDSHAKE'));
    const ip = clientIp(socket, o.trustProxy);
    if ((perIp.get(ip) ?? 0) >= limit) return next(handshakeError('SERVER_BUSY'));
    socket.data = { tokenHash: tokenHashOf(parsed.data.token), nickname, ip };
    next();
  });

  io.on('connection', (socket) => {
    const { tokenHash, nickname, ip } = socket.data;
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    const { session, replaced } = ctx.sessions.attach(tokenHash, nickname, socket.id, ip);
    if (replaced) {
      const old = io.sockets.sockets.get(replaced);
      if (old) {
        old.emit('session:replaced', {});
        old.disconnect(true);
      }
      if (session.roomCode) {
        const code = session.roomCode;
        safely(ctx, 'replace', () => ctx.rooms.get(code)?.socketDisconnected(tokenHash, replaced));
      }
    }
    registerLobbyHandlers(ctx, socket);
    registerRoomHandlers(ctx, socket);
    registerGameHandlers(ctx, socket);
    registerMinigameHandlers(ctx, socket, relay);
    registerChatHandlers(ctx, socket);
    registerSavesHandlers(ctx, socket);
    registerTimeHandlers(ctx, socket);
    if (ctx.testMode) registerDebugHandlers(ctx, socket);

    socket.on('disconnect', () => {
      const n = (perIp.get(ip) ?? 1) - 1;
      if (n <= 0) perIp.delete(ip);
      else perIp.set(ip, n);
      const s = ctx.sessions.detach(socket.id);
      const code = s?.roomCode;
      if (s && code) safely(ctx, 'disconnect', () => ctx.rooms.get(code)?.socketDisconnected(s.tokenHash, socket.id));
    });
  });
}

/** guard 之外的连接事件回调：异常只记日志，不能变成 uncaughtException 拖垮所有房间 */
function safely(ctx: HandlerCtx, what: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    ctx.log.error({ err, what }, 'connection callback threw');
  }
}
