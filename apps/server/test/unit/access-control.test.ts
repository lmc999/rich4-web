// AccessControl + SqliteAccessStore：登录（口令 / 邀请码）、滑动续期、房间授权的期限与次数、吊销（epoch）
import { DatabaseSync } from 'node:sqlite';
import { ACCESS_GRANT_MAX_USES, ACCESS_GRANT_TTL_MS } from '@rich4/shared/net';
import { beforeAll, describe, expect, it } from 'vitest';
import { type AccessConfig, AccessControl } from '../../src/access/AccessControl';
import { normalizeInviteCode, SqliteAccessStore } from '../../src/access/AccessStore';
import { AccessLimiter } from '../../src/access/limiter';
import { hashPasscode, type PasscodeHash, parsePasscodeHash, SCRYPT_LIMITS } from '../../src/access/passcode';
import { silentLogger } from '../../src/infra/logger';

const PASS = 'test-passcode-0001';
const DAY = 86_400_000;
let HASH: PasscodeHash;

beforeAll(async () => {
  const p = parsePasscodeHash(await hashPasscode(PASS, { N: SCRYPT_LIMITS.minN, r: 8, p: 1 }));
  if (!p.ok) throw new Error(p.reason);
  HASH = p.value;
});

function setup(o: Partial<AccessConfig> = {}, rooms: string[] = ['123456']) {
  let t = 1_800_000_000_000;
  const db = new DatabaseSync(':memory:');
  const store = new SqliteAccessStore(db);
  const now = () => t;
  const ac = new AccessControl({
    config: {
      mode: 'passcode',
      passcodeHash: HASH,
      secret: 's'.repeat(32),
      ttlDays: 30,
      grants: true,
      secure: false,
      ...o,
    },
    store,
    log: silentLogger,
    now,
    sleep: async () => {},
    limiter: new AccessLimiter({ now, globalPerMin: 1e6, globalBurst: 1e6 }),
    roomExists: (c) => rooms.includes(c),
  });
  return {
    ac,
    store,
    db,
    advance: (ms: number) => {
      t += ms;
    },
    now,
  };
}

/** Set-Cookie → 请求 Cookie 头 */
const cookieOf = (setCookie: string | null) => (setCookie ?? '').split(';')[0]!;

