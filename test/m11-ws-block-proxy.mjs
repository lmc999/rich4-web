// 调试（M11 故障排查「WebSocket 被拦时降级长轮询」）：模拟「拦掉 WebSocket 升级的代理 / 防火墙」。
// 本机 HTTPS 监听 127.0.0.1:<端口>（自签证书，.cache/m11/tls/），普通请求原样转发到上游（缺省 https://localhost:8443，经 Caddy），
// WebSocket 升级一律回 403 并断开。配合 test/m11-ws-fallback.spec.ts（M11_BASE_URL=https://localhost:<端口>）。
// 用法：node test/m11-ws-block-proxy.mjs <监听端口> [上游，缺省 https://localhost:8443]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import https from 'node:https';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tlsDir = join(repoRoot, '.cache', 'm11', 'tls');
const listen = Number(process.argv[2]);
const upstream = new URL(process.argv[3] ?? 'https://localhost:8443');
if (!listen) {
  process.stderr.write('用法：node test/m11-ws-block-proxy.mjs <监听端口> [上游]\n');
  process.exit(1);
}
const keyPath = join(tlsDir, 'key.pem');
const certPath = join(tlsDir, 'cert.pem');
if (!existsSync(keyPath) || !existsSync(certPath)) {
  mkdirSync(tlsDir, { recursive: true });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '2', '-subj', '/CN=localhost']);
}

let blocked = 0;
let forwarded = 0;
const agent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });
process.on('uncaughtException', (e) => process.stdout.write(`忽略：${e.message}\n`));
const server = https.createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (req, res) => {
  forwarded++;
  const up = https.request(
    {
      host: upstream.hostname,
      port: upstream.port || 443,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: upstream.host },
      agent,
      servername: upstream.hostname,
    },
    (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    },
  );
  up.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(up);
});
server.on('upgrade', (req, socket) => {
  socket.on('error', () => {});
  blocked++;
  process.stdout.write(`拦下 WebSocket 升级：${req.url}\n`);
  socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
});
server.listen(listen, '127.0.0.1', () => process.stdout.write(`ws-block-proxy https://localhost:${listen} → ${upstream.origin}\n`));
const bye = () => {
  process.stdout.write(`退出：转发 ${forwarded} 个请求，拦下 ${blocked} 次 WebSocket 升级\n`);
  process.exit(0);
};
process.on('SIGTERM', bye);
process.on('SIGINT', bye);
