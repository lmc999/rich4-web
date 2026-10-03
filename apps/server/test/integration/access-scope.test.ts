/**
 * 经房间邀请链接进入的会话（访问 cookie kind g）的作用域（architecture §35）：
 * 建房（含单机）、读档、导入存档、公开房间列表、加入或观战别的房间一律 ACCESS_SCOPE；在邀请的房间里入座、选角、准备、
 * 聊天、对局、断线重连、再开一局照常；会话换成 g cookie 之后不能继续操作以前所在的别的房间；
 * 旧格式（v1）的 g cookie 握手被拒（outdated）；g 会话打开另一个房间的链接时换绑新房间。
 * 停用邀请码（DELETE /admin/access/invites/:id）：用它登录的会话下一次 /api 与握手即被拒，已建立的连接不断开。
 */
import { createHmac } from 'node:crypto';
import type { CharacterId } from '@rich4/shared/engine';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cookieKey } from '../../src/access/cookie';
import { hashPasscode, parsePasscodeHash, SCRYPT_LIMITS } from '../../src/access/passcode';
import { type BotClient, connectBot, newToken } from '../helpers/botClient';
import { startTestServer, type TestServer } from '../helpers/startTestServer';

const PASS = 'scope-passcode-42';
const SECRET = 'integration-scope-secret-0123456789abcdef';
const ADMIN = 'integration-scope-admin-token-0123456789';
let HASH: ReturnType<typeof parsePasscodeHash> & { ok: true };

beforeAll(async () => {
  const h = parsePasscodeHash(await hashPasscode(PASS, { N: SCRYPT_LIMITS.minN, r: 8, p: 1 }));
  if (!h.ok) throw new Error(h.reason);
  HASH = h;
});

let srv: TestServer | null = null;
const bots: BotClient[] = [];

afterEach(async () => {
  for (const b of bots.splice(0)) b.close();
  await srv?.close();
  srv = null;
});

async function gated(): Promise<TestServer> {
  srv = await startTestServer({
    rateLimitScale: 0,
    adminToken: ADMIN,
    access: { mode: 'passcode', passcodeHash: HASH.value, secret: SECRET, grants: true, secure: false },
    accessOptions: { sleep: async () => {}, epochCacheMs: 0 },
  });
  return srv;
}

const json = { 'content-type': 'application/json' };

function cookieFrom(res: LightMyRequestResponse): string {
  const sc = res.headers['set-cookie'];
  const first = Array.isArray(sc) ? sc[0] : sc;
  if (!first) throw new Error(`no set-cookie (status ${res.statusCode}: ${res.body})`);
  return first.split(';')[0]!;
}

async function passCookie(s: TestServer): Promise<string> {
  const r = await s.app.fastify.inject({
    method: 'POST',
    url: '/api/access',
    headers: json,
    payload: { passcode: PASS },
  });
  return cookieFrom(r);
}

/** 房主（口令 cookie）为房间生成链接，受邀者（可带已有 cookie）兑换；返回兑换响应 */
async function redeemFor(s: TestServer, hostCookie: string, room: string, cookie?: string) {
  const f = s.app.fastify;
  const g = await f.inject({
    method: 'POST',
    url: '/api/access/grant',
    headers: { ...json, cookie: hostCookie },
    payload: { room },
  });
  expect(g.statusCode, g.body).toBe(200);
  const token = (g.json().data as { token: string }).token;
  return f.inject({
    method: 'POST',
    url: '/api/access/redeem',
    headers: { ...json, ...(cookie ? { cookie } : {}) },
    payload: { token },
  });
}

async function bot(s: TestServer, nickname: string, cookie: string, token?: string): Promise<BotClient> {
  const b = await connectBot(s.url, { nickname, extraHeaders: { cookie }, ...(token ? { token } : {}) });
  bots.push(b);
  return b;
}

const SCOPE = { ok: false, error: { code: 'ACCESS_SCOPE' } };

