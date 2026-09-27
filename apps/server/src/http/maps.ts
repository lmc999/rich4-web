/**
 * 地图 API（architecture §5.8 HTTP）：
 * - GET /api/maps：列出全部地图（fixture 与 RICH4_DATA_DIR 中通过校验的地图；playable=false 的只列出不可开局）。
 * - GET /api/maps/:id?h=<mapHash>：返回 MapDef；带 h 且一致时 Cache-Control: immutable，h 不一致返回 404。
 * 访问门禁开启时 /api/* 受保护：http/access.ts 的 onSend 把这里的 `public, max-age=1 年, immutable` 改写成
 * `private, max-age=30 天`（共享缓存不能把地图数据转给未授权者，便于吊销），长缓存响应上也不附带续期 cookie。
 */
import { appError } from '@rich4/shared/net';
import type { FastifyInstance } from 'fastify';
import type { MapCatalog } from '../data/DataRegistry';

export function registerMaps(app: FastifyInstance, catalog: MapCatalog): void {
  const cache = new Map<string, string>();
  const jsonOf = (id: string): string | null => {
    const hit = cache.get(id);
    if (hit !== undefined) return hit;
    const def = catalog.def(id);
    if (!def) return null;
    const s = JSON.stringify(def);
    cache.set(id, s);
    return s;
  };

  app.get('/api/maps', async (_req, reply) => {
    reply.header('Cache-Control', 'no-cache');
    return { defaultMap: catalog.defaultMap, maps: catalog.list() };
  });

  app.get<{ Params: { id: string }; Querystring: { h?: string } }>('/api/maps/:id', async (req, reply) => {
    const def = catalog.def(req.params.id);
    const body = jsonOf(req.params.id);
    if (!def || body === null) return reply.code(404).send({ ok: false, error: appError('MAP_UNAVAILABLE') });
    const h = req.query.h;
    if (h !== undefined && h !== def.meta.dataHash) {
      return reply.code(404).send({ ok: false, error: appError('MAP_UNAVAILABLE', { mapHash: def.meta.dataHash }) });
    }
    reply.header('ETag', `"${def.meta.dataHash}"`);
    reply.header('Cache-Control', h !== undefined ? 'public, max-age=31536000, immutable' : 'no-cache');
    if (req.headers['if-none-match'] === `"${def.meta.dataHash}"`) return reply.code(304).send();
    return reply.type('application/json; charset=utf-8').send(body);
  });
}
