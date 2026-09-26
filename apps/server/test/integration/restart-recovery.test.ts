/**
 * 重启恢复（architecture M5 验证；design/net.md §8.5、§11.3）：临时目录里的 SQLite。
 * - 正常关闭（刷快照 + 自动存档）后用同一目录起新 app：状态哈希一致、epoch+1、全员断线并暂停，bot 重连拿到快照继续；
 * - 跳过刷盘（模拟 kill -9）：只靠逐条写入的 journal 重放，状态哈希同样一致；
 * - 大厅房间与聊天记录随快照恢复；优雅停机发 server:notice、readyz 转 503。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GameState } from '@rich4/shared/engine';
import { canonicalJson, fnv1a64 } from '@rich4/shared/util';
import { afterEach, describe, expect, it } from 'vitest';
import { autoSaveId } from '../../src/persistence/SaveService';
import { type BotClient, connectBot } from '../helpers/botClient';
import { closeAll, setupRoom, startGame } from '../helpers/scenario';
import { startTestServer, type TestServer } from '../helpers/startTestServer';

const servers: TestServer[] = [];
const bots: BotClient[] = [];
const dirs: string[] = [];

afterEach(async () => {
  closeAll(bots.splice(0));
  for (const s of servers.splice(0)) await s.close({ flush: false });
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'rich4-restart-'));
  dirs.push(d);
  return d;
}

async function serve(dataDir: string, store: 'sqlite' | 'json' = 'sqlite'): Promise<TestServer> {
  const s = await startTestServer({ dataDir, store, rateLimitScale: 0, roomDefaults: { reconnectGraceSec: 30 } });
  servers.push(s);
  return s;
}

const hashOf = (s: GameState) => fnv1a64(canonicalJson(s));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 自动打到 seq ≥ from，停下后用 debug:act 补到 target（确定地停在 target，且不跨过 25 的快照点） */
async function playTo(
  srv: TestServer,
  code: string,
  players: BotClient[],
  from: number,
  target: number,
): Promise<void> {
  const stops = players.map((b) => b.autoPlay());
  await players[0]!.until(() => players[0]!.lastSeq >= from, 20_000, `seq ${from}`);
  for (const stop of stops) stop();
  const runner = () => srv.app.rooms.get(code)!.runner!;
  // 等进行中的提交落定
  for (let last = -1; last !== runner().seq; ) {
    last = runner().seq;
    await sleep(60);
  }
  expect(runner().seq).toBeLessThan(target);
  let points = 1;
  while (runner().seq < target) {
    const r = await players[0]!.req('debug:act', { op: { op: 'setPoints', seat: 0, points: points++ } });
    expect(r.ok).toBe(true);
  }
  await players[0]!.until(() => players[0]!.lastSeq === target, 3000, 'last batch');
}

async function twoPlayerGame(srv: TestServer) {
  const s = await setupRoom(srv.url, { humans: 2, settings: { timerPreset: 'off' } });
  bots.push(...s.bots);
  await startGame(s);
  return s;
}

