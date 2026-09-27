/**
 * 访问门禁的 HTTP 部分（docs/design/original-skin.md U4、§3 修正 3；design-draft §5.3）。
 *
 * 门禁范围（ACCESS_MODE != off）：`/pack/*` 与 `/api/*`（`/api/access*` 除外）要求有效的 r4_access cookie，
 * 否则 401 `{ ok:false, error:{ code:'ACCESS_REQUIRED', details:{ reason } } }`。按**匹配到的路由模式**判定
 * （`req.routeOptions.url`），未匹配的请求退回按原始路径判定。`/healthz`、`/readyz`、`/robots.txt`、SPA 外壳、
 * `/assets/*`、`/admin/*`（自有 Bearer，见 http/admin.ts 的 AdminAuth）保持公开；Socket.IO 握手由 net/io.ts 的 io.use 检查。
 *
 * 受保护响应的缓存（onSend，门禁开启时）：路由给的 `public` 一律改成 `private`，去掉 `immutable`，max-age 封顶 30 天
 * （与 /pack 文件相同，§3 修正 3：便于吊销），没有 Cache-Control 的补 `private, no-cache`——共享缓存（CDN、反代缓存）
 * 不能把受保护的内容转给未授权者。滑动续期的 Set-Cookie **只加在不可被共享缓存存储的响应上**（no-store，或 private 且
 * no-cache，例如 /api/maps 列表、manifest），长缓存的响应（/api/maps/:id?h=、带哈希的 /pack 文件）不带 Set-Cookie。
 *
 * 路由（契约见 shared/net/access.ts）：
 * - GET  /api/access          当前状态（顺带滑动续期；cookie 已失效时清掉它）
 * - POST /api/access          {passcode} 口令或邀请码 → Set-Cookie
 * - POST /api/access/grant    {room} 生成房间邀请授权（24 小时、8 次）
 * - POST /api/access/redeem   {token} 兑换房间授权 → Set-Cookie
 * - POST /api/access/logout   清除 cookie
 * 管理（Bearer ADMIN_TOKEN；未配置时 404）：GET/POST /admin/access/invites、DELETE /admin/access/invites/:id、
 * POST /admin/access/revoke（epoch + 1）。
 *
 * POST 一律要求 `Content-Type: application/json`（含 logout：跨站 text/plain 表单不能强制登出）；
 * 请求体（口令、token）永不写日志。
 */
import { AccessGrantBodySchema, AccessLoginBodySchema, AccessRedeemBodySchema, appError } from '@rich4/shared/net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AccessControl, AccessFailure, GateCheck } from '../access/AccessControl';
import type { Logger } from '../infra/logger';
import type { AdminAuth } from './admin';
import { applyPackHeaders, isPackPath, PACK_FILE_MAX_AGE_S } from './pack';

declare module 'fastify' {
  interface FastifyRequest {
    /** 门禁检查结果（只在受门禁保护的路由上有值） */
    access: GateCheck | null;
  }
}

export interface AccessHttpDeps {
  access: AccessControl;
  log: Logger;
  /** 管理接口鉴权（Bearer ADMIN_TOKEN；与 /admin/stats 共用退避） */
  admin: AdminAuth;
}

/**
 * 受门禁保护的范围：'pack' | 'api'；公开路径返回 null。
 * 路由模式与原始路径**任一**落在受保护范围就算受保护（编码、`..` 之类的写法无法借 /api/access 前缀绕过）。
 */
export function gateScope(routeUrl: string | undefined, rawUrl: string): 'pack' | 'api' | null {
  const raw = rawUrl.split('?')[0] ?? '';
  const paths = routeUrl === undefined ? [raw] : [routeUrl, raw];
  if (paths.some(isPackPath)) return 'pack';
  const isAccessRoute = (s: string) => s === '/api/access' || s.startsWith('/api/access/');
  if (paths.some((s) => s.startsWith('/api/') && !isAccessRoute(s))) return 'api';
  return null;
}

/**
 * 门禁开启时受保护响应的 Cache-Control：public → private、去掉 immutable、max-age 封顶 maxAgeS；缺省 `private, no-cache`。
 */
