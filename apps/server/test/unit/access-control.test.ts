// AccessControl + SqliteAccessStore：登录（口令 / 邀请码）、滑动续期（邀请码会话的到期上限）、房间授权的期限与次数、
// g 会话绑定房间实例、旧格式 cookie 的兼容、吊销（epoch）
import { createHash, createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ACCESS_GRANT_MAX_USES, ACCESS_GRANT_TTL_MS } from '@rich4/shared/net';
import { beforeAll, describe, expect, it } from 'vitest';
import { type AccessConfig, AccessControl } from '../../src/access/AccessControl';
import { normalizeInviteCode, SqliteAccessStore } from '../../src/access/AccessStore';
import { cookieKey } from '../../src/access/cookie';
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

const SECRET = 's'.repeat(32);

/** 房间号 → 当前实例（测试里可以改：关房、同号新房间） */
type Rooms = Map<string, string>;

function setup(o: Partial<AccessConfig> = {}, rooms: Rooms = new Map([['123456', 'r1']])) {
  let t = 1_800_000_000_000;
  const db = new DatabaseSync(':memory:');
  const store = new SqliteAccessStore(db);
  const now = () => t;
  const ac = new AccessControl({
    config: {
      mode: 'passcode',
      passcodeHash: HASH,
      secret: SECRET,
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
    roomInstance: (c) => rooms.get(c) ?? null,
  });
  return {
    ac,
    store,
    db,
    rooms,
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
    expect(r.setCookie).toMatch(
      /^r4_access=v2\.\d+\.0\.p\.0\.-\.[^;]+; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax$/,
    );
    const g = ac.check(cookieOf(r.setCookie));
    expect(g).toMatchObject({ granted: true, claims: { kind: 'p', epoch: 0, cap: 0, room: null }, renew: null });
    expect(r.data).toMatchObject({
      mode: 'passcode',
      granted: true,
      kind: 'p',
      grants: true,
      canGrant: true,
      deadline: null,
      room: null,
    });
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

  it('房间授权：30 分钟、只能兑换 1 次；兑换得到绑定房间实例的 24 小时 g cookie；g 不能再生成授权', async () => {
    expect(ACCESS_GRANT_TTL_MS).toBe(30 * 60_000);
    expect(ACCESS_GRANT_MAX_USES).toBe(1);
    const { ac, advance } = setup();
    const login = await ac.login(PASS, 'ip');
    if (!login.ok) throw new Error('login failed');
    const host = ac.check(cookieOf(login.setCookie));
    const gr = ac.grant(host, '123456', 'ip');
    if (!gr.ok) throw new Error('grant failed');
    expect(gr.data).toMatchObject({ room: '123456', uses: 1, path: `/r/123456#g=${gr.data.token}` });
    expect(gr.data.expiresAt).toBe(1_800_000_000_000 + ACCESS_GRANT_TTL_MS);
    expect(gr.data.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(ac.grant(host, '999999', 'ip')).toMatchObject({ ok: false, status: 404, code: 'ROOM_NOT_FOUND' });
    expect(ac.grant(ac.check(undefined), '123456', 'ip')).toMatchObject({ ok: false, status: 401 });

    const rd = await ac.redeem(ac.check(undefined), gr.data.token, '10.0.0.1');
    if (!rd.ok) throw new Error('redeem failed');
    expect(rd.data).toMatchObject({ granted: true, kind: 'g', room: '123456', target: '123456', canGrant: false });
    expect(rd.setCookie).toMatch(/^r4_access=v2\.\d+\.0\.g\.0\.123456-r1\.[^;]+; Path=\/; Max-Age=86400;/);
    // 第二个人用同一个链接：已用完
    expect(await ac.redeem(ac.check(undefined), gr.data.token, '10.0.0.2')).toMatchObject({
      ok: false,
      status: 401,
      details: { reason: 'grantInvalid' },
    });
    const guest = ac.check(cookieOf(rd.setCookie));
    expect(guest).toMatchObject({ granted: true, claims: { kind: 'g', room: { code: '123456', instance: 'r1' } } });
    expect(ac.statusOf(guest)).toMatchObject({ kind: 'g', room: '123456', deadline: null, canGrant: false });
    expect(ac.grant(guest, '123456', 'x')).toMatchObject({
      ok: false,
      status: 403,
      code: 'ACCESS_SCOPE',
      details: { reason: 'grantNotAllowed' },
    });

    // g 会话 24 小时、活跃滑动续期，续期保留房间绑定
    advance(6 * 3_600_000 + 1000);
    const renewed = ac.check(cookieOf(rd.setCookie)).renew;
    expect(renewed).toMatch(/^r4_access=v2\.\d+\.0\.g\.0\.123456-r1\..*Max-Age=86400;/);

    // 过期：30 分钟后未兑换的授权失效
    const gr2 = ac.grant(host, '123456', 'ip');
    if (!gr2.ok) throw new Error('grant failed');
    advance(ACCESS_GRANT_TTL_MS - 1);
    const gr3 = ac.grant(host, '123456', 'ip');
    if (!gr3.ok) throw new Error('grant failed');
    advance(1);
    expect(await ac.redeem(ac.check(undefined), gr2.data.token, 'y')).toMatchObject({ ok: false, status: 401 });
    expect(await ac.redeem(ac.check(undefined), gr3.data.token, 'y')).toMatchObject({ ok: true });
  });

  it('持口令 / 邀请码会话的人打开链接不消耗次数（也不降级为 g）', async () => {
    const { ac } = setup();
    const login = await ac.login(PASS, 'ip');
    if (!login.ok) throw new Error('login failed');
    const host = ac.check(cookieOf(login.setCookie));
    const gr = ac.grant(host, '123456', 'ip');
    if (!gr.ok) throw new Error('grant failed');
    for (let i = 0; i < 3; i++) {
      const rd = await ac.redeem(host, gr.data.token, 'ip');
      expect(rd).toMatchObject({ ok: true, setCookie: null, data: { kind: 'p', room: null, target: '123456' } });
    }
    // 次数还在：第一个没有 cookie 的人照样能用
    expect(await ac.redeem(ac.check(undefined), gr.data.token, 'z')).toMatchObject({ ok: true, data: { kind: 'g' } });
    // 链接已用完：持口令的人打开时 target 为 null（前端留在当前页）
    expect(await ac.redeem(host, gr.data.token, 'ip')).toMatchObject({ ok: true, data: { kind: 'p', target: null } });
  });

  it('持 g 会话：同一房间的链接不消耗；另一个房间的链接正常兑换并换绑；房间关闭或同号新房间时不能兑换', async () => {
    const rooms: Rooms = new Map([
      ['123456', 'r1'],
      ['654321', 'r2'],
    ]);
    const { ac } = setup({}, rooms);
    const login = await ac.login(PASS, 'ip');
    if (!login.ok) throw new Error('login failed');
    const host = ac.check(cookieOf(login.setCookie));
    const link = (room: string) => {
      const r = ac.grant(host, room, 'ip');
      if (!r.ok) throw new Error('grant failed');
      return r.data.token;
    };
    const first = await ac.redeem(ac.check(undefined), link('123456'), 'g1');
    if (!first.ok) throw new Error('redeem failed');
    const guest = ac.check(cookieOf(first.setCookie));

    // 同一房间的另一个链接：不消耗，返回原状态
    const same = link('123456');
    expect(await ac.redeem(guest, same, 'g1')).toMatchObject({
      ok: true,
      setCookie: null,
      data: { kind: 'g', room: '123456', target: '123456' },
    });
    expect(await ac.redeem(ac.check(undefined), same, 'other')).toMatchObject({ ok: true });

    // 另一个房间的链接：消耗一次，换发绑定新房间的 g cookie
    const other = link('654321');
    const moved = await ac.redeem(guest, other, 'g1');
    if (!moved.ok) throw new Error('rebind failed');
    expect(moved.data).toMatchObject({ kind: 'g', room: '654321', target: '654321' });
    expect(ac.check(cookieOf(moved.setCookie)).claims?.room).toEqual({ code: '654321', instance: 'r2' });
    expect(await ac.redeem(ac.check(undefined), other, 'x')).toMatchObject({ ok: false, status: 401 });

    // 授权签发后房间关闭：兑换不消耗、提示房间已关闭；同号的新房间（实例不同）同样不认旧链接
    const closing = link('654321');
    rooms.delete('654321');
    expect(await ac.redeem(ac.check(undefined), closing, 'y')).toMatchObject({
      ok: false,
      status: 404,
      code: 'ROOM_NOT_FOUND',
      details: { reason: 'roomClosed' },
    });
    rooms.set('654321', 'r3');
    expect(await ac.redeem(ac.check(undefined), closing, 'y')).toMatchObject({ ok: false, code: 'ROOM_NOT_FOUND' });
    const fresh = await ac.redeem(ac.check(undefined), link('654321'), 'y');
    expect(fresh.ok && ac.check(cookieOf(fresh.setCookie)).claims?.room).toEqual({ code: '654321', instance: 'r3' });
  });

  it('状态的 roomOpen：g 绑定的房间实例还在为 true，关闭或换成同号新房间为 false；其他会话为 null；g 用口令登录换成 p', async () => {
    const rooms: Rooms = new Map([['123456', 'r1']]);
    const { ac } = setup({}, rooms);
    const login = await ac.login(PASS, 'ip');
    if (!login.ok) throw new Error('login failed');
    expect(login.data).toMatchObject({ kind: 'p', room: null, roomOpen: null });
    const gr = ac.grant(ac.check(cookieOf(login.setCookie)), '123456', 'ip');
    if (!gr.ok) throw new Error('grant failed');
    const rd = await ac.redeem(ac.check(undefined), gr.data.token, 'g');
    if (!rd.ok) throw new Error('redeem failed');
    expect(rd.data).toMatchObject({ kind: 'g', room: '123456', roomOpen: true });
    const guest = cookieOf(rd.setCookie);
    rooms.set('123456', 'r2');
    expect(ac.statusOf(ac.check(guest))).toMatchObject({ granted: true, room: '123456', roomOpen: false });
    rooms.delete('123456');
    expect(ac.statusOf(ac.check(guest))).toMatchObject({ roomOpen: false });
    // 持 g cookie 的人输入口令：照常登录，换发 p（不绑房间）
    const up = await ac.login(PASS, 'g');
    if (!up.ok) throw new Error('login failed');
    expect(up.data).toMatchObject({ kind: 'p', room: null, roomOpen: null, canGrant: true });
  });

  it('邀请码会话的到期上限：cookie 到期 = min(现在 + 有效期, 邀请码到期)，续期不超过它，到点即失效', async () => {
    const { ac, advance, now } = setup({ mode: 'invite', passcodeHash: null });
    // 24 小时口令（外部程序经管理接口签发：uses 3、days 1）
    const inv = ac.createInvite({ uses: 3, days: 1, note: 'ext:1' });
    expect(inv.invite.expiresAt).toBe(now() + DAY);
    const r = await ac.login(inv.code, 'ip');
    if (!r.ok) throw new Error('login failed');
    expect(r.setCookie).toMatch(/Max-Age=86400;/);
    const capS = Math.floor(inv.invite.expiresAt! / 1000);
    expect(r.data).toMatchObject({ kind: 'i', expiresAt: capS * 1000, deadline: capS * 1000, canGrant: true });
    const c0 = cookieOf(r.setCookie);
    // 一直在用也不续期（续期也到不了更晚）
    for (let h = 1; h < 24; h++) {
      advance(3_600_000);
      const g = ac.check(c0);
      expect(g, `hour ${h}`).toMatchObject({ granted: true, renew: null, claims: { cap: capS } });
      expect(ac.statusOf(g)).toMatchObject({ expiresAt: capS * 1000, deadline: capS * 1000 });
    }
    advance(3_600_000);
    expect(ac.check(c0)).toMatchObject({ granted: false, reason: 'expired' });
    // 同一设备凭 cookie 再进（含上面的检查）不消耗次数：只有那一次登录用掉 1 次
    expect(ac.listInvites().find((i) => i.id === inv.invite.id)?.usesLeft).toBe(2);
  });

  it('邀请码到期晚于有效期：照常滑动，但最后一次续期止于邀请码到期', async () => {
    const { ac, advance } = setup({ ttlDays: 1 });
    const inv = ac.createInvite({ uses: 1, days: 2.5 });
    const capS = Math.floor(inv.invite.expiresAt! / 1000);
    const r = await ac.login(inv.code, 'ip');
    if (!r.ok) throw new Error('login failed');
    expect(r.setCookie).toMatch(/Max-Age=86400;/);
    let c = cookieOf(r.setCookie);
    let renewals = 0;
    for (let step = 0; step < 20; step++) {
      advance(3 * 3_600_000);
      const g = ac.check(c);
      if (!g.granted) break;
      if (g.renew) {
        renewals++;
        c = cookieOf(g.renew);
        expect(ac.check(c).claims!.exp).toBeLessThanOrEqual(capS);
      }
    }
    expect(renewals).toBeGreaterThan(2);
    expect(ac.check(c)).toMatchObject({ granted: false, reason: 'expired' });
  });

  it('没有到期时间的邀请码：照常滑动续期，deadline 为 null', async () => {
    const { ac, advance } = setup();
    const inv = ac.createInvite({ uses: 1, days: null });
    const r = await ac.login(inv.code, 'ip');
    if (!r.ok) throw new Error('login failed');
    expect(r.data).toMatchObject({ kind: 'i', deadline: null });
    expect(r.setCookie).toMatch(/Max-Age=2592000;/);
    const c0 = cookieOf(r.setCookie);
    advance(DAY + 1000);
    const renewed = ac.check(c0).renew;
    expect(renewed).toMatch(new RegExp(`^r4_access=v2\\.\\d+\\.0\\.i\\.0\\.${inv.invite.id}\\..*Max-Age=2592000;`));
    advance(29 * DAY);
    expect(ac.check(c0)).toMatchObject({ granted: false, reason: 'expired' });
    expect(ac.check(cookieOf(renewed))).toMatchObject({ granted: true });
  });

  it('停用邀请码：用它登录的会话下一次检查即失效；它生成的授权、经授权进来的 g 会话、别的邀请码不受影响', async () => {
    const { ac, advance } = setup({ mode: 'invite', passcodeHash: null });
    const inv = ac.createInvite({ uses: 2, days: 1 });
    const other = ac.createInvite({ uses: 1, days: 1 });
    const a = await ac.login(inv.code, 'ip');
    const b = await ac.login(inv.code, 'ip2');
    const o = await ac.login(other.code, 'ip3');
    if (!a.ok || !b.ok || !o.ok) throw new Error('login failed');
    // cookie 带邀请码 id
    expect(a.setCookie).toMatch(new RegExp(`^r4_access=v2\\.\\d+\\.0\\.i\\.\\d+\\.${inv.invite.id}\\.`));
    const ca = cookieOf(a.setCookie);
    const host = ac.check(ca);
    expect(host).toMatchObject({ granted: true, claims: { kind: 'i', invite: inv.invite.id } });
    // 停用前用它生成的邀请链接：停用前兑换一个，停用后兑换一个
    const g1 = ac.grant(host, '123456', 'ip');
    const g2 = ac.grant(host, '123456', 'ip');
    if (!g1.ok || !g2.ok) throw new Error('grant failed');
    const guest1 = await ac.redeem(ac.check(undefined), g1.data.token, 'gx');
    if (!guest1.ok) throw new Error('redeem failed');

    expect(ac.revokeInvite(inv.invite.id)).toBe(true);
    // 用它登录的两台设备立即失效（同一进程不等缓存）
    expect(ac.check(ca)).toMatchObject({ granted: false, reason: 'revoked' });
    expect(ac.check(cookieOf(b.setCookie))).toMatchObject({ granted: false, reason: 'revoked' });
    expect(ac.statusOf(ac.check(ca))).toMatchObject({ granted: false, kind: null });
    // 不能再登录
    expect(await ac.login(inv.code, 'ip4')).toMatchObject({ ok: false });
    // 别的邀请码、g 会话、停用前生成的授权不受影响
    expect(ac.check(cookieOf(o.setCookie))).toMatchObject({ granted: true });
    expect(ac.check(cookieOf(guest1.setCookie))).toMatchObject({ granted: true, claims: { kind: 'g' } });
    expect(await ac.redeem(ac.check(undefined), g2.data.token, 'gy')).toMatchObject({ ok: true, data: { kind: 'g' } });
    // 一直被拒，到期后为 expired
    advance(DAY);
    expect(ac.check(ca)).toMatchObject({ granted: false });
  });

  it('另一进程停用邀请码（直接改库）：缓存 1 秒内生效；旧格式（v1）换发来的 i 不带 id，照旧只按到期', async () => {
    const { ac, store, advance, now } = setup();
    const inv = ac.createInvite({ uses: 1, days: 5 });
    const r = await ac.login(inv.code, 'ip');
    if (!r.ok) throw new Error('login failed');
    const c = cookieOf(r.setCookie);
    expect(ac.check(c)).toMatchObject({ granted: true });
    store.revokeInvite(inv.invite.id); // 模拟另一个进程
    expect(ac.check(c)).toMatchObject({ granted: true }); // 撤销集合缓存
    advance(1000);
    expect(ac.check(c)).toMatchObject({ granted: false, reason: 'revoked' });
    // v1 的 i：没有邀请码 id，停用任何邀请码都不影响，续期换发成不带 id 的 v2
    const key = cookieKey(SECRET);
    const body = `v1.${Math.floor(now() / 1000) + 30 * 86_400}.0.i`;
    const old = `r4_access=${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
    expect(ac.check(old)).toMatchObject({ granted: true, claims: { kind: 'i', invite: null } });
    advance(DAY + 1000);
    const renewed = ac.check(old).renew;
    expect(renewed).toMatch(/^r4_access=v2\.\d+\.0\.i\.0\.-\./);
    expect(ac.check(cookieOf(renewed))).toMatchObject({ granted: true, claims: { invite: null } });
  });

  it('旧格式 v1 cookie：p / i 继续有效（续期换发成 v2）；g 视为失效（outdated），需要重新兑换', async () => {
    const { ac, advance, now } = setup();
    const key = cookieKey(SECRET);
    const v1 = (kind: string) => {
      const body = `v1.${Math.floor(now() / 1000) + 30 * 86_400}.0.${kind}`;
      return `r4_access=${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
    };
    expect(ac.check(v1('p'))).toMatchObject({ granted: true, claims: { kind: 'p', cap: 0, room: null } });
    expect(ac.check(v1('i'))).toMatchObject({ granted: true, claims: { kind: 'i', cap: 0 } });
    expect(ac.check(v1('g'))).toMatchObject({ granted: false, reason: 'outdated' });
    const oldP = v1('p');
    advance(DAY + 1000);
    expect(ac.check(oldP).renew).toMatch(/^r4_access=v2\.\d+\.0\.p\.0\.-\./);
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
    expect(await pc.ac.login(inv4.code, 'ip')).toMatchObject({ ok: true, data: { kind: 'i', deadline: null } });
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

  it('SqliteAccessStore.prune 删掉过期或用完的授权、过期的邀请码；用完与撤销而未过期的邀请码保留（撤销状态还要拦会话）', () => {
    const db = new DatabaseSync(':memory:');
    const s = new SqliteAccessStore(db);
    const t = 1000;
    s.createGrant({ room: '111111', instance: 'a', uses: 1, expiresAt: t + 10, epoch: 0, now: t });
    const live = s.createGrant({ room: '222222', instance: 'b', uses: 1, expiresAt: t + 1e9, epoch: 0, now: t });
    s.createInvite({ uses: 1, expiresAt: t + 10, now: t });
    const keep = s.createInvite({ uses: 1, expiresAt: null, now: t });
    const usedUp = s.createInvite({ uses: 1, expiresAt: t + 1e9, now: t });
    expect(s.redeemInvite(usedUp.code, t)).not.toBeNull();
    const revoked = s.createInvite({ uses: 3, expiresAt: null, now: t });
    expect(s.revokeInvite(revoked.invite.id)).toBe(true);
    expect(s.prune(t + 20)).toBe(2);
    expect(s.peekGrant(live, t + 20, 0)).toMatchObject({ room: '222222', instance: 'b' });
    expect(
      s
        .listInvites()
        .map((i) => i.id)
        .sort(),
    ).toEqual([keep.invite.id, usedUp.invite.id, revoked.invite.id].sort());
    expect(s.revokedInviteIds()).toEqual([revoked.invite.id]);
    // 用完的邀请码过期后才删（同时到期的那个授权一起删）
    expect(s.prune(t + 1e9 + 1)).toBe(2);
    expect(
      s
        .listInvites()
        .map((i) => i.id)
        .sort(),
    ).toEqual([keep.invite.id, revoked.invite.id].sort());
    db.close();
  });

  it('旧库迁移：access_grants 补 room_iid 列；迁移前签发（不带房间实例）的授权不能再兑换、prune 时删除', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE access_grants(
      token_hash TEXT PRIMARY KEY, room TEXT NOT NULL, uses_left INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, epoch INTEGER NOT NULL, created_at INTEGER NOT NULL
    ) STRICT, WITHOUT ROWID`);
    const token = 'T'.repeat(43);
    const hash = createHash('sha256').update(token, 'utf8').digest('hex');
    db.prepare('INSERT INTO access_grants VALUES(?, ?, ?, ?, ?, ?)').run(hash, '123456', 8, 1e12, 0, 1);
    const s = new SqliteAccessStore(db);
    const cols = (db.prepare('PRAGMA table_info(access_grants)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('room_iid');
    expect(s.peekGrant(token, 1000, 0)).toBeNull();
    expect(s.redeemGrant(token, 1000, 0)).toBeNull();
    // 再次打开（已迁移）不重复加列
    expect(() => new SqliteAccessStore(db)).not.toThrow();
    expect(s.prune(1000)).toBe(1);
    db.close();
  });

  it('SqliteAccessStore.redeemInvite 返回邀请码的 id 与到期时间（不过期为 null），失败为 null', () => {
    const db = new DatabaseSync(':memory:');
    const s = new SqliteAccessStore(db);
    const a = s.createInvite({ uses: 1, expiresAt: 5000, now: 1000 });
    const b = s.createInvite({ uses: 1, expiresAt: null, now: 1000 });
    expect(a.invite.id).toMatch(/^[0-9a-f]{8}$/);
    expect(s.redeemInvite(a.code, 2000)).toEqual({ id: a.invite.id, expiresAt: 5000 });
    expect(s.redeemInvite(a.code, 2000)).toBeNull();
    expect(s.redeemInvite(b.code, 2000)).toEqual({ id: b.invite.id, expiresAt: null });
    expect(s.redeemInvite('nope', 2000)).toBeNull();
    db.close();
  });
});
