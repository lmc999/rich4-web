// M11 镜像与编排本机实测：经 Caddy（缺省 https://localhost:18443）验证 Socket.IO 的 WebSocket 与长轮询两种传输都能通，
// 以及 app 容器重启后同一 token 能 room:resume 回到对局（epoch 变化、seq 连续）。
// 用法（仓库根目录；Caddy 内部 CA 的根证书先从容器里拷出来）：
//   NODE_EXTRA_CA_CERTS=.cache/m11/img-caddy-root.crt npx tsx test/m11-img-socket.ts start
//   docker compose … restart app
//   NODE_EXTRA_CA_CERTS=.cache/m11/img-caddy-root.crt npx tsx test/m11-img-socket.ts resume
// 口令从 .cache/m11/img.passcode 读取；状态写到 .cache/m11/img-socket.json（都在 .gitignore 的 .cache/ 下）。
import { readFileSync, writeFileSync } from 'node:fs';
import type { CharacterId } from '@rich4/shared/engine';
import { type BotClient, connectBot, newToken } from '../apps/server/test/helpers/botClient';

const BASE = process.env.M11_BASE ?? 'https://localhost:18443';
const STATE = '.cache/m11/img-socket.json';
const mode = process.argv[2];

interface State {
  code: string;
  bots: { token: string; transport: 'websocket' | 'polling'; lastSeq: number; epoch: number }[];
}

async function login(): Promise<string> {
  const passcode = readFileSync('.cache/m11/img.passcode', 'utf8').trim();
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

function transportOf(b: BotClient): string {
  return (b.socket.io as unknown as { engine: { transport: { name: string } } }).engine.transport.name;
}

async function play(bots: BotClient[], minSeq: number, timeoutMs: number): Promise<void> {
  const stops = bots.map((b) => b.autoPlay(undefined, { delayMs: 30 }));
  try {
    for (const b of bots) await b.until(() => b.lastSeq >= minSeq || b.over !== undefined, timeoutMs, `seq ≥ ${minSeq}`);
  } finally {
    for (const s of stops) s();
  }
  // 两个传输各自收到的 batch 都要连续、没有 app:error
  for (const b of bots) {
    console.log(`${b.nickname}（${transportOf(b)}）：epoch ${b.epoch}，lastSeq ${b.lastSeq}，batches ${b.batches.length}`);
    if (b.gaps.length > 0) throw new Error(`${b.nickname} seq 缺口：${b.gaps.join('; ')}`);
    if (b.errors.length > 0) throw new Error(`${b.nickname} app:error：${JSON.stringify(b.errors)}`);
  }
}

async function start(): Promise<void> {
  const cookie = await login();
  const maps = (await (await fetch(`${BASE}/api/maps`, { headers: { cookie } })).json()) as { maps: { id: string }[] };
  console.log(`/api/maps：${maps.maps.map((m) => m.id).join(', ')}`);
  const specs = [
    { transport: 'websocket' as const, token: newToken() },
    { transport: 'polling' as const, token: newToken() },
  ];
  const bots: BotClient[] = [];
  for (const [i, s] of specs.entries()) {
    bots.push(
      await connectBot(BASE, {
        token: s.token,
        nickname: `m11-${s.transport}`,
        seed: i + 1,
        transports: [s.transport],
        extraHeaders: { cookie },
      }),
    );
  }
  const [host, guest] = bots as [BotClient, BotClient];
  const created = await host.req('room:create', { settings: { game: { mapId: 'taiwan', timeLimitDays: 30 } } });
  if (!created.ok) throw new Error(`room:create: ${created.error.code}`);
  const code = created.data.code;
  console.log(`房间 ${code}（taiwan）← ${BASE}`);
  const joined = await guest.req('room:join', { code, role: 'player' });
  if (!joined.ok) throw new Error(`room:join: ${joined.error.code}`);
  for (const [i, b] of bots.entries()) {
    const r = await b.req('room:selectCharacter', { characterId: i as CharacterId });
    if (!r.ok) throw new Error(`selectCharacter: ${r.error.code}`);
  }
  await guest.req('room:setReady', { ready: true });
  const started = await host.req('room:start', {});
  if (!started.ok) throw new Error(`room:start: ${started.error.code}`);
  await play(bots, 20, 60_000);
  const state: State = {
    code,
    bots: bots.map((b, i) => ({ token: specs[i]!.token, transport: specs[i]!.transport, lastSeq: b.lastSeq, epoch: b.epoch })),
  };
  writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);
  for (const b of bots) b.close();
}

async function resume(): Promise<void> {
  const state = JSON.parse(readFileSync(STATE, 'utf8')) as State;
  const cookie = await login();
  const bots: BotClient[] = [];
  for (const [i, s] of state.bots.entries()) {
    const b = await connectBot(BASE, {
      token: s.token,
      nickname: `m11-${s.transport}`,
      seed: i + 11,
      transports: [s.transport],
      extraHeaders: { cookie },
    });
    const r = await b.req('room:resume', { code: state.code, lastSeq: s.lastSeq, epoch: s.epoch });
    if (!r.ok) throw new Error(`room:resume: ${r.error.code}`);
    await b.until(() => b.epoch >= 0 && b.view !== undefined, 10_000, 'snapshot');
    console.log(`${b.nickname}：resume ${r.data.mode}，epoch ${s.epoch} → ${b.epoch}，seq ${s.lastSeq} → ${b.lastSeq}`);
    if (b.epoch <= s.epoch) throw new Error('重启后 epoch 没有增加');
    if (b.lastSeq < s.lastSeq) throw new Error('重启后 seq 回退');
    bots.push(b);
  }
  const before = Math.max(...bots.map((b) => b.lastSeq));
  await play(bots, before + 10, 60_000);
  for (const b of bots) b.close();
}

const run = mode === 'start' ? start : mode === 'resume' ? resume : null;
if (!run) {
  console.error('用法：npx tsx test/m11-img-socket.ts start|resume');
  process.exit(2);
}
run().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