export function gatedCacheControl(cc: string | undefined, maxAgeS = PACK_FILE_MAX_AGE_S): string {
  if (!cc || cc.trim() === '') return 'private, no-cache';
  const out: string[] = [];
  let hasPrivate = false;
  for (const raw of cc.split(',')) {
    const d = raw.trim();
    if (d === '') continue;
    const name = d.split('=')[0]!.trim().toLowerCase();
    if (name === 'public' || name === 'immutable' || name === 's-maxage') continue;
    if (name === 'private') hasPrivate = true;
    if (name === 'max-age') {
      const v = Number(d.slice(d.indexOf('=') + 1).trim());
      out.push(`max-age=${Number.isFinite(v) ? Math.max(0, Math.min(maxAgeS, Math.floor(v))) : 0}`);
      continue;
    }
    out.push(d);
  }
  const noStore = out.some((d) => d.toLowerCase() === 'no-store');
  if (!hasPrivate && !noStore) out.unshift('private');
  return out.length > 0 ? out.join(', ') : 'private, no-cache';
}

/** 共享缓存与浏览器都不会把这个响应当作可复用的新鲜副本：可以安全地附带 Set-Cookie */
export function cookieSafeCacheControl(cc: string | undefined): boolean {
  if (!cc) return false;
  const ds = cc
    .toLowerCase()
    .split(',')
    .map((d) => d.trim());
  if (ds.includes('no-store')) return true;
  return ds.includes('private') && ds.includes('no-cache');
}

function sendFailure(reply: FastifyReply, f: AccessFailure): FastifyReply {
  if (f.retryAfterMs !== undefined) reply.header('Retry-After', String(Math.max(1, Math.ceil(f.retryAfterMs / 1000))));
  return reply
    .code(f.status)
    .header('Cache-Control', 'no-store')
    .send({ ok: false, error: appError(f.code, f.details) });
}

function badRequest(reply: FastifyReply, reason: string): FastifyReply {
  return sendFailure(reply, { ok: false, status: 400, code: 'BAD_REQUEST', details: { reason } });
}

function isJson(req: FastifyRequest): boolean {
  const ct = req.headers['content-type'];
  return typeof ct === 'string' && /^application\/json\b/i.test(ct.trim());
}

const STALE_REASONS = new Set(['expired', 'revoked', 'badSignature', 'malformed']);

const InviteCreateSchema = z.strictObject({
  uses: z.int().min(1).max(1000).optional(),
  days: z.number().positive().max(3650).nullable().optional(),
  note: z.string().max(200).optional(),
});

