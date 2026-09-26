/**
 * 前端静态资源、SPA 回退与邀请页（design/net.md §10.1）。M2 为最小版：
 * - STATIC_DIR（默认 apps/client/dist）存在时托管它：/assets/* 长缓存，index.html no-cache；
 * - 其余 GET（非 /api、/socket.io）回退到 index.html；客户端未构建时回退到一个占位页；
 * - GET /r/:code 返回注入了 og 信息的 index.html（邀请预览）。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import { appError, ROOM_CODE_RE } from '@rich4/shared/net';
import type { FastifyInstance } from 'fastify';

const PLACEHOLDER = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>大富翁4 联机</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body><p>客户端尚未构建（npm run build），服务端运行正常。</p></body></html>`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** 替换 <title> 并在 </head> 前注入 og meta */
export function injectInvite(html: string, code: string, publicUrl: string): string {
  const title = escapeHtml(`邀请你来玩大富翁 · 房间 ${code}`);
  const url = escapeHtml(`${publicUrl.replace(/\/$/, '')}/r/${code}`);
  const meta = `<meta property="og:title" content="${title}"><meta property="og:type" content="website"><meta property="og:url" content="${url}">`;
  const withTitle = /<title>[^<]*<\/title>/i.test(html)
    ? html.replace(/<title>[^<]*<\/title>/i, `<title>${title}</title>`)
    : html;
  return withTitle.includes('</head>') ? withTitle.replace('</head>', `${meta}</head>`) : `${meta}${withTitle}`;
}

export async function registerStatic(
  app: FastifyInstance,
  o: { staticDir: string | null; publicUrl: string },
): Promise<void> {
  let page = PLACEHOLDER;
  if (o.staticDir) {
    const index = await readFile(join(o.staticDir, 'index.html'), 'utf8').catch(() => null);
    if (index !== null) {
      page = index;
      await app.register(fastifyStatic, {
        root: o.staticDir,
        index: false,
        setHeaders(reply, path) {
          if (/[\\/]assets[\\/]/.test(path)) reply.header('Cache-Control', 'public, max-age=31536000, immutable');
          else reply.header('Cache-Control', 'no-cache');
        },
      });
    }
  }

  app.get('/', async (_req, reply) =>
    reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-cache').send(page),
  );

  app.get<{ Params: { code: string } }>('/r/:code', async (req, reply) => {
    const html = ROOM_CODE_RE.test(req.params.code) ? injectInvite(page, req.params.code, o.publicUrl) : page;
    return reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-cache').send(html);
  });

  app.setNotFoundHandler(async (req, reply) => {
    const path = req.url.split('?')[0] ?? '';
    if (req.method === 'GET' && !path.startsWith('/api/') && !path.startsWith('/socket.io')) {
      return reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-cache').send(page);
    }
    return reply.code(404).send({ ok: false, error: appError('BAD_REQUEST', { reason: 'notFound' }) });
  });
}