describe('integration/restart-recovery', () => {
  it('正常关闭后重启：状态哈希一致、epoch+1、全员断线暂停；重连拿到快照并继续对局', async () => {
    const dir = tmp();
    const srv1 = await serve(dir);
    const s = await twoPlayerGame(srv1);
    const [a, b] = s.bots as [BotClient, BotClient];
    expect((await a.req('chat:send', { text: '重启前的聊天' })).ok).toBe(true);
    await playTo(srv1, s.code, s.bots, 8, 20);
    const runner = srv1.app.rooms.get(s.code)!.runner!;
    const epoch = runner.epoch;
    await srv1.close(); // 刷快照 + 自动存档
    const hash = hashOf(runner.state);
    expect(runner.seq).toBe(20);

    const srv2 = await serve(dir);
    expect(srv2.app.restoreReport).toEqual([
      { code: s.code, phase: 'playing', mode: 'journal', replayed: 0, epoch: epoch + 1, seq: 20 },
    ]);
    const room = srv2.app.rooms.get(s.code)!;
    expect(room.phase).toBe('paused');
    expect(room.pausedInfo?.reason).toBe('all_away');
    expect(room.epoch).toBe(epoch + 1);
    expect(room.runner!.seq).toBe(20);
    expect(hashOf(room.runner!.state)).toBe(hash);
    expect(room.seats.every((x) => x.occupant?.kind !== 'human' || x.occupant.socketId === null)).toBe(true);
    // 停机时的自动存档
    expect(srv2.app.saves.list(room.humanTokens()[0]!).map((x) => x.saveId)).toContain(autoSaveId(s.code));

    // 房主先回来：epoch 变了 → 快照；房间自动继续；聊天记录还在
    const a2 = await connectBot(srv2.url, { token: a.token, nickname: 'P0', seed: 11 });
    bots.push(a2);
    expect(await a2.req('room:resume', { code: s.code, lastSeq: a.lastSeq, epoch: a.epoch })).toEqual({
      ok: true,
      data: { mode: 'snapshot' },
    });
    await a2.until(() => a2.epoch === epoch + 1 && a2.lastSeq === 20, 3000, 'snapshot');
    await a2.until(() => a2.room?.phase === 'playing', 3000, 'resumed');
    expect(a2.room!.you).toEqual({ role: 'player', seat: 0, isHost: true });
    expect(a2.room!.seats[1]!.occupant).toMatchObject({ kind: 'human', nickname: 'P1', connected: false });
    const hist = a2.received.find((m) => m.event === 'chat:history')!.payload as {
      messages: { text?: string; system?: { key: string } }[];
    };
    expect(hist.messages.some((m) => m.text === '重启前的聊天')).toBe(true);
    expect(hist.messages.some((m) => m.system?.key === 'serverRestored')).toBe(true);

    const b2 = await connectBot(srv2.url, { token: b.token, nickname: 'P1', seed: 12 });
    bots.push(b2);
    expect((await b2.req('room:resume', { code: s.code, lastSeq: b.lastSeq, epoch: b.epoch })).ok).toBe(true);
    await b2.until(() => b2.epoch === epoch + 1, 3000, 'b snapshot');
    a2.autoPlay();
    b2.autoPlay();
    await a2.until(() => a2.lastSeq >= 30, 20_000, 'game continues');
    expect(a2.gaps).toEqual([]);
    expect(b2.gaps).toEqual([]);
    expect(a2.batches[0]!.seq).toBe(21);
  }, 60_000);

  it('跳过刷盘（模拟崩溃）：只靠 journal 重放，状态哈希一致、epoch+1', async () => {
    const dir = tmp();
    const srv1 = await serve(dir);
    const s = await twoPlayerGame(srv1);
    await playTo(srv1, s.code, s.bots, 6, 18);
    const runner = srv1.app.rooms.get(s.code)!.runner!;
    const epoch = runner.epoch;
    await srv1.close({ flush: false });
    const hash = hashOf(runner.state);

    const srv2 = await serve(dir);
    const rep = srv2.app.restoreReport.find((r) => r.code === s.code)!;
    expect(rep.mode).toBe('journal');
    expect(rep.replayed).toBe(18); // 开局快照在 seq 0，其余全靠 journal
    expect(rep).toMatchObject({ epoch: epoch + 1, seq: 18 });
    const room = srv2.app.rooms.get(s.code)!;
    expect(hashOf(room.runner!.state)).toBe(hash);
    expect(room.phase).toBe('paused');
    // 恢复后立即写了新快照：再崩溃一次也不必重放
    await srv2.close({ flush: false });
    servers.splice(servers.indexOf(srv2), 1);
    const srv3 = await serve(dir);
    const rep3 = srv3.app.restoreReport.find((r) => r.code === s.code)!;
    expect(rep3).toMatchObject({ mode: 'journal', replayed: 0, epoch: epoch + 2, seq: 18 });
    expect(hashOf(srv3.app.rooms.get(s.code)!.runner!.state)).toBe(hash);

    const a2 = await connectBot(srv3.url, { token: s.host.token, nickname: 'P0' });
    bots.push(a2);
    expect(await a2.req('room:resume', { code: s.code, lastSeq: 18, epoch })).toEqual({
      ok: true,
      data: { mode: 'snapshot' },
    });
    await a2.until(() => a2.epoch === epoch + 2 && a2.lastSeq === 18, 3000, 'snapshot');
  }, 60_000);

  it('对局中踢人后立即崩溃：座位归属已落盘，重启后仍是电脑，被踢者不能 room:resume 拿回', async () => {
    const dir = tmp();
    const srv1 = await serve(dir);
    const s = await setupRoom(srv1.url, { humans: 3, settings: { timerPreset: 'off' } });
    bots.push(...s.bots);
    await startGame(s);
    const [host, kicked] = s.bots as [BotClient, BotClient, BotClient];
    expect((await host.req('room:kick', { target: { seat: 1 } })).ok).toBe(true);
    const room1 = srv1.app.rooms.get(s.code)!;
    expect(room1.seats[1]!.occupant?.kind).toBe('ai');
    expect(room1.runner!.state.players[1]!.controller).toBe('ai');
    await srv1.close({ flush: false }); // 不等 2 秒防抖

    const srv2 = await serve(dir);
    const room = srv2.app.rooms.get(s.code)!;
    expect(room.seats[1]!.occupant?.kind).toBe('ai');
    expect(room.runner!.controlOf(1)).toBe('ai');
    expect(room.runner!.state.players[1]!.controller).toBe('ai');
    const k2 = await connectBot(srv2.url, { token: kicked.token, nickname: 'P1' });
    bots.push(k2);
    expect((await k2.req('room:resume', { code: s.code, lastSeq: 0, epoch: 0 })).ok).toBe(false);
  }, 60_000);

  it('JSON 文件存储（备用实现）同样能靠 journal 重放恢复', async () => {
    const dir = tmp();
    const srv1 = await serve(dir, 'json');
    const s = await twoPlayerGame(srv1);
    await playTo(srv1, s.code, s.bots, 4, 12);
    const runner = srv1.app.rooms.get(s.code)!.runner!;
    await srv1.close({ flush: false });
    const srv2 = await serve(dir, 'json');
    expect(srv2.app.persistence.kind).toBe('json');
    expect(srv2.app.restoreReport).toMatchObject([{ code: s.code, mode: 'journal', replayed: 12, seq: 12 }]);
    expect(hashOf(srv2.app.rooms.get(s.code)!.runner!.state)).toBe(hashOf(runner.state));
  }, 60_000);

  it('大厅房间随快照恢复（2 秒防抖或停机刷盘）；房间关闭后不再恢复', async () => {
    const dir = tmp();
    const srv1 = await serve(dir);
    const s = await setupRoom(srv1.url, { humans: 2, ais: [{ seat: 3, ai: { preset: 'cunning' } }] });
    bots.push(...s.bots);
    const extra = await setupRoom(srv1.url, { humans: 1 });
    bots.push(...extra.bots);
    expect((await extra.host.req('room:dissolve', {})).ok).toBe(true);
    await srv1.close();
    const srv2 = await serve(dir);
    expect(srv2.app.restoreReport.map((r) => [r.code, r.mode])).toEqual([[s.code, 'lobby']]);
    const room = srv2.app.rooms.get(s.code)!;
    expect(room.phase).toBe('lobby');
    expect(room.epoch).toBe(0);
    expect(room.seats.map((x) => x.occupant?.kind ?? null)).toEqual(['human', 'human', null, 'ai']);
    expect(room.seats.map((x) => x.characterId)).toEqual([0, 1, null, null]);
    const a2 = await connectBot(srv2.url, { token: s.host.token, nickname: 'P0' });
    bots.push(a2);
    expect(await a2.req('room:resume', { code: s.code, lastSeq: 0, epoch: 0 })).toEqual({
      ok: true,
      data: { mode: 'lobby' },
    });
    await a2.until(() => a2.room?.you.role === 'player' && a2.room.you.isHost, 3000, 'host back');
    expect(srv2.app.rooms.get(extra.code)).toBeUndefined();
  }, 30_000);

  it('优雅停机：server:notice{shutdown}、readyz 转 503、停止建房', async () => {
    const dir = tmp();
    const srv1 = await serve(dir);
    const s = await twoPlayerGame(srv1);
    const done = srv1.app.shutdown('test');
    expect((await srv1.app.fastify.inject('/readyz')).statusCode).toBe(503);
    await s.host.until(() => s.host.received.some((m) => m.event === 'server:notice'), 2000, 'notice');
    const notice = s.host.received.find((m) => m.event === 'server:notice')!.payload;
    expect(notice).toMatchObject({ kind: 'shutdown', reconnectInMs: 5000 });
    expect(srv1.app.rooms.prepareCreate(undefined)).toMatchObject({ ok: false, error: { code: 'SERVER_BUSY' } });
    await done;
    expect(s.host.closedReason).toBeNull();
    const srv2 = await serve(dir);
    expect(srv2.app.restoreReport.map((r) => r.mode)).toEqual(['journal']);
  }, 30_000);
});
