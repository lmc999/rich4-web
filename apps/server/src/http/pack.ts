/**
 * `/pack/*`：原版皮肤素材包（docs/design/original-skin.md §3 修正 3/4；design-draft §5.2）。
 *
 * - **永远注册**：没有启用素材包时返回 404 JSON（前端 PackClient 把非 JSON 或校验失败一律当作「没有素材包」），
 *   http/static.ts 的 SPA 回退也排除了 /pack/，不会拿 index.html 冒充 manifest。
 * - 白名单：只提供 PackRegistry.lookup 命中的路径与 manifest.json，其余 404。
 * - 缓存：带哈希的文件 `private, max-age=2592000`（30 天，不用 1 年 immutable，吊销后旧副本最多留 30 天）；
 *   manifest `private, no-cache`，ETag = packId，按 Accept-Encoding 返回 br/gzip。
 * - .flc / .json 的预压缩变体按 Accept-Encoding 返回并带 `Vary: Accept-Encoding`；带 Range 的请求一律按原始字节处理。
 * - Range：单段 `bytes=a-b` / `a-` / `-n` 返回 206；不可满足 416；多段或语法错误时忽略 Range 返回完整内容。
 * - 全部响应（含 401/404）：`X-Content-Type-Options: nosniff`、`Cross-Origin-Resource-Policy: same-origin`、
 *   `X-Robots-Tag: noindex, nofollow, noarchive`。按**匹配到的路由模式**（`/pack`、`/pack/*`）或原始路径判定：
 *   百分号编码的写法（`/%70ack/…`）经 find-my-way 解码后同样命中 /pack/*，也要带上这些头。
 * - 访问门禁在 http/access.ts 的 onRequest 钩子里完成（本文件不重复判断）。
 */
import { createReadStream } from 'node:fs';
import { appError } from '@rich4/shared/net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { PACK_MANIFEST_NAME, type PackManifestBody, type PackRegistry, type PackServed } from '../assets/PackRegistry';

/** 带哈希文件的缓存时长：30 天 */
export const PACK_FILE_MAX_AGE_S = 30 * 24 * 3600;
export const PACK_FILE_CACHE_CONTROL = `private, max-age=${PACK_FILE_MAX_AGE_S}`;
export const PACK_MANIFEST_CACHE_CONTROL = 'private, no-cache';

export const PACK_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
});

/** 请求路径是否在 /pack 之下（含 /pack 本身） */
export function isPackPath(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  return path === '/pack' || path.startsWith('/pack/');
}

/** 请求是否落在 /pack 之下：匹配到的路由模式或原始路径任一在 /pack 下即算 */
export function isPackRequest(req: Pick<FastifyRequest, 'url' | 'routeOptions'>): boolean {
  const route = req.routeOptions.url;
  return (route !== undefined && isPackPath(route)) || isPackPath(req.url);
}

export function applyPackHeaders(reply: FastifyReply): void {
  for (const [k, v] of Object.entries(PACK_SECURITY_HEADERS)) reply.header(k, v);
}

type Encoding = 'br' | 'gzip' | 'identity';

/** 按 Accept-Encoding（含 q 值与 *）在可用编码里挑一个；优先 br，其次 gzip */
export function negotiateEncoding(header: string | undefined, available: { br: boolean; gzip: boolean }): Encoding {
  if (!header) return 'identity';
  const q = new Map<string, number>();
  for (const part of header.split(',')) {
    const [nameRaw, ...params] = part.trim().split(';');
    const name = (nameRaw ?? '').trim().toLowerCase();
    if (!name) continue;
    let weight = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p);
      if (m) weight = Number(m[1]);
    }
    if (Number.isFinite(weight)) q.set(name === 'x-gzip' ? 'gzip' : name, weight);
  }
  const star = q.get('*');
  const weightOf = (enc: 'br' | 'gzip'): number => q.get(enc) ?? star ?? 0;
  if (available.br && weightOf('br') > 0) return 'br';
  if (available.gzip && weightOf('gzip') > 0) return 'gzip';
  return 'identity';
}

/** If-None-Match 是否命中（支持逗号列表、弱比较与 *） */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === '*') return true;
  const strip = (t: string) => t.trim().replace(/^W\//, '');
  return header.split(',').some((t) => strip(t) === etag);
}

export type RangeResult = { kind: 'none' } | { kind: 'range'; start: number; end: number } | { kind: 'unsatisfiable' };

