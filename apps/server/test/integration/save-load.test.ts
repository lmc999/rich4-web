/**
 * 存档读档（architecture M5 验证；design/net.md §8.3–§8.4、§11.3）：
 * - 对局中存档 → 解散（自动存档）→ 新建房间读档 → 按 token 自动入座 → 未认领座位补 AI → 开局后状态哈希等于存档状态；
 * - 非 owner 读档 SAVE_FORBIDDEN；托管设置（SYS_SET_AI_TRAITS）随存档保存；
 * - .r4save 导出与导入：原样导入 verified=true，篡改后 verified=false（大厅显示非官方存档），进行中的对局不许导出。
 */
import type { GameState } from '@rich4/shared/engine';
import type { RoomView, SaveSummary } from '@rich4/shared/net';
import { canonicalJson, fnv1a64 } from '@rich4/shared/util';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeR4S1, encodeR4S1, gunzipJson, gzipJson } from '../../src/persistence/codec';
import { autoSaveId } from '../../src/persistence/SaveService';
import { type BotClient, connectBot } from '../helpers/botClient';
import { closeAll, setupRoom, startGame } from '../helpers/scenario';
import { startTestServer, type TestServer } from '../helpers/startTestServer';

let srv: TestServer | null = null;
const bots: BotClient[] = [];

afterEach(async () => {
  closeAll(bots.splice(0));
  await srv?.close();
  srv = null;
});

const hashOf = (s: GameState) => fnv1a64(canonicalJson(s));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function playSome(t: TestServer, code: string, players: BotClient[], seq: number): Promise<void> {
  const stops = players.map((b) => b.autoPlay());
  await players[0]!.until(() => players[0]!.lastSeq >= seq, 20_000, `seq ${seq}`);
  for (const stop of stops) stop();
  const runner = () => t.app.rooms.get(code)!.runner!;
  for (let last = -1; last !== runner().seq; ) {
    last = runner().seq;
    await sleep(60);
  }
  for (const b of players) await b.until(() => b.lastSeq === runner().seq, 3000, 'catch up');
}

async function listSaves(b: BotClient): Promise<SaveSummary[]> {
  const r = await b.req('saves:list', {});
  if (!r.ok) throw new Error(r.error.code);
  return r.data.saves;
}

async function newRoom(b: BotClient): Promise<string> {
  const r = await b.req('room:create', { settings: {} });
  if (!r.ok) throw new Error(r.error.code);
  return r.data.code;
}