describe('integration/access-scope', () => {
  it('g 会话：建房 / 单机 / 读档 / 导入存档 / 公开房间列表 / 进别的房间被拒；本房间内入座、聊天、对局、重连、再开一局正常', async () => {
    const s = await gated();
    const hostCookie = await passCookie(s);
    const host = await bot(s, 'Host', hostCookie);
    const a = await host.req('room:create', { settings: { game: { timeLimitDays: 30 } } });
    if (!a.ok) throw new Error('room:create failed');
    const roomA = a.data.code;
    const other = await bot(s, 'Other', await passCookie(s));
    const b = await other.req('room:create', {});
    if (!b.ok) throw new Error('room:create failed');
    const roomB = b.data.code;

    const rd = await redeemFor(s, hostCookie, roomA);
    expect(rd.json()).toMatchObject({ data: { kind: 'g', room: roomA, target: roomA } });
    const guestCookie = cookieFrom(rd);
    const status = await s.app.fastify.inject({ url: '/api/access', headers: { cookie: guestCookie } });
    expect(status.json()).toMatchObject({ data: { granted: true, kind: 'g', room: roomA, canGrant: false } });

    const guestToken = newToken();
    const guest = await bot(s, 'Guest', guestCookie, guestToken);
    // 建房（单机与首页读档都先建房）、公开房间列表、读档
    expect(await guest.req('room:create', {})).toMatchObject({ ...SCOPE, error: { details: { room: roomA } } });
    expect(await guest.req('lobby:list', {})).toMatchObject(SCOPE);
    expect(await guest.req('room:loadSave', { saveId: 'auto:123456' })).toMatchObject(SCOPE);
    // 别的房间：加入、观战、续连都被拒；不存在的房间号同样是 ACCESS_SCOPE（不泄露是否存在）
    expect(await guest.req('room:join', { code: roomB, role: 'player' })).toMatchObject(SCOPE);
    expect(await guest.req('room:join', { code: roomB, role: 'spectator' })).toMatchObject(SCOPE);
    expect(await guest.req('room:resume', { code: roomB, lastSeq: 0, epoch: 0 })).toMatchObject(SCOPE);
    expect(await guest.req('room:join', { code: '999999', role: 'player' })).toMatchObject(SCOPE);
    // 不在房间时的房间内事件交给处理函数（NOT_IN_ROOM），时间校准不受限
    expect(await guest.req('room:setReady', { ready: true })).toMatchObject({ error: { code: 'NOT_IN_ROOM' } });
    expect((await guest.req('time:ping', { t0: 1 })).ok).toBe(true);
    expect((await guest.req('saves:list', {})).ok).toBe(true);
    // HTTP：导入存档被拒，生成授权被拒
    const imp = await s.app.fastify.inject({
      method: 'POST',
      url: '/api/saves/import',
      headers: { ...json, cookie: guestCookie, 'x-player-token': guestToken },
      payload: { text: 'R4S1.x.y' },
    });
    expect(imp.statusCode).toBe(403);
    expect(imp.json()).toMatchObject({ ok: false, error: { code: 'ACCESS_SCOPE' } });
    const regrant = await s.app.fastify.inject({
      method: 'POST',
      url: '/api/access/grant',
      headers: { ...json, cookie: guestCookie },
      payload: { room: roomA },
    });
    expect(regrant.statusCode).toBe(403);

    // 邀请的房间：入座、选角、准备、聊天照常；在房间里也不能读档
    expect(await guest.req('room:join', { code: roomA, role: 'player' })).toMatchObject({ ok: true });
    expect((await guest.req('room:selectCharacter', { characterId: 1 as CharacterId })).ok).toBe(true);
    expect((await guest.req('room:setReady', { ready: true })).ok).toBe(true);
    expect((await guest.req('chat:send', { text: 'hello' })).ok).toBe(true);
    expect(await guest.req('room:loadSave', { saveId: 'auto:123456' })).toMatchObject(SCOPE);
    expect((await host.req('room:selectCharacter', { characterId: 0 as CharacterId })).ok).toBe(true);
    expect(await host.req('room:start', {})).toEqual({ ok: true });
    await guest.until(() => guest.epoch >= 1 && guest.view !== undefined, 5000, 'snapshot');
    await host.until(() => host.view !== undefined, 5000, 'snapshot');

    // 断线重连：同一 token、同一 g cookie 续连本房间
    guest.close();
    const back = await bot(s, 'Guest', guestCookie, guestToken);
    expect(await back.req('room:resume', { code: roomA, lastSeq: 0, epoch: 0 })).toMatchObject({ ok: true });
    await back.until(() => back.view !== undefined, 5000, 'snapshot after resume');
    expect(await back.req('room:join', { code: roomB, role: 'spectator' })).toMatchObject(SCOPE);

    // 打完一局、同房间再开一局：房主 rematch，受邀者照常准备
    host.autoPlay();
    back.autoPlay();
    await host.until(() => host.over !== undefined, 20_000, 'game over');
    await host.until(() => host.room?.phase === 'ended');
    expect(await host.req('room:rematch', {})).toEqual({ ok: true });
    await back.until(() => back.room?.phase === 'lobby');
    expect((await back.req('room:setReady', { ready: true })).ok).toBe(true);
    expect((await back.req('chat:send', { text: 'again' })).ok).toBe(true);
  });

  it('会话换成 g cookie 之后不能继续操作以前所在的别的房间；加入邀请的房间时自动离开旧房间', async () => {
    const s = await gated();
    const hostCookie = await passCookie(s);
    const host = await bot(s, 'Host', hostCookie);
    const a = await host.req('room:create', {});
    if (!a.ok) throw new Error('room:create failed');
    const other = await bot(s, 'Other', await passCookie(s));
    const b = await other.req('room:create', {});
    if (!b.ok) throw new Error('room:create failed');

    // 同一个玩家 token 先用口令 cookie 进了房间 B
    const token = newToken();
    const before = await bot(s, 'P', await passCookie(s), token);
    expect((await before.req('room:join', { code: b.data.code, role: 'player' })).ok).toBe(true);
    before.close();
    // 之后只有房间 A 的 g cookie：房间 B 的操作被拒，加入 A 照常（离开 B）
    const guestCookie = cookieFrom(await redeemFor(s, hostCookie, a.data.code));
    const after = await bot(s, 'P', guestCookie, token);
    expect(await after.req('chat:send', { text: 'x' })).toMatchObject(SCOPE);
    expect(await after.req('room:setReady', { ready: true })).toMatchObject(SCOPE);
    expect(await after.req('room:resume', { code: b.data.code, lastSeq: 0, epoch: 0 })).toMatchObject(SCOPE);
    expect((await after.req('room:join', { code: a.data.code, role: 'player' })).ok).toBe(true);
    expect((await after.req('room:setReady', { ready: true })).ok).toBe(true);
    await other.until(() => other.room?.seats.every((x, i) => i === 0 || x.occupant === null) === true);
  });

  it('g 会话打开另一个房间的链接：消耗次数、换绑新房间；持口令的人打开不消耗；旧格式 g cookie 握手被拒', async () => {
    const s = await gated();
    const f = s.app.fastify;
    const hostCookie = await passCookie(s);
    const host = await bot(s, 'Host', hostCookie);
    const b = await host.req('room:create', {});
    if (!b.ok) throw new Error('room:create failed');
    // 同一个人同时只能在一个房间：另一个房间由另一个口令玩家建
    const other = await bot(s, 'Other', await passCookie(s));
    const c = await other.req('room:create', {});
    if (!c.ok) throw new Error('room:create failed');
    const roomA = c.data.code;
    const roomB = b.data.code;

    const guestA = cookieFrom(await redeemFor(s, hostCookie, roomA));
    const moved = await redeemFor(s, hostCookie, roomB, guestA);
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ data: { kind: 'g', room: roomB, target: roomB, roomOpen: true } });
    const guestB = cookieFrom(moved);
    const g = await bot(s, 'G', guestB);
    expect((await g.req('room:join', { code: roomB, role: 'player' })).ok).toBe(true);
    expect(await g.req('room:join', { code: roomA, role: 'spectator' })).toMatchObject(SCOPE);

    // g 会话后来拿到口令：带着 g cookie 登录照常成功，换发 p cookie，可以建房、进别的房间
    const up = await f.inject({
      method: 'POST',
      url: '/api/access',
      headers: { ...json, cookie: guestB },
      payload: { passcode: PASS },
    });
    expect(up.statusCode).toBe(200);
    expect(up.json()).toMatchObject({ data: { kind: 'p', room: null, roomOpen: null, canGrant: true } });
    const upgraded = cookieFrom(up);
    expect(upgraded).toMatch(/^r4_access=v2\.\d+\.\d+\.p\./);
    const pBot = await bot(s, 'P', upgraded);
    expect((await pBot.req('room:join', { code: roomA, role: 'spectator' })).ok).toBe(true);
    expect((await pBot.req('room:create', {})).ok).toBe(true);

    // 持口令 cookie 的人打开链接：不换 cookie、不消耗
    const p = await redeemFor(s, hostCookie, roomA, hostCookie);
    expect(p.json()).toMatchObject({ data: { kind: 'p', room: null, target: roomA } });
    expect(p.headers['set-cookie']).toBeUndefined();

    // 旧格式（v1）的 g cookie：签名有效也不认，握手 ACCESS_REQUIRED（reason outdated），状态接口清掉它
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const body = `v1.${exp}.0.g`;
    const v1 = `r4_access=${body}.${createHmac('sha256', cookieKey(SECRET)).update(body).digest('base64url')}`;
    await expect(connectBot(s.url, { extraHeaders: { cookie: v1 } })).rejects.toMatchObject({
      data: { code: 'ACCESS_REQUIRED', details: { reason: 'outdated' } },
    });
    const st = await f.inject({ url: '/api/access', headers: { cookie: v1 } });
    expect(st.json()).toMatchObject({ data: { granted: false } });
    expect(String(st.headers['set-cookie'])).toContain('Max-Age=0');
    // 旧格式的口令 cookie 继续有效
    const pv1Body = `v1.${exp}.0.p`;
    const pv1 = `r4_access=${pv1Body}.${createHmac('sha256', cookieKey(SECRET)).update(pv1Body).digest('base64url')}`;
    expect((await f.inject({ url: '/api/maps', headers: { cookie: pv1 } })).statusCode).toBe(200);
    const okBot = await bot(s, 'Old', pv1);
    expect((await okBot.req('lobby:list', {})).ok).toBe(true);
  });

  it('停用邀请码：用它登录的会话下一次 /api/access 未授权、握手被拒；已建立的连接不断开；它生成的授权与 g 会话不受影响', async () => {
    const s = await gated();
    const f = s.app.fastify;
    const auth = { authorization: `Bearer ${ADMIN}` };
    const created = await f.inject({
      method: 'POST',
      url: '/admin/access/invites',
      headers: { ...auth, ...json },
      payload: { uses: 2, days: 1, note: 'ext:it' },
    });
    expect(created.statusCode).toBe(200);
    const { code, invite } = created.json().data as { code: string; invite: { id: string; expiresAt: number } };
    const login = await f.inject({ method: 'POST', url: '/api/access', headers: json, payload: { passcode: code } });
    expect(login.json()).toMatchObject({
      data: { kind: 'i', deadline: Math.floor(invite.expiresAt / 1000) * 1000 },
    });
    const ic = cookieFrom(login);
    expect(ic).toContain(`.i.`);
    expect(ic).toContain(`.${invite.id}.`);
    const live = await bot(s, 'I', ic);
    const room = await live.req('room:create', {});
    if (!room.ok) throw new Error('room:create failed');
    // 用这个码登录的人生成的邀请链接：停用前兑换一个，停用后再兑换一个
    const guestCookie = cookieFrom(await redeemFor(s, ic, room.data.code));
    const g2 = await f.inject({
      method: 'POST',
      url: '/api/access/grant',
      headers: { ...json, cookie: ic },
      payload: { room: room.data.code },
    });
    const token2 = (g2.json().data as { token: string }).token;

    const del = await f.inject({ method: 'DELETE', url: `/admin/access/invites/${invite.id}`, headers: auth });
    expect(del.statusCode).toBe(200);

    const st = await f.inject({ url: '/api/access', headers: { cookie: ic } });
    expect(st.json()).toMatchObject({ data: { granted: false, kind: null } });
    expect(String(st.headers['set-cookie'])).toContain('Max-Age=0');
    const maps = await f.inject({ url: '/api/maps', headers: { cookie: ic } });
    expect(maps.statusCode).toBe(401);
    expect(maps.json()).toMatchObject({ error: { code: 'ACCESS_REQUIRED', details: { reason: 'revoked' } } });
    await expect(connectBot(s.url, { extraHeaders: { cookie: ic } })).rejects.toMatchObject({
      data: { code: 'ACCESS_REQUIRED', details: { reason: 'revoked' } },
    });
    expect(
      (await f.inject({ method: 'POST', url: '/api/access', headers: json, payload: { passcode: code } })).statusCode,
    ).toBe(401);
    // 已建立的连接照旧
    expect(live.socket.connected).toBe(true);
    expect((await live.req('chat:send', { text: 'still here' })).ok).toBe(true);
    // 经它的链接进来的 g 会话、停用前生成的链接不受影响
    expect((await f.inject({ url: '/api/access', headers: { cookie: guestCookie } })).json()).toMatchObject({
      data: { granted: true, kind: 'g', room: room.data.code },
    });
    const guest = await bot(s, 'G', guestCookie);
    expect((await guest.req('room:join', { code: room.data.code, role: 'player' })).ok).toBe(true);
    const late = await f.inject({
      method: 'POST',
      url: '/api/access/redeem',
      headers: json,
      payload: { token: token2 },
    });
    expect(late.json()).toMatchObject({ ok: true, data: { kind: 'g', room: room.data.code } });
    // 管理列表里仍看得到这个已停用的码（用完、停用而未过期的都保留，撤销状态要用来拦会话）
    const list = await f.inject({ url: '/admin/access/invites', headers: auth });
    expect(list.json()).toMatchObject({ data: { invites: [{ id: invite.id, revoked: true }] } });
  });
});