/** 解析单段 Range（bytes 单位）；多段、非 bytes 或语法错误视为没有 Range */
export function parseRange(header: string | undefined, size: number): RangeResult {
  if (!header) return { kind: 'none' };
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m) return { kind: 'none' };
  const [, a, b] = m as unknown as [string, string, string];
  if (a === '' && b === '') return { kind: 'none' };
  let start: number;
  let end: number;
  if (a === '') {
    const n = Number(b);
    if (n === 0) return { kind: 'unsatisfiable' };
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
    if (b !== '' && Number(b) < start) return { kind: 'none' };
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || size === 0) {
    return { kind: 'unsatisfiable' };
  }
  return { kind: 'range', start, end };
}

function notFound(reply: FastifyReply, reason: 'packDisabled' | 'notFound'): FastifyReply {
  return reply
    .code(404)
    .header('Cache-Control', 'no-store')
    .send({ ok: false, error: appError('BAD_REQUEST', { reason }) });
}

function sendManifest(req: FastifyRequest, reply: FastifyReply, m: PackManifestBody): FastifyReply {
  reply
    .header('Cache-Control', PACK_MANIFEST_CACHE_CONTROL)
    .header('ETag', m.etag)
    .header('Vary', 'Accept-Encoding')
    .type('application/json; charset=utf-8');
  if (etagMatches(req.headers['if-none-match'], m.etag)) return reply.code(304).send();
  const enc = negotiateEncoding(req.headers['accept-encoding'], { br: true, gzip: true });
  const body = enc === 'br' ? m.br : enc === 'gzip' ? m.gzip : m.raw;
  if (enc !== 'identity') reply.header('Content-Encoding', enc);
  return reply.header('Content-Length', String(body.length)).send(body);
}

function sendFile(req: FastifyRequest, reply: FastifyReply, f: PackServed): FastifyReply {
  const hasVariants = f.variants.br !== undefined || f.variants.gzip !== undefined;
  reply.header('Cache-Control', PACK_FILE_CACHE_CONTROL).type(f.contentType);
  if (hasVariants) reply.header('Vary', 'Accept-Encoding');
  const rangeHeader = req.headers.range;
  const enc =
    rangeHeader === undefined && hasVariants
      ? negotiateEncoding(req.headers['accept-encoding'], {
          br: f.variants.br !== undefined,
          gzip: f.variants.gzip !== undefined,
        })
      : 'identity';

  if (enc !== 'identity') {
    const v = f.variants[enc]!;
    const etag = `"${f.sha256.slice(0, 32)}-${enc}"`;
    reply.header('ETag', etag);
    if (etagMatches(req.headers['if-none-match'], etag)) return reply.code(304).send();
    return reply
      .header('Content-Encoding', enc)
      .header('Content-Length', String(v.bytes))
      .send(createReadStream(v.abs));
  }

  reply.header('ETag', f.etag).header('Accept-Ranges', 'bytes');
  if (etagMatches(req.headers['if-none-match'], f.etag)) return reply.code(304).send();
  // If-Range 与当前 ETag 不符（或是日期）时忽略 Range，返回完整内容
  const ifRange = req.headers['if-range'];
  const range: RangeResult =
    ifRange === undefined || String(ifRange).trim() === f.etag ? parseRange(rangeHeader, f.bytes) : { kind: 'none' };
  if (range.kind === 'unsatisfiable') {
    return reply.code(416).header('Content-Range', `bytes */${f.bytes}`).header('Content-Length', '0').send();
  }
  if (range.kind === 'range') {
    return reply
      .code(206)
      .header('Content-Range', `bytes ${range.start}-${range.end}/${f.bytes}`)
      .header('Content-Length', String(range.end - range.start + 1))
      .send(createReadStream(f.abs, { start: range.start, end: range.end }));
  }
  if (f.bytes === 0) return reply.header('Content-Length', '0').send(Buffer.alloc(0));
  return reply.header('Content-Length', String(f.bytes)).send(createReadStream(f.abs));
}

export function registerPack(app: FastifyInstance, o: { registry: PackRegistry }): void {
  const reg = o.registry;
  // 安全头挂在全局 onSend 上：/pack 下的 401（门禁）、404（白名单外、SPA 回退排除）也都带上
  app.addHook('onSend', async (req, reply, payload) => {
    if (isPackRequest(req)) applyPackHeaders(reply);
    return payload;
  });

  app.get('/pack', async (_req, reply) => notFound(reply, reg.enabled ? 'notFound' : 'packDisabled'));
  app.get<{ Params: { '*': string } }>('/pack/*', async (req, reply) => {
    if (!reg.enabled) return notFound(reply, 'packDisabled');
    const path = req.params['*'] ?? '';
    if (path === PACK_MANIFEST_NAME) return sendManifest(req, reply, reg.manifest!);
    const f = reg.lookup(path);
    if (!f) return notFound(reply, 'notFound');
    return sendFile(req, reply, f);
  });
}