export async function registerAccess(app: FastifyInstance, d: AccessHttpDeps): Promise<void> {
  const ac = d.access;
  app.decorateRequest('access', null);

  // 门禁钩子（全局）
  app.addHook('onRequest', async (req, reply) => {
    if (!ac.enabled) return;
    const scope = gateScope(req.routeOptions.url, req.url);
    if (!scope) return;
    const g = ac.check(req.headers.cookie);
    req.access = g;
    if (!g.granted) {
      if (scope === 'pack') applyPackHeaders(reply);
      return reply
        .code(401)
        .header('Cache-Control', 'no-store')
        .send({ ok: false, error: appError('ACCESS_REQUIRED', { reason: g.reason }) });
    }
  });

  // 受保护响应：不许共享缓存存储（public → private 等）；滑动续期只加在不可缓存的响应上
  app.addHook('onSend', async (req, reply, payload) => {
    if (!ac.enabled || !gateScope(req.routeOptions.url, req.url)) return payload;
    const raw = reply.getHeader('cache-control');
    const cc = gatedCacheControl(typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.join(', ') : undefined);
    reply.header('Cache-Control', cc);
    const renew = req.access?.granted ? req.access.renew : null;
    if (renew && cookieSafeCacheControl(cc)) reply.header('Set-Cookie', renew);
    return payload;
  });

  await app.register(async (scope) => {
    scope.setErrorHandler((err: Error & { statusCode?: number; code?: string }, _req, reply) => {
      if (err.statusCode !== undefined && err.statusCode < 500) return badRequest(reply, err.code ?? 'badRequest');
      d.log.error({ err: { message: err.message, code: err.code } }, 'access http failed');
      return sendFailure(reply, { ok: false, status: 500, code: 'INTERNAL' });
    });

    const withCookie = (reply: FastifyReply, setCookie: string | null): FastifyReply => {
      if (setCookie) reply.header('Set-Cookie', setCookie);
      return reply.header('Cache-Control', 'no-store');
    };

    scope.get('/api/access', async (req, reply) => {
      const g = ac.check(req.headers.cookie);
      let setCookie = g.renew;
      if (!g.granted && g.reason && STALE_REASONS.has(g.reason)) setCookie = ac.clearCookie();
      return withCookie(reply, setCookie).send({ ok: true, data: ac.statusOf(g) });
    });

    scope.post('/api/access', async (req, reply) => {
      if (!isJson(req)) return badRequest(reply, 'contentType');
      const body = AccessLoginBodySchema.safeParse(req.body);
      if (!body.success) return badRequest(reply, 'body');
      const r = await ac.login(body.data.passcode, req.ip);
      if (!r.ok) return sendFailure(reply, r);
      return withCookie(reply, r.setCookie).send({ ok: true, data: r.data });
    });

    scope.post('/api/access/grant', async (req, reply) => {
      if (!isJson(req)) return badRequest(reply, 'contentType');
      const body = AccessGrantBodySchema.safeParse(req.body);
      if (!body.success) return badRequest(reply, 'body');
      const r = ac.grant(ac.check(req.headers.cookie), body.data.room, req.ip);
      if (!r.ok) return sendFailure(reply, r);
      return withCookie(reply, r.setCookie).send({ ok: true, data: r.data });
    });

    scope.post('/api/access/redeem', async (req, reply) => {
      if (!isJson(req)) return badRequest(reply, 'contentType');
      const body = AccessRedeemBodySchema.safeParse(req.body);
      if (!body.success) return badRequest(reply, 'body');
      const r = await ac.redeem(ac.check(req.headers.cookie), body.data.token, req.ip);
      if (!r.ok) return sendFailure(reply, r);
      return withCookie(reply, r.setCookie).send({ ok: true, data: r.data });
    });

    scope.post('/api/access/logout', async (req, reply) => {
      if (!isJson(req)) return badRequest(reply, 'contentType');
      const setCookie = ac.enabled ? ac.clearCookie() : null;
      return withCookie(reply, setCookie).send({
        ok: true,
        data: ac.statusOf({ granted: !ac.enabled, claims: null }),
      });
    });

    // ───────────── 管理（Bearer ADMIN_TOKEN；失败按 IP 退避并记日志） ─────────────
    const admin = (req: FastifyRequest, reply: FastifyReply): FastifyReply | null => {
      const denied = d.admin.deny(req, reply);
      if (denied) return denied;
      if (!ac.enabled) {
        return reply
          .code(409)
          .header('Cache-Control', 'no-store')
          .send({ ok: false, error: appError('BAD_REQUEST', { reason: 'accessOff' }) });
      }
      reply.header('Cache-Control', 'no-store');
      return null;
    };

    scope.get('/admin/access/invites', async (req, reply) => {
      const denied = admin(req, reply);
      if (denied) return denied;
      return reply.send({ ok: true, data: { invites: ac.listInvites(), epoch: ac.epoch() } });
    });

    scope.post('/admin/access/invites', async (req, reply) => {
      const denied = admin(req, reply);
      if (denied) return denied;
      const body = InviteCreateSchema.safeParse(req.body ?? {});
      if (!body.success) return badRequest(reply, 'body');
      const r = ac.createInvite({
        uses: body.data.uses ?? 1,
        days: body.data.days === undefined ? 7 : body.data.days,
        ...(body.data.note ? { note: body.data.note } : {}),
      });
      d.log.info({ id: r.invite.id, uses: r.invite.usesLeft }, 'access: invite created (admin)');
      return reply.send({ ok: true, data: r });
    });

    scope.delete<{ Params: { id: string } }>('/admin/access/invites/:id', async (req, reply) => {
      const denied = admin(req, reply);
      if (denied) return denied;
      const ok = ac.revokeInvite(req.params.id);
      return reply.code(ok ? 200 : 404).send(ok ? { ok: true, data: { id: req.params.id } } : { ok: false });
    });

    scope.post('/admin/access/revoke', async (req, reply) => {
      const denied = admin(req, reply);
      if (denied) return denied;
      return reply.send({ ok: true, data: { epoch: ac.revokeAll() } });
    });
  });
}
