// M11 调试：本机模拟 Caddy 的 TLS 反代（自签证书），让 E2E 远程模式在 https + Secure cookie + TRUST_PROXY 下跑，
// 不用 Docker。后端重启期间与 Caddy 一样返回 502（普通请求与 WebSocket 升级都是）。
// 用法：node test/m11-tls-proxy.mjs <监听端口> <后端端口>（证书在 .cache/m11/tls/，没有就用 openssl 现场生成）
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tlsDir = join(repoRoot, '.cache', 'm11', 'tls');
const [listen, backend] = process.argv.slice(2).map(Number);
if (!listen || !backend) {
  process.stderr.write('用法：node test/m11-tls-proxy.mjs <监听端口> <后端端口>\n');
  process.exit(1);
}

const keyPath = join(tlsDir, 'key.pem');
const certPath = join(tlsDir, 'cert.pem');
if (!existsSync(keyPath) || !existsSync(certPath)) {
  mkdirSync(tlsDir, { recursive: true });
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '2',
    '-subj',
    '/CN=localhost',
  ]);
}

/** 转发头：与 Caddy 一样补 X-Forwarded-For / -Proto / -Host */
function forwardHeaders(req) {
  const h = { ...req.headers };
  const prior = h['x-forwarded-for'];
  h['x-forwarded-for'] = prior ? `${prior}, ${req.socket.remoteAddress}` : req.socket.remoteAddress;
  h['x-forwarded-proto'] = 'https';
  h['x-forwarded-host'] = req.headers.host ?? '';
  return h;
}

const server = https.createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (req, res) => {
  const up = http.request(
    { host: '127.0.0.1', port: backend, method: req.method, path: req.url, headers: forwardHeaders(req) },
    (r) => {
      res.writeHead(r.statusCode ?? 502, r.rawHeaders);
      r.pipe(res);
    },
  );
  up.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('bad gateway');
  });
  req.pipe(up);
});

server.on('upgrade', (req, socket, head) => {
  const up = net.connect(backend, '127.0.0.1', () => {
    const h = forwardHeaders(req);
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [k, v] of Object.entries(h)) {
      for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${one}`);
    }
    up.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length > 0) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on('error', () => socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'));
  socket.on('error', () => up.destroy());
});

server.listen(listen, '127.0.0.1', () => process.stdout.write(`tls proxy https://localhost:${listen} -> 127.0.0.1:${backend}\n`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
