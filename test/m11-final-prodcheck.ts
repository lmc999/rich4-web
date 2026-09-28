// M11 实机验证 7（生产形态：只用 deploy/docker-compose.yml，不开测试模式）：经 Caddy 验证 debug:act 没有注册
// （emit 等不到 ack），而正常的建房、补电脑、开局、掷骰照常工作；最后解散房间。
// TLS 按正常方式校验：先把 Caddy 内部 CA 的根证书拷出来，再用 NODE_EXTRA_CA_CERTS 指给 node：
//   docker compose -p rich4-m11 -f deploy/docker-compose.yml exec -T caddy cat /data/caddy/pki/authorities/local/root.crt \
//     > .cache/m11/final/caddy-root.crt
//   NODE_EXTRA_CA_CERTS=.cache/m11/final/caddy-root.crt npx tsx test/m11-final-prodcheck.ts
// 口令从 .cache/m11/passcode.txt 读（不打印）。退出码 0 = 符合预期。
import { readFileSync } from 'node:fs';
import { connectBot, newToken } from '../apps/server/test/helpers/botClient';

const BASE = process.env.M11_BASE ?? 'https://localhost:8443';

async function login(): Promise<string> {
  const passcode = readFileSync('.cache/m11/passcode.txt', 'utf8').trim();
  const res = await fetch(`${BASE}/api/access`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passcode }),
  });
  if (res.status !== 200) throw new Error(`login ${res.status}`);
  const c = res.headers.getSetCookie().find((s) => s.startsWith('r4_access='));
  if (!c) throw new Error('login: 没有 r4_access cookie');
  return c.split(';')[0]!;
}

const cookie = await login();
const bot = await connectBot(BASE, { token: newToken(), nickname: 'm11-prod', extraHeaders: { cookie } });
let failed = false;
try {
  const created = await bot.req('room:create', {
    settings: { visibility: 'private', timerPreset: 'off', game: { mapId: 'taiwan', timeLimitDays: 30 } },
  });
  if (!created.ok) throw new Error(`room:create ${created.error.code}`);
  for (const seat of [1, 2, 3] as const) {
    const r = await bot.req('room:setSeatAi', { seat, ai: { preset: 'character' } });
    if (!r.ok) throw new Error(`room:setSeatAi ${seat} ${r.error.code}`);
  }
  const started = await bot.req('room:start', {});
  if (!started.ok) throw new Error(`room:start ${started.error.code}`);
  console.log(`房间 ${created.data.code}：建房、补 3 个电脑、开局 OK`);
  await bot.until(() => bot.yourDecision?.kind === 'TURN_MENU', 60_000, '本人回合');

  // debug:act：生产形态不注册，等不到 ack
  const t0 = Date.now();
  const dbg = await bot
    .rawReq('debug:act', { op: { op: 'forceNext', purpose: 'dice', values: [1] } }, 2000)
    .then((r) => ({ acked: true, r }))
    .catch((e: Error) => ({ acked: false, r: e.message }));
  if (dbg.acked) {
    failed = true;
    console.log(`FAIL debug:act 有回应（测试模式没关？）：${JSON.stringify(dbg.r)}`);
  } else console.log(`OK   debug:act 被拒：${Date.now() - t0}ms 内没有 ack（服务器未注册该事件）`);

  // 正常对局照常：自动决策打到 seq ≥ 10
  const stop = bot.autoPlay(undefined, { delayMs: 30 });
  await bot.until(() => bot.lastSeq >= 10, 120_000, 'seq ≥ 10');
  stop();
  if (bot.gaps.length > 0 || bot.errors.length > 0) {
    failed = true;
    console.log(`FAIL 对局异常：gaps=${bot.gaps.length} errors=${JSON.stringify(bot.errors)}`);
  } else console.log(`OK   正常对局推进到 seq ${bot.lastSeq}，epoch ${bot.epoch}，无缺口、无 app:error`);
  const d = await bot.req('room:dissolve', {});
  console.log(`房间已解散：${d.ok}`);
} catch (e) {
  failed = true;
  console.log(`FAIL ${(e as Error).message}`);
} finally {
  bot.close();
}
process.exit(failed ? 1 : 0);
