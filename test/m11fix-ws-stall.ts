// M11 审查第 5 条的实机复核：经 Caddy 建 N 条只走 WebSocket 的连接，打印 READY 后挂着不动。
// 外面对本进程 kill -STOP（模拟手机浏览器被挂起：TCP 还在、不回关闭帧），再 docker compose restart app，看停机要多久。
// 用法：node --import tsx test/m11fix-ws-stall.ts [基址，缺省 https://localhost:8443] [连接数，缺省 3]
// 口令从 .cache/m11/passcode.txt 读（不打印）。
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { BotClient } from '../apps/server/test/helpers/botClient';

const base = process.argv[2] ?? 'https://localhost:8443';
const n = Number(process.argv[3] ?? 3);
const passcode = readFileSync('.cache/m11/passcode.txt', 'utf8').trim();

function login(): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ passcode });
    const req = request(
      `${base}/api/access`,
      { method: 'POST', rejectUnauthorized: false, headers: { 'content-type': 'application/json' } },
      (res) => {
        res.resume();
        const c = (res.headers['set-cookie'] ?? []).map((s) => s.split(';')[0]!).find((s) => s.startsWith('r4_access='));
        if (res.statusCode === 200 && c) resolve(c);
        else reject(new Error(`login ${res.statusCode}`));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

const cookie = await login();
const bots: BotClient[] = [];
for (let i = 0; i < n; i++) {
  const b = new BotClient(base, {
    nickname: `stall${i}`,
    transports: ['websocket'],
    rejectUnauthorized: false,
    extraHeaders: { cookie },
  });
  await b.connect();
  bots.push(b);
}
console.log(`READY ${bots.length} pid=${process.pid}`);
setInterval(() => {}, 1 << 30);