describe('AccessControl', () => {
  it('mode=off：一律放行，登录无需 cookie', async () => {
    const db = new DatabaseSync(':memory:');
    const ac = new AccessControl({
      config: { mode: 'off', passcodeHash: null, secret: null, ttlDays: 30, grants: true, secure: false },
      store: null,
      log: silentLogger,
    });
    expect(ac.enabled).toBe(false);
    expect(ac.check(undefined)).toMatchObject({ granted: true });
    expect(await ac.login('x', 'ip')).toMatchObject({
      ok: true,
      setCookie: null,
      data: { mode: 'off', granted: true },
    });
    expect(ac.statusOf(ac.check(undefined))).toMatchObject({ grants: false, canGrant: false });
    db.close();
  });

  it('口令登录：错误 401、正确签发 30 天 cookie（kind p），状态可生成授权', async () => {
    const { ac } = setup();
    expect(ac.check(undefined)).toMatchObject({ granted: false, reason: 'missing' });
    expect(await ac.login('wrong', '1.2.3.4')).toMatchObject({
      ok: false,
      status: 401,
      code: 'ACCESS_REQUIRED',
      details: { reason: 'badPasscode' },
    });
    const r = await ac.login(PASS, '1.2.3.4');
    if (!r.ok) throw new Error('login failed');
    expect(r.setCookie).toMatch(/^r4_access=v1\.\d+\.0\.p\.[^;]+; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax$/);
    const g = ac.check(cookieOf(r.setCookie));
    expect(g).toMatchObject({ granted: true, claims: { kind: 'p', epoch: 0 }, renew: null });
    expect(r.data).toMatchObject({ mode: 'passcode', granted: true, kind: 'p', grants: true, canGrant: true });
  });

  it('滑动续期：签发 1 天后的请求换发新 cookie；30 天不用则过期', async () => {
    const { ac, advance } = setup();
    const r = await ac.login(PASS, 'ip');
    if (!r.ok) throw new Error('login failed');
    const c0 = cookieOf(r.setCookie);
    advance(DAY - 1000);
    expect(ac.check(c0).renew).toBeNull();
    advance(2000);
    const renewed = ac.check(c0).renew;
    expect(renewed).toMatch(/Max-Age=2592000/);
    // 新 cookie 从现在起再给 30 天：旧 cookie 到期时新 cookie 仍有效
    advance(29 * DAY);
    expect(ac.check(c0)).toMatchObject({ granted: false, reason: 'expired' });
    expect(ac.check(cookieOf(renewed))).toMatchObject({ granted: true });
  });

  it('房间授权：24 小时、最多 8 次；兑换得到 24 小时的 g cookie；g 不能再生成授权', async () => {
    const { ac, advance } = setup();
    const login = await ac.login(PASS, 'ip');
    if (!login.ok) throw new Error('login failed');
    const host = ac.check(cookieOf(login.setCookie));
    const gr = ac.grant(host, '123456', 'ip');
    if (!gr.ok) throw new Error('grant failed');
    expect(gr.data).toMatchObject({
      room: '123456',
      uses: ACCESS_GRANT_MAX_USES,
      path: `/r/123456#g=${gr.data.token}`,
    });
    expect(gr.data.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(ac.grant(host, '999999', 'ip')).toMatchObject({ ok: false, status: 404, code: 'ROOM_NOT_FOUND' });
    expect(ac.grant(ac.check(undefined), '123456', 'ip')).toMatchObject({ ok: false, status: 401 });

    const cookies: string[] = [];
    for (let i = 0; i < ACCESS_GRANT_MAX_USES; i++) {
      const rd = await ac.redeem(ac.check(undefined), gr.data.token, `10.0.0.${i}`);
      if (!rd.ok) throw new Error(`redeem ${i} failed`);
      expect(rd.data).toMatchObject({ granted: true, kind: 'g', room: '123456', canGrant: false });
      expect(rd.setCookie).toMatch(/Max-Age=86400;/);
      cookies.push(cookieOf(rd.setCookie));
    }
    expect(await ac.redeem(ac.check(undefined), gr.data.token, 'x')).toMatchObject({
      ok: false,
      status: 401,
      details: { reason: 'grantInvalid' },
    });
    const guest = ac.check(cookies[0]);
    expect(guest).toMatchObject({ granted: true, claims: { kind: 'g' } });
    expect(ac.grant(guest, '123456', 'x')).toMatchObject({
      ok: false,
      status: 403,
      details: { reason: 'grantNotAllowed' },
    });

    // 过期：24 小时后未兑换的授权失效
    const gr2 = ac.grant(host, '123456', 'ip');
    if (!gr2.ok) throw new Error('grant failed');
    advance(ACCESS_GRANT_TTL_MS);
    expect(await ac.redeem(ac.check(undefined), gr2.data.token, 'y')).toMatchObject({ ok: false, status: 401 });
  });

  it('已持有效 cookie 的人兑换授权不消耗次数（也不降级为 g）', async () => {
    const { ac } = setup();
    const login = await ac.login(PASS, 'ip');
    if (!login.ok) throw new Error('login failed');
    const host = ac.check(cookieOf(login.setCookie));
    const gr = ac.grant(host, '123456', 'ip');
    if (!gr.ok) throw new Error('grant failed');
    for (let i = 0; i < ACCESS_GRANT_MAX_USES + 2; i++) {
      const rd = await ac.redeem(host, gr.data.token, 'ip');
      expect(rd).toMatchObject({ ok: true, setCookie: null, data: { kind: 'p', room: '123456' } });
    }
    expect(await ac.redeem(ac.check(undefined), gr.data.token, 'z')).toMatchObject({ ok: true });
  });

  it('吊销（epoch+1）：全部 cookie 与未兑换授权立即失效；另一进程改库时 1 秒内生效', async () => {
    const { ac, store, advance } = setup();
    const login = await ac.login(PASS, 'ip');
    if (!login.ok) throw new Error('login failed');
    const c = cookieOf(login.setCookie);
    const gr = ac.grant(ac.check(c), '123456', 'ip');
    if (!gr.ok) throw new Error('grant failed');
    expect(ac.revokeAll()).toBe(1);
    expect(ac.check(c)).toMatchObject({ granted: false, reason: 'revoked' });
    expect(await ac.redeem(ac.check(undefined), gr.data.token, 'q')).toMatchObject({ ok: false });

    const again = await ac.login(PASS, 'ip');
    if (!again.ok) throw new Error('login failed');
    const c2 = cookieOf(again.setCookie);
    store.bumpEpoch(); // 模拟 CLI 在另一个进程里吊销
    expect(ac.check(c2)).toMatchObject({ granted: true }); // epoch 缓存
    advance(1000);
    expect(ac.check(c2)).toMatchObject({ granted: false, reason: 'revoked' });
  });

  it('邀请码：口令模式也接受；邀请模式只认邀请码；次数、期限、撤销', async () => {
    const { ac, advance } = setup({ mode: 'invite', passcodeHash: null });
    const inv = ac.createInvite({ uses: 2, days: 1 });
    expect(inv.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(await ac.login(PASS, 'ip')).toMatchObject({ ok: false, details: { reason: 'badInvite' } });
    const lower = inv.code.toLowerCase().replaceAll('-', ' ');
    expect(await ac.login(lower, 'ip')).toMatchObject({ ok: true, data: { kind: 'i', canGrant: true } });
    expect(await ac.login(inv.code, 'ip')).toMatchObject({ ok: true });
    expect(await ac.login(inv.code, 'ip')).toMatchObject({ ok: false }); // 用完
    const inv2 = ac.createInvite({ uses: 5, days: 1 });
    expect(ac.revokeInvite(inv2.invite.id)).toBe(true);
    expect(await ac.login(inv2.code, 'ip')).toMatchObject({ ok: false });
    const inv3 = ac.createInvite({ uses: 5, days: 1 });
    advance(DAY);
    expect(await ac.login(inv3.code, 'ip')).toMatchObject({ ok: false }); // 过期
    const left = new Map(ac.listInvites().map((i) => [i.id, i.usesLeft]));
    expect([left.get(inv.invite.id), left.get(inv2.invite.id), left.get(inv3.invite.id)]).toEqual([0, 5, 5]);

    const pc = setup();
    const inv4 = pc.ac.createInvite({ uses: 1, days: null });
    expect(await pc.ac.login(inv4.code, 'ip')).toMatchObject({ ok: true, data: { kind: 'i' } });
  });

  it('登录失败累计后退避 429（带 retryAfterMs），等过窗口口令照常可用', async () => {
    const { ac, advance } = setup();
    for (let i = 0; i < 6; i++) expect(await ac.login('nope', '9.9.9.9')).toMatchObject({ ok: false, status: 401 });
    const r = await ac.login(PASS, '9.9.9.9');
    expect(r).toMatchObject({ ok: false, status: 429, code: 'RATE_LIMITED', retryAfterMs: 1000 });
    advance(1000);
    expect(await ac.login(PASS, '9.9.9.9')).toMatchObject({ ok: true });
  });

  it('同一 IP 并发登录不能绕过退避：在途的验证按失败计，且验证结束（含抛错）后释放在途名额', async () => {
    let t = 1_800_000_000_000;
    const now = () => t;
    const limiter = new AccessLimiter({ now });
    const db = new DatabaseSync(':memory:');
    const ac = new AccessControl({
      config: {
        mode: 'passcode',
        passcodeHash: HASH,
        secret: 's'.repeat(32),
        ttlDays: 30,
        grants: true,
        secure: false,
      },
      store: new SqliteAccessStore(db),
      log: silentLogger,
      now,
      sleep: async () => {},
      limiter,
    });
    const ip = '203.0.113.50';
    const first = await Promise.all(Array.from({ length: 20 }, () => ac.login('wrong-passcode', ip)));
    expect(first.filter((r) => !r.ok && r.status === 401)).toHaveLength(6);
    expect(first.filter((r) => !r.ok && r.status === 429)).toHaveLength(14);
    expect(first.every((r) => r.ok || r.status !== 429 || r.details?.scope === 'ip')).toBe(true);
    expect(limiter.inFlight(ip)).toBe(0);
    for (let round = 0; round < 3; round++) {
      t += limiter.retryAfter(ip);
      const again = await Promise.all(Array.from({ length: 20 }, () => ac.login('wrong-passcode', ip)));
      expect(
        again.filter((r) => !r.ok && r.status === 401),
        `round ${round}`,
      ).toHaveLength(1);
    }
    // 别的 IP 用正确口令照常进入（不被全局名额挡住）
    expect(await ac.login(PASS, '198.51.100.20')).toMatchObject({ ok: true });
    // 验证抛错也释放在途名额
    const bad = new AccessControl({
      config: {
        mode: 'passcode',
        passcodeHash: { ...HASH, N: 3 },
        secret: 's'.repeat(32),
        ttlDays: 30,
        grants: true,
        secure: false,
      },
      store: new SqliteAccessStore(db),
      log: silentLogger,
      now,
      sleep: async () => {},
      limiter,
    });
    await expect(bad.login('x-passcode', '192.0.2.99')).rejects.toThrow();
    expect(limiter.inFlight('192.0.2.99')).toBe(0);
    db.close();
  });

  it('兑换房间授权用单独的限流器：刷兑换接口不占口令验证的全局名额', async () => {
    const t = 1_800_000_000_000;
    const now = () => t;
    const db = new DatabaseSync(':memory:');
    const limiter = new AccessLimiter({ now });
    const ac = new AccessControl({
      config: {
        mode: 'passcode',
        passcodeHash: HASH,
        secret: 's'.repeat(32),
        ttlDays: 30,
        grants: true,
        secure: false,
      },
      store: new SqliteAccessStore(db),
      log: silentLogger,
      now,
      sleep: async () => {},
      limiter,
    });
    const anon = ac.check(undefined);
    const token = 'A'.repeat(43);
    for (let i = 0; i < 40; i++) await ac.redeem(anon, token, `10.9.${i >> 8}.${i & 255}`);
    // 口令验证的全局桶未动：新 IP 立即放行，不用排队
    expect(limiter.admit('198.51.100.30')).toEqual({ ok: true, waitMs: 0 });
    limiter.release('198.51.100.30');
    expect(await ac.login(PASS, '198.51.100.31')).toMatchObject({ ok: true });
    db.close();
  });

  it('normalizeInviteCode：容错 O/0、I/L/1、空白与连字符', () => {
    expect(normalizeInviteCode('abcd-efgh-jkmn-pqrs')).toBe('ABCDEFGHJKMNPQRS');
    expect(normalizeInviteCode(' 0o1i-L222 3333-4444 ')).toBe('0011122233334444');
    expect(normalizeInviteCode('short')).toBeNull();
    expect(normalizeInviteCode('UUUU-UUUU-UUUU-UUUU')).toBeNull();
  });

  it('SqliteAccessStore.prune 删掉过期、用完与撤销的记录', () => {
    const db = new DatabaseSync(':memory:');
    const s = new SqliteAccessStore(db);
    const t = 1000;
    s.createGrant({ room: '111111', uses: 1, expiresAt: t + 10, epoch: 0, now: t });
    const live = s.createGrant({ room: '222222', uses: 1, expiresAt: t + 1e9, epoch: 0, now: t });
    s.createInvite({ uses: 1, expiresAt: t + 10, now: t });
    const keep = s.createInvite({ uses: 1, expiresAt: null, now: t });
    expect(s.prune(t + 20)).toBe(2);
    expect(s.peekGrant(live, t + 20, 0)).toMatchObject({ room: '222222' });
    expect(s.listInvites().map((i) => i.id)).toEqual([keep.invite.id]);
    db.close();
  });
});
