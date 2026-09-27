/**
 * GET /admin/stats（design/net.md §10.1）：需要 Authorization: Bearer ADMIN_TOKEN；未配置 ADMIN_TOKEN 时 404。
 * 返回房间数、连接数、内存、事件循环延迟 p99（perf_hooks.monitorEventLoopDelay 采样，按窗口滚动）。
 *
 * 管理接口的鉴权（AdminAuth，/admin/stats 与 http/access.ts 的 /admin/access/* 共用）：ADMIN_TOKEN 能签发邀请码、
 * 吊销会话，等于掌握整个门禁，所以鉴权失败按 IP 退避（与登录同样的 AccessLimiter 规则，独立计数）并记 warn 日志；
 * 退避窗口内直接 429，不比对 token。门禁开启时 config.ts 另外要求 ADMIN_TOKEN ≥ 32 字节。
 */
import { timingSafeEqual } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { appError } from '@rich4/shared/net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AccessLimiter } from '../access/limiter';
import { type Logger, silentLogger } from '../infra/logger';

/** 事件循环延迟采样：每 windowMs 滚动一次，报告上一个完整窗口与当前窗口中较差的一个 */
export class EventLoopMonitor {
  private readonly h: ReturnType<typeof monitorEventLoopDelay>;
  private last: { p50: number; p99: number; max: number } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly windowMs = 60_000) {
    this.h = monitorEventLoopDelay({ resolution: 20 });
  }

  start(): void {
    this.h.enable();
    this.timer = setInterval(() => {
      this.last = this.current();
      this.h.reset();
    }, this.windowMs);
    this.timer.unref?.();
  }

  private current(): { p50: number; p99: number; max: number } {
    const ms = (ns: number) => (Number.isFinite(ns) ? Math.round(ns / 1e4) / 100 : 0);
    return { p50: ms(this.h.percentile(50)), p99: ms(this.h.percentile(99)), max: ms(this.h.max) };
  }

  snapshot(): { p50: number; p99: number; max: number; windowMs: number } {
    const cur = this.current();
    const l = this.last;
    const worse = l && l.p99 > cur.p99 ? l : cur;
    return { ...worse, windowMs: this.windowMs };
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.h.disable();
  }
}

/** Bearer token 常数时间比较（http/access.ts 的管理接口共用） */
export function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export type AdminCheck =
  | { ok: true }
  | { ok: false; status: 404 | 401 | 429; code: 'BAD_REQUEST' | 'RATE_LIMITED'; reason: string; retryAfterMs?: number };

export interface AdminAuthOptions {
  token: string | null;
  log?: Logger;
  /** 鉴权失败的按 IP 退避（缺省新建一个 AccessLimiter；只用它的退避，不用全局名额） */
  limiter?: AccessLimiter;
  now?: () => number;
}

/** 管理接口的 Bearer 鉴权：常数时间比较；失败按 IP 退避并记 warn 日志 */
export class AdminAuth {
  private readonly token: string | null;
  private readonly log: Logger;
  readonly limiter: AccessLimiter;

  constructor(o: AdminAuthOptions) {
    this.token = o.token;
    this.log = o.log ?? silentLogger;
    this.limiter = o.limiter ?? new AccessLimiter(o.now ? { now: o.now } : {});
  }

  get enabled(): boolean {
    return this.token !== null;
  }

  check(req: Pick<FastifyRequest, 'headers' | 'ip' | 'url' | 'method'>): AdminCheck {
    if (!this.token) return { ok: false, status: 404, code: 'BAD_REQUEST', reason: 'notFound' };
    const ip = req.ip;
    const wait = this.limiter.retryAfter(ip);
    if (wait > 0) {
      this.log.warn({ ip, path: req.url.split('?')[0], retryAfterMs: wait }, 'admin: auth throttled');
      return { ok: false, status: 429, code: 'RATE_LIMITED', reason: 'rateLimited', retryAfterMs: wait };
    }
    const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '');
    if (!m || !tokenMatches(m[1]!, this.token)) {
      const { fails, alarm } = this.limiter.fail(ip);
      // 不记 Authorization 的内容
      this.log.warn({ ip, method: req.method, path: req.url.split('?')[0], fails }, 'admin: auth failed');
      if (alarm) this.log.error('admin: many failed auth attempts within a minute (possible brute force)');
      return { ok: false, status: 401, code: 'BAD_REQUEST', reason: 'unauthorized' };
    }
    this.limiter.success(ip);
    return { ok: true };
  }

  /** 失败时写好响应并返回它；通过返回 null */
  deny(req: FastifyRequest, reply: FastifyReply): FastifyReply | null {
    const r = this.check(req);
    if (r.ok) return null;
    if (r.status === 401) reply.header('WWW-Authenticate', 'Bearer');
    if (r.retryAfterMs !== undefined)
      reply.header('Retry-After', String(Math.max(1, Math.ceil(r.retryAfterMs / 1000))));
    const details: Record<string, unknown> = { reason: r.reason };
    if (r.retryAfterMs !== undefined) details.retryAfterMs = r.retryAfterMs;
    return reply
      .code(r.status)
      .header('Cache-Control', 'no-store')
      .send({ ok: false, error: appError(r.code, details) });
  }
}

export function registerAdmin(app: FastifyInstance, o: { auth: AdminAuth; stats: () => unknown }): void {
  app.get('/admin/stats', async (req, reply) => {
    const denied = o.auth.deny(req, reply);
    if (denied) return denied;
    return reply.header('Cache-Control', 'no-store').send(o.stats());
  });
}
