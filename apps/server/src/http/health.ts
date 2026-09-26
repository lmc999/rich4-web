/**
 * /healthz：事件循环在跑就 200；/readyz：不在停机中才 200（M5 再加数据库检查）。
 */
import type { FastifyInstance } from 'fastify';

export function registerHealth(app: FastifyInstance, o: { isReady: () => boolean; startedAt: number }): void {
  app.get('/healthz', async () => ({ ok: true, uptimeMs: Date.now() - o.startedAt }));
  app.get('/readyz', async (_req, reply) => {
    const ready = o.isReady();
    return reply.code(ready ? 200 : 503).send({ ready });
  });
}
