// Cloudflare Tunnel 入口（deploy/Caddyfile 的 :8081）本机验证用：test/cf-tunnel-caddy.sh 在 docker 网络里跑两份
//   node cf-tunnel-caddy-probe.mjs upstream   假 app：监听 3000，把收到的请求头回显成 JSON；WebSocket 升级回 101
//   node cf-tunnel-caddy-probe.mjs client     扮演 cloudflared（连 caddy:8081）与公网访客（连 caddy:443），逐条断言
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import crypto from 'node:crypto';

const mode = process.argv[2];

if (mode === 'upstream') {
  const srv = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.setHeader('server', 'fake-app');
    res.end(JSON.stringify({ url: req.url, headers: req.headers, peer: req.socket.remoteAddress }));
  });
  srv.on('upgrade', (req, sock) => {
    const accept = crypto
      .createHash('sha1')
      .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC11B85')
      .digest('base64');
    sock.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\nX-Seen-XFF: ${req.headers['x-forwarded-for'] ?? ''}\r\n\r\n`,
    );
    sock.end();
  });
  srv.listen(3000, () => console.log('upstream listening :3000'));
} else if (mode === 'client') {
  let failed = 0;
  const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${detail}`}`);
    if (!ok) failed++;
  };
  const get = (mod, opts) =>
    new Promise((resolve, reject) => {
      const req = mod.request({ method: 'GET', ...opts }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.end();
    });

  // 1. 隧道入口：cloudflared 转来的请求，客户端 IP 取 Cf-Connecting-Ip，伪造的 X-Forwarded-For 被覆盖
  const t = await get(http, {
    host: 'caddy',
    port: 8081,
    path: '/api/x?y=1',
    headers: {
      host: 'rich4.example.net',
      'cf-connecting-ip': '203.0.113.7',
      'x-forwarded-for': '6.6.6.6, 203.0.113.7',
      'x-forwarded-proto': 'https',
    },
  });
  const tj = JSON.parse(t.body);
  check('tunnel: 200', t.status === 200, t.status);
  check('tunnel: app 看到的 X-Forwarded-For = Cf-Connecting-Ip', tj.headers['x-forwarded-for'] === '203.0.113.7', tj.headers['x-forwarded-for']);
  check('tunnel: X-Forwarded-Proto 透传为 https', tj.headers['x-forwarded-proto'] === 'https', tj.headers['x-forwarded-proto']);
  check('tunnel: Host 透传', tj.headers.host === 'rich4.example.net', tj.headers.host);
  check('tunnel: HSTS', t.headers['strict-transport-security'] === 'max-age=31536000', t.headers['strict-transport-security']);
  check('tunnel: X-Frame-Options DENY', t.headers['x-frame-options'] === 'DENY', t.headers['x-frame-options']);
  check('tunnel: 去掉 Server 头', t.headers.server === undefined, t.headers.server);

  // 2. 隧道入口：访客用 http:// 打开 → 308 到 https
  const r = await get(http, {
    host: 'caddy',
    port: 8081,
    path: '/r/123456?a=b',
    headers: { host: 'rich4.example.net', 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-proto': 'http' },
  });
  check('tunnel: http → 308', r.status === 308, r.status);
  check('tunnel: Location', r.headers.location === 'https://rich4.example.net/r/123456?a=b', r.headers.location);

  // 3. 隧道入口：没有 Cf-Connecting-Ip（不该出现，例如本机直连）时退回对端地址，不采信 X-Forwarded-For
  const n = await get(http, { host: 'caddy', port: 8081, path: '/', headers: { host: 'x', 'x-forwarded-for': '6.6.6.6' } });
  const nj = JSON.parse(n.body);
  check('tunnel: 无 Cf-Connecting-Ip 时不采信 X-Forwarded-For', nj.headers['x-forwarded-for'] !== '6.6.6.6' && !String(nj.headers['x-forwarded-for']).includes('6.6.6.6'), nj.headers['x-forwarded-for']);

  // 4. 公网入口（:443，SITE_ADDRESS=localhost 内部 CA）：伪造的 Cf-Connecting-Ip / X-Forwarded-For 一律不认
  const p = await get(https, {
    host: 'caddy',
    port: 443,
    servername: 'localhost',
    rejectUnauthorized: false,
    path: '/',
    headers: { host: 'localhost', 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '6.6.6.6' },
  });
  const pj = JSON.parse(p.body);
  const xff = pj.headers['x-forwarded-for'];
  check('public: 200', p.status === 200, p.status);
  check('public: 不采信伪造的 Cf-Connecting-Ip / X-Forwarded-For', xff !== '203.0.113.9' && !String(xff).includes('6.6.6.6'), xff);
  check('public: localhost 不发 HSTS', p.headers['strict-transport-security'] === undefined, p.headers['strict-transport-security']);

  // 5. 隧道入口的 WebSocket 升级
  const ws = await new Promise((resolve, reject) => {
    const s = net.connect(8081, 'caddy', () => {
      s.write(
        'GET /socket.io/?EIO=4&transport=websocket HTTP/1.1\r\nHost: rich4.example.net\r\nUpgrade: websocket\r\n' +
          'Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n' +
          `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n` +
          'Cf-Connecting-Ip: 203.0.113.7\r\nX-Forwarded-Proto: https\r\n\r\n',
      );
    });
    let buf = '';
    s.on('data', (c) => (buf += c));
    s.on('end', () => resolve(buf));
    s.on('error', reject);
  });
  check('tunnel: WebSocket 101', ws.startsWith('HTTP/1.1 101'), ws.split('\r\n')[0]);
  check('tunnel: WebSocket 的 X-Forwarded-For', /x-seen-xff: 203\.0\.113\.7/i.test(ws), ws);

  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
} else {
  console.error('usage: node cf-tunnel-caddy-probe.mjs upstream|client');
  process.exit(2);
}
