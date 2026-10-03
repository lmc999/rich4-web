/**
 * Socket.IO 服务（design/net.md §1、§4、§5.1）：握手校验、会话挂载与顶替、连接数限制、注册处理器。
 * 不启用 connectionStateRecovery：断线恢复完全由应用层 room:resume 负责。
 * 访问门禁（docs/design/original-skin.md U4）：ACCESS_MODE != off 时握手必须带有效的 r4_access cookie，
 * 否则 connect_error.data 为 ACCESS_REQUIRED（先于其他握手检查）；握手响应顺带滑动续期 cookie。
 * cookie 是房间邀请授权（kind g）时把绑定的房间实例记进 socket.data.scope，之后的事件由 guard 按作用域限制
 * （net/accessScope.ts，architecture §35）；连接期间 cookie 到期或换绑不影响已建立的连接，下次握手才按新 cookie。
 * 门禁在命名空间中间件里判（HTTP 层的 allowRequest 只能回 403，客户端拿不到 ACCESS_REQUIRED 错误码）；
 * 拒绝之后 CONNECT_ERROR 一送出就关闭底层 engine.io 连接，未授权者不能占着会话（含 WebSocket）等到 connectTimeout。
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
import type { AccessControl } from '../access/AccessControl';
import type { Logger } from '../infra/logger';
import type { Emitter } from '../rooms/RoomBroadcaster';
import type { AccessScope } from './accessScope';
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
  /** 访问门禁；缺省或未启用时不检查 */
  access?: AccessControl;
  /**
   * 生产环境且 TRUST_PROXY=1 时打开：第一次遇到解析成本机或私有地址的客户端 IP 时记一条 warn（见 privateClientIpWarner）。
   */
  warnPrivateClientIp?: boolean;
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

/**
 * 客户端 IP 塌缩告警（M11 审查）：反代前面还有一跳而 Caddy 没有信任它时——宿主 IPv6 经 docker-proxy 转发到只有 IPv4 的
 * compose 网络、前置反代 / 隧道 / CDN——所有玩家都会显示成同一个网关或代理地址，按 IP 的限流、连接数上限与门禁退避
 * 对这些人一起生效（一个人输错口令，全部人被 429）。这种地址总是本机或私有网段，所以生产环境第一次解析出这样的
 * 客户端 IP 时打一条 warn（每个进程只打一次）；局域网部署（玩家本来就是内网地址）可以忽略。处理见 docs/deploy.md §7。
 */
export function privateClientIpWarner(log: Pick<Logger, 'warn'>): (ip: string, peer: string) => void {
  let warned = false;
  return (ip, peer) => {
    if (warned || !isTrustedProxy(ip)) return;
    warned = true;
    log.warn(
      { ip, peer },
      'client ip resolves to a private address behind TRUST_PROXY=1: players may all share one IP for rate limits ' +
        '(IPv6 via docker-proxy, or an untrusted front proxy/CDN; see docs/deploy.md §7)',
    );
  };
}

function handshakeError(
  code: 'BAD_HANDSHAKE' | 'PROTOCOL_MISMATCH' | 'SERVER_BUSY' | 'ACCESS_REQUIRED',
  details?: unknown,
): Error {
  const err = new Error(code) as Error & { data: unknown };
  err.data = appError(code, details);
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
  const access = o.access?.enabled ? o.access : null;
  const warnPrivateIp = o.warnPrivateClientIp && o.trustProxy ? privateClientIpWarner(ctx.log) : null;

  if (access) {
    // 握手的第一个 HTTP 响应（polling 握手或 WebSocket 升级）上滑动续期
    io.engine.on(
      'initial_headers',
      (headers: Record<string, string | string[]>, req: { headers: { cookie?: string } }) => {
        const g = access.check(req.headers.cookie);
        if (g.granted && g.renew) headers['set-cookie'] = g.renew;
      },
    );
  }

  io.use((socket, next) => {
    let scope: AccessScope | null = null;
    if (access) {
      const g = access.check(socket.handshake.headers.cookie);
      if (!g.granted) {
        next(handshakeError('ACCESS_REQUIRED', { reason: g.reason }));
        // CONNECT_ERROR 在 process.nextTick 里入队；之后关闭连接（不丢弃缓冲：polling 下等客户端取走错误包再关）
        setImmediate(() => {
          if (socket.conn.readyState === 'open') socket.conn.close();
        });
        return;
      }
      const bound = g.claims?.room;
      if (bound) scope = { room: bound.code, instance: bound.instance };
    }
    const parsed = HandshakeAuthSchema.safeParse(socket.handshake.auth);
    if (!parsed.success) return next(handshakeError('BAD_HANDSHAKE'));
    if (parsed.data.protocolVersion !== PROTOCOL_VERSION) return next(handshakeError('PROTOCOL_MISMATCH'));
    const nickname = sanitizeNickname(parsed.data.nickname);
    if (!isValidNickname(nickname)) return next(handshakeError('BAD_HANDSHAKE'));
    const ip = clientIp(socket, o.trustProxy);
    warnPrivateIp?.(ip, socket.handshake.address);
    if ((perIp.get(ip) ?? 0) >= limit) return next(handshakeError('SERVER_BUSY'));
    socket.data = { tokenHash: tokenHashOf(parsed.data.token), nickname, ip, scope };
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