describe('integration/save-load', () => {
  it('对局中存档 → 解散 → 新房间读档：按 token 自动入座、未认领座位补 AI、开局状态与存档一致', async () => {
    srv = await startTestServer({ rateLimitScale: 0 });
    const s = await setupRoom(srv.url, { humans: 3, settings: { timerPreset: 'off' } });
    bots.push(...s.bots);
    const [host, p1, p2] = s.bots as [BotClient, BotClient, BotClient];
    await startGame(s);
    await playSome(srv, s.code, s.bots, 10);

    // 托管设置写入 state，随存档保存
    const trustee = { personality: 2 as const, useCards: false, useItems: true, cashRatio: 30, stockRatio: 60 };
    expect(await p1.req('game:autopilot', { on: false, settings: trustee })).toEqual({ ok: true, data: undefined });
    await p1.until(() => p1.batches.some((x) => x.cause.intentType === 'SYS_SET_AI_TRAITS'), 3000, 'traits batch');
    const room1 = srv.app.rooms.get(s.code)!;
    expect(room1.runner!.state.players.find((p) => p.seat === 1)!.aiTraits).toMatchObject({
      personality: 2,
      useCards: false,
      cashRatio: 30,
      stockRatio: 60,
    });

    expect(await p1.req('game:save', { name: 'x' })).toMatchObject({ ok: false, error: { code: 'NOT_HOST' } });
    const sv = await host.req('game:save', { name: '  周末​局  ' });
    if (!sv.ok) throw new Error(sv.error.code);
    const saveId = sv.data.saveId;
    const savedHash = hashOf(room1.runner!.state);
    await host.until(
      () =>
        host.received.some(
          (m) => m.event === 'chat:message' && (m.payload as { system?: { key: string } }).system?.key === 'gameSaved',
        ),
      3000,
      'gameSaved',
    );

    // 三位真人都是 owner；局外人看不到、删不掉
    for (const b of s.bots) {
      const mine = (await listSaves(b)).find((x) => x.saveId === saveId);
      expect(mine).toMatchObject({ name: '周末局', kind: 'manual', mapId: 'test', verified: true, compatible: true });
      expect(mine!.seats.map((x) => [x.nickname, x.wasHuman])).toEqual([
        ['P0', true],
        ['P1', true],
        ['P2', true],
      ]);
    }
    const outsider = await connectBot(srv.url, { nickname: 'X' });
    bots.push(outsider);
    expect((await listSaves(outsider)).map((x) => x.saveId)).not.toContain(saveId);
    expect(await outsider.req('saves:delete', { saveId })).toMatchObject({
      ok: false,
      error: { code: 'SAVE_NOT_FOUND' },
    });

    // 原对局仍在进行：owner 另开房间读这个存档被拒（否则可以试走预知随机结果）
    expect((await p2.req('room:leave', {})).ok).toBe(true);
    await newRoom(p2);
    expect(await p2.req('room:loadSave', { saveId })).toMatchObject({
      ok: false,
      error: { code: 'SAVE_FORBIDDEN', details: { reason: 'gameInProgress' } },
    });
    expect((await p2.req('room:leave', {})).ok).toBe(true);

    // 对局中解散：先自动存档
    expect((await host.req('room:dissolve', {})).ok).toBe(true);
    await p1.until(() => p1.closedReason === 'dissolved', 3000, 'closed');
    expect((await listSaves(host)).find((x) => x.saveId === autoSaveId(s.code))).toMatchObject({ kind: 'auto' });

    // 非 owner 读档
    await newRoom(outsider);
    expect(await outsider.req('room:loadSave', { saveId })).toMatchObject({
      ok: false,
      error: { code: 'SAVE_FORBIDDEN' },
    });
    expect(await outsider.req('room:loadSave', { saveId: 'nope' })).toMatchObject({
      ok: false,
      error: { code: 'SAVE_NOT_FOUND' },
    });
    expect((await outsider.req('room:leave', {})).ok).toBe(true);

    // 新房间：房主与 P1 在，P2 不来
    const code2 = await newRoom(host);
    expect((await p1.req('room:join', { code: code2, role: 'player' })).ok).toBe(true);
    expect(await p1.req('room:loadSave', { saveId })).toMatchObject({ ok: false, error: { code: 'NOT_HOST' } });
    expect((await host.req('room:loadSave', { saveId })).ok).toBe(true);
    await host.until(() => host.room?.loadedSave?.saveId === saveId, 3000, 'loaded');
    const rv = host.room as RoomView;
    expect(rv.loadedSave).toMatchObject({ name: '周末局', verified: true });
    expect(rv.seats.map((x) => (x.occupant?.kind === 'human' ? x.occupant.nickname : null))).toEqual([
      'P0',
      'P1',
      null,
      null,
    ]);
    expect(rv.seats.map((x) => x.characterId)).toEqual([0, 1, 2, null]);
    expect(rv.seats[2]!.savedSeat).toEqual({ nickname: 'P2', characterId: 2, wasHuman: true, claimableByYou: true });
    expect(rv.seats[3]!.savedSeat).toBeUndefined();
    expect(await p1.req('room:selectCharacter', { characterId: 5 })).toMatchObject({
      ok: false,
      error: { code: 'BAD_REQUEST', details: { reason: 'saveLoaded' } },
    });
    expect(await host.req('room:start', {})).toMatchObject({
      ok: false,
      error: { code: 'NOT_ENOUGH_PLAYERS', details: { reason: 'unclaimedSeats', seats: [2] } },
    });

    // 局外人：观战加入后不能抢已被 owner 占着的座位，也不能坐存档外的座位
    expect((await outsider.req('room:join', { code: code2, role: 'spectator' })).ok).toBe(true);
    expect(await outsider.req('room:claimSeat', { seat: 1 })).toMatchObject({
      ok: false,
      error: { code: 'SEAT_TAKEN' },
    });
    expect(await outsider.req('room:claimSeat', { seat: 3 })).toMatchObject({
      ok: false,
      error: { code: 'BAD_REQUEST', details: { reason: 'notInSave' } },
    });
    expect(await host.req('room:setSeatAi', { seat: 3, ai: { preset: 'normal' } })).toMatchObject({
      ok: false,
      error: { code: 'BAD_REQUEST', details: { reason: 'notInSave' } },
    });

    // 未认领座位补 AI，P1 准备，开局
    expect((await host.req('room:setSeatAi', { seat: 2, ai: { preset: 'normal' } })).ok).toBe(true);
    expect((await p1.req('room:setReady', { ready: true })).ok).toBe(true);
    expect(await host.req('room:start', {})).toEqual({ ok: true, data: undefined });
    await host.until(
      () => host.epoch === 1 && host.view !== undefined && host.room?.phase === 'playing',
      3000,
      'started',
    );
    const room2 = srv.app.rooms.get(code2)!;
    // 座位 2 的 AI 可能在开局后立刻行动：以开局时写入的快照（seq 0）比对，再用 journal 重放到当前状态
    const snap = srv.app.persistence.rooms.listActive(0).find((r) => r.code === code2)!;
    expect(snap).toMatchObject({ epoch: 1, seq: 0, phase: 'playing' });
    expect(hashOf(snap.state!)).toBe(savedHash);
    let replay = snap.state!;
    for (const row of srv.app.persistence.rooms.readJournal(code2, 1, 0))
      replay = srv.engine.applyAction(replay, row.action).state;
    expect(hashOf(replay)).toBe(hashOf(room2.runner!.state));
    expect(snap.state!.players.find((p) => p.seat === 1)!.aiTraits).toMatchObject({ personality: 2 });
    expect(room2.loaded).toBeNull();
    expect(room2.sourceSaveId).toBe(saveId);
    expect(host.room!.loadedSave).toBeUndefined();
    expect(host.room!.seats[2]!.control).toBe('ai');

    // P2 在原房间离开后 token 不在新房间：仍可在自己的存档列表里看到这个存档
    expect((await listSaves(p2)).map((x) => x.saveId)).toContain(saveId);

    // 继续打：座位 2 由服务器 AI 代打
    host.autoPlay();
    p1.autoPlay();
    await host.until(() => host.batches.some((x) => x.cause.seat === 2 && x.cause.by === 'ai'), 20_000, 'ai seat 2');
    expect(host.gaps).toEqual([]);
  }, 60_000);

  it('对局中全员离开：自动存档并关闭房间；之后可导出、可另开房间读档（手动与自动存档）；只是断线仍算进行中', async () => {
    srv = await startTestServer({ rateLimitScale: 0 });
    const s = await setupRoom(srv.url, {
      humans: 2,
      ais: [{ seat: 2, ai: { preset: 'cunning' } }],
      settings: { timerPreset: 'off' },
    });
    bots.push(...s.bots);
    const [host, p1] = s.bots as [BotClient, BotClient];
    const spec = await connectBot(srv.url, { nickname: '观众' });
    bots.push(spec);
    expect((await spec.req('room:join', { code: s.code, role: 'spectator' })).ok).toBe(true);
    await startGame(s, [spec]);
    const sv = await host.req('game:save', { name: '全员离开' });
    if (!sv.ok) throw new Error(sv.error.code);
    const saveId = sv.data.saveId;
    const f = srv.app.fastify;
    const exportAs = (token: string, id: string) =>
      f.inject({
        method: 'GET',
        url: `/api/saves/${encodeURIComponent(id)}/export`,
        headers: { 'x-player-token': token },
      });

    // P1 离开，房主还在：对局继续，存档仍算进行中
    expect((await p1.req('room:leave', {})).ok).toBe(true);
    expect(srv.app.rooms.get(s.code)?.inGame).toBe(true);
    expect((await exportAs(p1.token, saveId)).json()).toMatchObject({
      ok: false,
      error: { code: 'SAVE_FORBIDDEN', details: { reason: 'gameInProgress' } },
    });

    // 房主只是断线（没有 room:leave）：房间暂停等人回来，仍然禁止导出与另开房间读档
    host.drop();
    await spec.until(() => spec.room?.phase === 'paused', 3000, 'paused');
    expect(srv.app.rooms.get(s.code)?.phase).toBe('paused');
    expect((await exportAs(p1.token, saveId)).statusCode).toBe(409);
    await newRoom(p1);
    expect(await p1.req('room:loadSave', { saveId })).toMatchObject({
      ok: false,
      error: { code: 'SAVE_FORBIDDEN', details: { reason: 'gameInProgress' } },
    });
    expect((await p1.req('room:leave', {})).ok).toBe(true);

    // 房主回来再离开：座位上已没有在线真人 → 自动存档并关闭房间，观战者收到 room:closed
    expect((await host.reconnect(s.code)).ok).toBe(true);
    await spec.until(() => spec.room?.phase === 'playing', 3000, 'resumed');
    expect((await host.req('room:leave', {})).ok).toBe(true);
    await spec.until(() => spec.closedReason !== null, 3000, 'spectator closed');
    expect(spec.closedReason).toBe('idle');
    expect(srv.app.rooms.get(s.code)).toBeUndefined();
    expect(srv.app.persistence.rooms.listActive(0).map((r) => r.code)).not.toContain(s.code);
    for (const b of [host, p1]) {
      const mine = await listSaves(b);
      expect(mine.find((x) => x.saveId === autoSaveId(s.code))).toMatchObject({ kind: 'auto', compatible: true });
      expect(mine.map((x) => x.saveId)).toContain(saveId);
    }
    // 两位真人都能导出（手动与自动存档）
    for (const id of [saveId, autoSaveId(s.code)]) {
      const r = await exportAs(p1.token, id);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.body.startsWith('R4S1.')).toBe(true);
    }

    // P1 新建房间读自动存档：P1 回到自己的座位，存档里的电脑按原配置补上
    const code2 = await newRoom(p1);
    expect(await p1.req('room:loadSave', { saveId: autoSaveId(s.code) })).toEqual({ ok: true, data: undefined });
    await p1.until(() => p1.room?.loadedSave !== undefined, 3000, 'loaded');
    expect(p1.room!.you).toEqual({ role: 'player', seat: 1, isHost: true });
    expect(p1.room!.seats[2]!.occupant).toMatchObject({ kind: 'ai', ai: { preset: 'cunning' } });
    expect(p1.room!.seats[2]!.savedSeat).toMatchObject({ wasHuman: false });
    // 存档里本来是电脑的座位：改预设不生效，移除后再补仍是原配置
    expect((await p1.req('room:setSeatAi', { seat: 2, ai: { preset: 'gentle' } })).ok).toBe(true);
    expect(srv.app.rooms.get(code2)!.seats[2]!.occupant).toMatchObject({ kind: 'ai', ai: { preset: 'cunning' } });
    expect((await p1.req('room:setSeatAi', { seat: 2, ai: null })).ok).toBe(true);
    expect(srv.app.rooms.get(code2)!.seats[2]!.occupant).toBeNull();
    expect((await p1.req('room:setSeatAi', { seat: 2, ai: { preset: 'gentle' } })).ok).toBe(true);
    await p1.until(() => p1.room?.seats[2]?.occupant?.kind === 'ai', 3000, 'ai back');
    expect(p1.room!.seats[2]!.occupant).toMatchObject({ kind: 'ai', ai: { preset: 'cunning' } });
    // 存档里是真人的座位补电脑：按请求的预设（只在服务器层代打）
    expect((await p1.req('room:setSeatAi', { seat: 0, ai: { preset: 'gentle' } })).ok).toBe(true);
    await p1.until(() => p1.room?.seats[0]?.occupant?.kind === 'ai', 3000, 'seat 0 ai');
    expect(p1.room!.seats[0]!.occupant).toMatchObject({ kind: 'ai', ai: { preset: 'gentle' } });
    expect((await p1.req('room:start', {})).ok).toBe(true);
    await p1.until(() => p1.room?.phase === 'playing' && p1.epoch >= 1, 5000, 'started');
    expect(srv.app.rooms.get(code2)!.sourceSaveId).toBe(autoSaveId(s.code));

    // 房主另开房间读手动存档：读档对局（code2）来自自动存档，手动存档不受影响
    await newRoom(host);
    expect(await host.req('room:loadSave', { saveId })).toEqual({ ok: true, data: undefined });
    // 自动存档正被 code2 使用：仍然禁止导出
    expect((await exportAs(host.token, autoSaveId(s.code))).statusCode).toBe(409);
  }, 60_000);

  it('0.5.0 的存档（PlayerState 还没有 parked，state 结构版本同为 1）：真实引擎导入、读档时经 migrateState 补 null，可以开局', async () => {
    srv = await startTestServer({ rateLimitScale: 0, engine: 'real' });
    const s = await setupRoom(srv.url, { humans: 2, settings: { timerPreset: 'off' } });
    bots.push(...s.bots);
    const [host, p1] = s.bots as [BotClient, BotClient];
    await startGame(s);
    const sv = await host.req('game:save', { name: '旧版存档' });
    if (!sv.ok) throw new Error(sv.error.code);
    expect((await host.req('room:dissolve', {})).ok).toBe(true);
    await p1.until(() => p1.closedReason === 'dissolved', 3000, 'closed');
    const f = srv.app.fastify;
    const exp = await f.inject({
      method: 'GET',
      url: `/api/saves/${encodeURIComponent(sv.data.saveId)}/export`,
      headers: { 'x-player-token': host.token },
    });
    expect(exp.statusCode).toBe(200);
    const raw = gunzipJson(decodeR4S1(exp.body).blob) as {
      engineVersion: string;
      stateVersion: number;
      game: GameState;
    };
    expect(raw.stateVersion).toBe(1);
    raw.engineVersion = '0.5.0';
    raw.game.engine = '0.5.0';
    for (const p of raw.game.players) delete (p as Partial<GameState['players'][number]>).parked;
    const imp = await f.inject({
      method: 'POST',
      url: '/api/saves/import',
      headers: { 'x-player-token': host.token, 'content-type': 'text/plain' },
      payload: encodeR4S1(gzipJson(raw), ''),
    });
    expect(imp.statusCode).toBe(200);
    const sum = (imp.json() as { ok: true; data: SaveSummary }).data;
    expect(sum).toMatchObject({ name: '旧版存档', compatible: true, verified: false });

    const code2 = await newRoom(host);
    expect((await p1.req('room:join', { code: code2, role: 'player' })).ok).toBe(true);
    expect((await host.req('room:loadSave', { saveId: sum.saveId })).ok).toBe(true);
    await host.until(() => host.room?.loadedSave?.saveId === sum.saveId, 3000, 'loaded');
    expect((await p1.req('room:setReady', { ready: true })).ok).toBe(true);
    expect(await host.req('room:start', {})).toEqual({ ok: true, data: undefined });
    await host.until(() => host.room?.phase === 'playing' && host.view !== undefined, 3000, 'started');
    const room2 = srv.app.rooms.get(code2)!;
    expect(room2.runner!.state.players.map((p) => p.parked)).toEqual([null, null]);
    expect(srv.engine.validateState(room2.runner!.state)).toBe(true);
    host.autoPlay();
    p1.autoPlay();
    const seq = host.lastSeq;
    await host.until(() => host.lastSeq >= seq + 10, 20_000, 'game continues');
    expect(host.gaps).toEqual([]);
  }, 60_000);

  it('读档时 owner 在观战席：自动入座；owner 后来加入：直接回到自己的座位', async () => {
    srv = await startTestServer({ rateLimitScale: 0 });
    const s = await setupRoom(srv.url, { humans: 2, settings: { timerPreset: 'off' } });
    bots.push(...s.bots);
    const [host, p1] = s.bots as [BotClient, BotClient];
    await startGame(s);
    const sv = await host.req('game:save', { name: '\u200b' });
    if (!sv.ok) throw new Error(sv.error.code);
    expect((await listSaves(host)).find((x) => x.saveId === sv.data.saveId)!.name).toMatch(/^存档 \d{4}-\d{2}-\d{2}$/);
    expect((await host.req('room:dissolve', {})).ok).toBe(true);

    const code2 = await newRoom(host);
    expect((await p1.req('room:join', { code: code2, role: 'spectator' })).ok).toBe(true);
    expect((await host.req('room:loadSave', { saveId: sv.data.saveId })).ok).toBe(true);
    await p1.until(() => p1.room?.you.role === 'player', 3000, 'p1 seated');
    expect(p1.room!.you).toEqual({ role: 'player', seat: 1, isHost: false });

    // P1 起身再按 player 身份重新加入：回到自己的座位
    expect((await p1.req('room:leave', {})).ok).toBe(true);
    await host.until(() => host.room?.seats[1]?.occupant === null, 3000, 'p1 left');
    expect(host.room!.seats[1]!.characterId).toBe(1);
    expect((await p1.req('room:join', { code: code2, role: 'player' })).ok).toBe(true);
    expect(p1.room!.you).toEqual({ role: 'player', seat: 1, isHost: false });
    expect((await p1.req('room:setReady', { ready: true })).ok).toBe(true);
    expect((await host.req('room:start', {})).ok).toBe(true);
  }, 30_000);

  it('.r4save 导出与导入：进行中不许导出；原样导入 verified=true；篡改后 verified=false 且大厅显示非官方存档', async () => {
    srv = await startTestServer({ rateLimitScale: 0 });
    const s = await setupRoom(srv.url, { humans: 2, settings: { timerPreset: 'off' } });
    bots.push(...s.bots);
    const [host] = s.bots as [BotClient, BotClient];
    await startGame(s);
    const sv = await host.req('game:save', { name: '导出测试' });
    if (!sv.ok) throw new Error(sv.error.code);
    const saveId = sv.data.saveId;
    const f = srv.app.fastify;
    const exportAs = (token: string | null) =>
      f.inject({
        method: 'GET',
        url: `/api/saves/${encodeURIComponent(saveId)}/export`,
        headers: token ? { 'x-player-token': token } : {},
      });

    const busy = await exportAs(host.token);
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toMatchObject({
      ok: false,
      error: { code: 'SAVE_FORBIDDEN', details: { reason: 'gameInProgress' } },
    });
    expect((await host.req('room:dissolve', {})).ok).toBe(true);

    const res = await exportAs(host.token);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('.r4save');
    const text = res.body;
    expect(text.startsWith('R4S1.')).toBe(true);
    expect((await exportAs(null)).statusCode).toBe(400);
    const outsider = await connectBot(srv.url, { nickname: 'X' });
    bots.push(outsider);
    expect((await exportAs(outsider.token)).statusCode).toBe(404);

    const importAs = (token: string, payload: string, type = 'text/plain') =>
      f.inject({
        method: 'POST',
        url: '/api/saves/import',
        headers: { 'x-player-token': token, 'content-type': type },
        payload,
      });

    // 原样导入（局外人成为新存档的 owner）
    const imp = await importAs(outsider.token, text);
    expect(imp.statusCode).toBe(200);
    const sum = (imp.json() as { ok: true; data: SaveSummary }).data;
    expect(sum).toMatchObject({ name: '导出测试', verified: true, compatible: true, kind: 'manual' });
    expect(sum.saveId).not.toBe(saveId);
    expect((await listSaves(outsider)).map((x) => x.saveId)).toEqual([sum.saveId]);

    // 篡改内容但沿用旧签名：仍可导入，verified=false
    const { blob, sig } = decodeR4S1(text);
    const raw = gunzipJson(blob) as Record<string, unknown>;
    const forged = encodeR4S1(gzipJson({ ...raw, name: '被改过的存档' }), sig);
    const bad = await importAs(host.token, forged, 'application/octet-stream');
    expect(bad.statusCode).toBe(200);
    const badSum = (bad.json() as { ok: true; data: SaveSummary }).data;
    expect(badSum).toMatchObject({ name: '被改过的存档', verified: false });
    // JSON 形式、无签名的存档也可导入，同样是非官方存档
    const unsigned = await f.inject({
      method: 'POST',
      url: '/api/saves/import',
      headers: { 'x-player-token': host.token },
      payload: { text: encodeR4S1(blob, '') },
    });
    expect((unsigned.json() as { data: SaveSummary }).data.verified).toBe(false);
    // 再导出非官方存档：重新导入仍是非官方
    const reExp = await exportAs(host.token).then(() =>
      f.inject({
        method: 'GET',
        url: `/api/saves/${encodeURIComponent(badSum.saveId)}/export`,
        headers: { 'x-player-token': host.token },
      }),
    );
    const again = await importAs(host.token, reExp.body);
    expect((again.json() as { data: SaveSummary }).data.verified).toBe(false);

    // 读档大厅显示「非官方存档」
    await newRoom(host);
    expect((await host.req('room:loadSave', { saveId: badSum.saveId })).ok).toBe(true);
    await host.until(() => host.room?.loadedSave?.saveId === badSum.saveId, 3000, 'loaded');
    expect(host.room!.loadedSave!.verified).toBe(false);

    // 各种坏文件
    const garbage = await importAs(host.token, 'hello');
    expect(garbage.statusCode).toBe(422);
    expect(garbage.json()).toMatchObject({
      ok: false,
      error: { code: 'SAVE_INCOMPATIBLE', details: { reason: 'badEncoding' } },
    });
    for (const game of [
      { ...(raw.game as object), v: 999 },
      { ...(raw.game as object), secret: null },
    ]) {
      expect((await importAs(host.token, encodeR4S1(gzipJson({ ...raw, game }), ''))).json()).toMatchObject({
        ok: false,
        error: { code: 'SAVE_INCOMPATIBLE', details: { reason: 'invalidState' } },
      });
    }
    const badMap = encodeR4S1(gzipJson({ ...raw, mapRef: { id: 'test', mapHash: 'deadbeef' } }), '');
    expect((await importAs(host.token, badMap)).json()).toMatchObject({
      ok: false,
      error: { code: 'SAVE_INCOMPATIBLE', details: { reason: 'mapHashMismatch' } },
    });
    const noToken = await f.inject({
      method: 'POST',
      url: '/api/saves/import',
      payload: text,
      headers: { 'content-type': 'text/plain' },
    });
    expect(noToken.statusCode).toBe(400);
    const tooBig = await importAs(host.token, 'R4S1.'.padEnd(2 * 1024 * 1024 + 10, 'A'));
    expect(tooBig.statusCode).toBe(400);
    expect(tooBig.json()).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST', details: { reason: 'tooLarge' } } });

    // 删除只移除自己的归属
    expect((await host.req('saves:delete', { saveId })).ok).toBe(true);
    expect((await listSaves(host)).map((x) => x.saveId)).not.toContain(saveId);
    expect((await listSaves(s.bots[1]!)).map((x) => x.saveId)).toContain(saveId);
  }, 60_000);

  it('导入存档的边界：解压上限与 engine 字段、名字按码点截断、兼容性提示下发、断线宽限夹取、非官方存档读档后再存仍是非官方、观战私聊不进存档', async () => {
    srv = await startTestServer({ rateLimitScale: 0, testMode: false, roomDefaults: { spectatorChat: 'spectators' } });
    const s = await setupRoom(srv.url, { humans: 2, settings: { timerPreset: 'off' } });
    bots.push(...s.bots);
    const [host, p1] = s.bots as [BotClient, BotClient];
    await startGame(s);
    const sv = await host.req('game:save', { name: 'base' });
    if (!sv.ok) throw new Error(sv.error.code);
    expect((await host.req('room:dissolve', {})).ok).toBe(true);
    const f = srv.app.fastify;
    const exportText = async (token: string, id: string): Promise<string> => {
      const r = await f.inject({
        method: 'GET',
        url: `/api/saves/${encodeURIComponent(id)}/export`,
        headers: { 'x-player-token': token },
      });
      expect(r.statusCode, r.body).toBe(200);
      return r.body;
    };
    const importAs = (token: string, payload: string) =>
      f.inject({
        method: 'POST',
        url: '/api/saves/import',
        headers: { 'x-player-token': token, 'content-type': 'text/plain' },
        payload,
      });
    const text = await exportText(host.token, sv.data.saveId);
    const { blob, sig } = decodeR4S1(text);
    const raw = gunzipJson(blob) as Record<string, unknown> & { game: Record<string, unknown> };

    // 压缩炸弹：8MB 的 engine 字段压缩后只有几 KB，解压超过 2MB 上限即拒绝
    const bomb = encodeR4S1(gzipJson({ ...raw, game: { ...raw.game, engine: 'x'.repeat(8 * 1024 * 1024) } }), '');
    expect(bomb.length).toBeLessThan(64 * 1024);
    expect((await importAs(host.token, bomb)).json()).toMatchObject({
      ok: false,
      error: { code: 'SAVE_INCOMPATIBLE', details: { reason: 'tooLarge' } },
    });
    // 上限以内的垃圾也挡住：engine 必须是版本号；公开世界里的字符串有界（GameStateSchema，只有真实引擎校验）
    const junk: Record<string, unknown>[] = [
      { ...raw.game, engine: 'x'.repeat(100) },
      { ...raw.game, engine: '0.2.0 but not really' },
    ];
    if (srv.engineKind === 'real') {
      junk.push({ ...raw.game, dataRef: { ...(raw.game.dataRef as object), tablesHash: 'y'.repeat(4096) } });
    }
    for (const game of junk) {
      expect((await importAs(host.token, encodeR4S1(gzipJson({ ...raw, game }), ''))).json()).toMatchObject({
        ok: false,
        error: { code: 'SAVE_INCOMPATIBLE', details: { reason: 'invalidState' } },
      });
    }

    // 存档名按码点截到 40 字，不留孤立代理项
    const emoji = await importAs(host.token, encodeR4S1(gzipJson({ ...raw, name: `a${'😀'.repeat(45)}` }), ''));
    const emojiName = (emoji.json() as { data: SaveSummary }).data.name;
    expect(Array.from(emojiName)).toHaveLength(40);
    expect(/[\uD800-\uDBFF]$/.test(emojiName)).toBe(false);

    // 篡改（签名失效）+ 数据表不一致 + 断线宽限 0：仍可导入，verified=false 并带兼容性提示
    const settings = raw.roomSettings as Record<string, unknown>;
    const forged = encodeR4S1(
      gzipJson({ ...raw, name: 'forged', tablesHash: 'deadbeef', roomSettings: { ...settings, reconnectGraceSec: 0 } }),
      sig,
    );
    const imp = await importAs(host.token, forged);
    expect(imp.statusCode, imp.body).toBe(200);
    const forgedSum = (imp.json() as { data: SaveSummary }).data;
    expect(forgedSum).toMatchObject({ name: 'forged', verified: false, warnings: ['tablesHashMismatch'] });
    expect((await listSaves(host)).find((x) => x.saveId === sv.data.saveId)?.warnings).toEqual([]);

    // 读档：宽限夹到 5 秒；大厅与系统消息带数据表不一致提示
    const code2 = await newRoom(host);
    expect((await p1.req('room:join', { code: code2, role: 'player' })).ok).toBe(true);
    expect((await host.req('room:loadSave', { saveId: forgedSum.saveId })).ok).toBe(true);
    await host.until(() => host.room?.loadedSave?.saveId === forgedSum.saveId, 3000, 'loaded');
    expect(host.room!.loadedSave).toMatchObject({ verified: false, warnings: ['tablesHashMismatch'] });
    expect(host.room!.settings.reconnectGraceSec).toBe(5);
    const loadedMsg = host.received.find(
      (m) => m.event === 'chat:message' && (m.payload as { system?: { key: string } }).system?.key === 'gameLoaded',
    );
    expect(loadedMsg).toBeDefined();
    expect((loadedMsg!.payload as { system: { params: unknown } }).system.params).toMatchObject({
      name: 'forged',
      verified: 0,
      tablesMismatch: 1,
    });

    // 观战者专属聊天
    const spec = await connectBot(srv.url, { nickname: '观众' });
    bots.push(spec);
    expect((await spec.req('room:join', { code: code2, role: 'spectator' })).ok).toBe(true);
    expect((await p1.req('room:setReady', { ready: true })).ok).toBe(true);
    expect((await host.req('room:start', {})).ok).toBe(true);
    await host.until(() => host.epoch >= 1 && host.view !== undefined, 5000, 'snapshot');
    expect((await spec.req('chat:send', { text: '只给观战者看的悄悄话' })).ok).toBe(true);
    expect((await host.req('chat:send', { text: '玩家说给全体' })).ok).toBe(true);
    await spec.until(
      () =>
        spec.received.some(
          (m) => m.event === 'chat:message' && (m.payload as { text?: string }).text === '玩家说给全体',
        ),
      3000,
      'chat',
    );

    // 非官方来源的对局：手动存档与自动存档都不签名
    const laundered = await host.req('game:save', { name: 'laundered' });
    if (!laundered.ok) throw new Error(laundered.error.code);
    expect((await host.req('room:dissolve', {})).ok).toBe(true);
    const mine = await listSaves(host);
    expect(mine.find((x) => x.saveId === laundered.data.saveId)).toMatchObject({ verified: false });
    expect(mine.find((x) => x.saveId === autoSaveId(code2))).toMatchObject({ kind: 'auto', verified: false });
    const reText = await exportText(host.token, laundered.data.saveId);
    expect(decodeR4S1(reText).sig).toBe('');
    const reImp = await importAs(p1.token, reText);
    expect((reImp.json() as { data: SaveSummary }).data.verified).toBe(false);
    const chatTail = (gunzipJson(decodeR4S1(reText).blob) as { chatTail: { text?: string; audience: string }[] })
      .chatTail;
    expect(chatTail.map((m) => m.text)).toContain('玩家说给全体');
    expect(chatTail.some((m) => m.audience === 'spectators')).toBe(false);
    expect(chatTail.map((m) => m.text)).not.toContain('只给观战者看的悄悄话');
  }, 60_000);
});
