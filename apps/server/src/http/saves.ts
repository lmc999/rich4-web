/**
 * 存档导入导出（architecture §5.8 HTTP；design/net.md §8.3）：
 * - GET  /api/saves/:id/export：请求头 X-Player-Token（原始 token，服务器只算 sha256），必须是 owner；
 *   返回 .r4save 文本 `R4S1.<b64url(gzip)>.<sig>`。存档所在对局（或由它读档的对局）仍在进行时 409 SAVE_FORBIDDEN。
 * - POST /api/saves/import：请求体 ≤ 2MB，text/plain 或 application/octet-stream 的 R4S1 文本，
 *   或 JSON {text}；依次 migrateSave、engine.validateState、验签，签名无效时 verified=false（非官方存档）。
 * 响应统一为 { ok, data | error }；按 IP 限流（每分钟 IMPORT_PER_IP_PER_MIN 次）。
 * 经房间邀请链接进入的会话（访问 cookie kind g，只对那个房间有效）不能导入：403 ACCESS_SCOPE（architecture §35；
 * 它们也不能读档，导入没有用处）。导出不限（本人参与过的对局的存档）。
 */
import { appError, type ErrorCode, SAVE_IMPORT_MAX_BYTES, SaveIdSchema, TOKEN_RE } from '@rich4/shared/net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from '../infra/logger';
import { tokenHashOf } from '../net/io';
import type { RateLimiter } from '../net/rateLimit';
import type { SaveService } from '../persistence/SaveService';

export interface SavesHttpDeps {
  saves: SaveService;
  limiter: RateLimiter;
  log: Logger;
}

const STATUS: Partial<Record<ErrorCode, number>> = {
  BAD_REQUEST: 400,
  SAVE_NOT_FOUND: 404,
  SAVE_FORBIDDEN: 409,
  SAVE_INCOMPATIBLE: 422,
  ACCESS_SCOPE: 403,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

function send(reply: FastifyReply, code: ErrorCode, details?: unknown): FastifyReply {
  return reply.code(STATUS[code] ?? 400).send({ ok: false, error: appError(code, details) });
}

function playerTokenHash(req: FastifyRequest): string | null {
  const t = req.headers['x-player-token'];
  return typeof t === 'string' && TOKEN_RE.test(t) ? tokenHashOf(t) : null;
}

/** RFC 5987 的 filename*（保留中文存档名） */
function contentDisposition(ascii: string, name: string): string {
  const utf8 = encodeURIComponent(`${name}.r4save`).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

export async function registerSavesHttp(app: FastifyInstance, d: SavesHttpDeps): Promise<void> {
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/octet-stream', { parseAs: 'string' }, (_req, body, done) => {
      done(null, body);
    });
    scope.setErrorHandler((err: Error & { statusCode?: number; code?: string }, _req, reply) => {
      if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
        return send(reply, 'BAD_REQUEST', { reason: 'tooLarge', maxBytes: SAVE_IMPORT_MAX_BYTES });
      }
      if (err.statusCode !== undefined && err.statusCode < 500) {
        return send(reply, 'BAD_REQUEST', { reason: err.code ?? 'badRequest' });
      }
      d.log.error({ err }, 'saves http failed');
      return send(reply, 'INTERNAL');
    });

    scope.get<{ Params: { id: string } }>('/api/saves/:id/export', async (req, reply) => {
      const th = playerTokenHash(req);
      if (!th) return send(reply, 'BAD_REQUEST', { reason: 'playerToken' });
      if (!SaveIdSchema.safeParse(req.params.id).success) return send(reply, 'SAVE_NOT_FOUND');
      const r = d.saves.exportText(th, req.params.id);
      if (!r.ok) return send(reply, r.error.code, r.error.details);
      return reply
        .header('Content-Type', 'text/plain; charset=utf-8')
        .header('Content-Disposition', contentDisposition(r.data.filename, r.data.name))
        .header('Cache-Control', 'no-store')
        .send(r.data.text);
    });

    scope.post('/api/saves/import', async (req, reply) => {
      if (req.access?.claims?.kind === 'g') return send(reply, 'ACCESS_SCOPE', { reason: 'import' });
      const th = playerTokenHash(req);
      if (!th) return send(reply, 'BAD_REQUEST', { reason: 'playerToken' });
      if (!d.limiter.takeIp(req.ip, 'import')) return send(reply, 'RATE_LIMITED');
      const body: unknown = req.body;
      const text =
        typeof body === 'string'
          ? body
          : body && typeof body === 'object' && typeof (body as { text?: unknown }).text === 'string'
            ? (body as { text: string }).text
            : null;
      if (text === null || text.length === 0) return send(reply, 'BAD_REQUEST', { reason: 'emptyBody' });
      const r = d.saves.importText(th, text);
      if (!r.ok) return send(reply, r.error.code, r.error.details);
      return reply.header('Cache-Control', 'no-store').send(r);
    });
  });
}
