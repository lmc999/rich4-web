// 复核 M11 审查第 5 条：http.Server.closeAllConnections() 断不开已升级（101）的连接，server.close() 的回调一直不来
import { createServer } from 'node:http';
import { connect } from 'node:net';

const srv = createServer((_req, res) => res.end('ok'));
srv.on('upgrade', (_req, socket) => {
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const { port } = srv.address();
const c = connect(port, '127.0.0.1');
c.on('error', () => {});
c.write('GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
await new Promise((r) => c.once('data', r));
let fired = false;
srv.close(() => {
  fired = true;
});
srv.closeAllConnections();
await new Promise((r) => setTimeout(r, 2000));
console.log(fired ? 'close cb fired' : 'close cb NOT fired 2s after closeAllConnections');
c.destroy();
await new Promise((r) => setTimeout(r, 100));
console.log(fired ? 'close cb fired after client destroy' : 'still not fired');
process.exit(0);
