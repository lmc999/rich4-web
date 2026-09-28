// M11：本机 TLS 隧道（自签证书，.cache/m11/tls/），把 https://localhost:<LISTEN> 按字节转发到 127.0.0.1:<TARGET>，
// 用来在不起 Docker/Caddy 的情况下验证 loadtest 的 https 与自签证书路径（HTTP 与 WebSocket 都走同一条 TCP 流）。
// 用法：node test/m11-tls-tunnel.mjs [LISTEN=3443] [TARGET=3301]
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { createServer } from 'node:tls';

const listen = Number(process.argv[2] ?? 3443);
const target = Number(process.argv[3] ?? 3301);
const srv = createServer(
  { key: readFileSync('.cache/m11/tls/key.pem'), cert: readFileSync('.cache/m11/tls/cert.pem') },
  (tls) => {
    const up = connect(target, '127.0.0.1');
    tls.pipe(up).pipe(tls);
    const end = () => {
      tls.destroy();
      up.destroy();
    };
    tls.on('error', end);
    up.on('error', end);
  },
);
srv.listen(listen, '127.0.0.1', () => console.log(`tls tunnel https://localhost:${listen} -> 127.0.0.1:${target}`));
