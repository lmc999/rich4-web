// M5 手动验证的自动化版本（临时调试脚本）：用构建产物 apps/server/dist/main.mjs 起服，
// 两个 bot 开局打若干步 → kill -9 → 同一 DATA_DIR 重启 → bot 重连拿到快照（epoch+1，seq 不丢）。
// 用法：node apps/server/build.mjs && npx tsx test/m5-kill9-smoke.ts
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io, type Socket } from 'socket.io-client';

const bundle = join(import.meta.dirname, '../apps/server/dist/main.mjs');
const dataDir = mkdtempSync(join(tmpdir(), 'rich4-kill9-'));

function start(): Promise<{ p: ChildProcess; url: string }> {
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', bundle], {
    env: {
      PATH: process.env.PATH ?? '',
      DATA_DIR: dataDir,
      PORT: '0',
      HOST: '127.0.0.1',
      LOG_PRETTY: '0',
      RICH4_TEST_MODE: '1',
      BACKUP_ENABLED: '0',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    let buf = '';
    p.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      const line = buf.split('\n').find((l) => l.includes('rich4 server listening'));
      if (line) resolve({ p, url: (JSON.parse(line) as { addr: string }).addr });
    });
    p.once('exit', (c) => reject(new Error(`server exited ${c}\n${buf}`)));
  });
}

type Ack = { ok: boolean; data?: unknown; error?: { code: string } };

function bot(url: string, token: string, nickname: string) {
  const s: Socket = io(url, {
    transports: ['websocket'],
    reconnection: false,
    auth: { token, nickname, protocolVersion: 1, clientVersion: 'smoke' },
  });
  const state = { epoch: -1, seq: 0 };
  s.on('game:snapshot', (m: { epoch: number; seq: number }) => Object.assign(state, { epoch: m.epoch, seq: m.seq }));
  s.on('game:batch', (m: { epoch: number; seq: number }) => Object.assign(state, { epoch: m.epoch, seq: m.seq }));
  const req = (ev: string, p: unknown) =>
    new Promise<Ack>((r) => (s.timeout(5000) as unknown as Socket).emit(ev, p, (_e: unknown, a: Ack) => r(a)));
  return { s, state, req, ready: new Promise<void>((r) => s.once('connect', () => r())) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tA = randomBytes(16).toString('base64url');
const tB = randomBytes(16).toString('base64url');

let srv = await start();
let a = bot(srv.url, tA, 'A');
let b = bot(srv.url, tB, 'B');
await Promise.all([a.ready, b.ready]);
const code = ((await a.req('room:create', { settings: { timerPreset: 'off' } })).data as { code: string }).code;
await b.req('room:join', { code, role: 'player' });
await a.req('room:selectCharacter', { characterId: 0 });
await b.req('room:selectCharacter', { characterId: 1 });
await b.req('room:setReady', { ready: true });
console.log('start', await a.req('room:start', {}));
for (let i = 1; i <= 7; i++) await a.req('debug:act', { op: { op: 'setPoints', seat: 0, points: i } });
await sleep(100);
const before = { ...a.state };
console.log('before kill -9', before);
srv.p.kill('SIGKILL');
await sleep(200);

srv = await start();
a = bot(srv.url, tA, 'A');
b = bot(srv.url, tB, 'B');
await Promise.all([a.ready, b.ready]);
console.log('resume A', await a.req('room:resume', { code, lastSeq: before.seq, epoch: before.epoch }));
console.log('resume B', await b.req('room:resume', { code, lastSeq: before.seq, epoch: before.epoch }));
await sleep(100);
console.log('after restart', a.state);
const ok = a.state.epoch === before.epoch + 1 && a.state.seq === before.seq;
console.log(ok ? 'OK: epoch+1 且 seq 未丢失' : 'MISMATCH');
a.s.disconnect();
b.s.disconnect();
srv.p.kill('SIGTERM');
await new Promise((r) => srv.p.once('exit', r));
rmSync(dataDir, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
