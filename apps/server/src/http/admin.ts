/**
 * GET /admin/stats（design/net.md §10.1）：需要 Authorization: Bearer ADMIN_TOKEN；未配置 ADMIN_TOKEN 时 404。
 * 返回房间数、连接数、内存、事件循环延迟 p99（perf_hooks.monitorEventLoopDelay 采样，按窗口滚动）。
 */
import { timingSafeEqual } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { appError } from '@rich4/shared/net';
import type { FastifyInstance } from 'fastify';

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

function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function registerAdmin(app: FastifyInstance, o: { token: string | null; stats: () => unknown }): void {
  app.get('/admin/stats', async (req, reply) => {
    if (!o.token) return reply.code(404).send({ ok: false, error: appError('BAD_REQUEST', { reason: 'notFound' }) });
    const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '');
    if (!m || !tokenMatches(m[1]!, o.token)) {
      return reply
        .code(401)
        .header('WWW-Authenticate', 'Bearer')
        .send({ ok: false, error: appError('BAD_REQUEST', { reason: 'unauthorized' }) });
    }
    return reply.header('Cache-Control', 'no-store').send(o.stats());
  });
}
