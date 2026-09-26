/**
 * /healthz：事件循环在跑就 200；/readyz：数据库正常且不在停机中才 200（isReady 由 app 组合两者）。
 */
import type { FastifyInstance } from 'fastify';

export function registerHealth(app: FastifyInstance, o: { isReady: () => boolean; startedAt: number }): void {
  app.get('/healthz', async () => ({ ok: true, uptimeMs: Date.now() - o.startedAt }));
  app.get('/readyz', async (_req, reply) => {
    const ready = o.isReady();
    return reply.code(ready ? 200 : 503).send({ ready });
  });
}
