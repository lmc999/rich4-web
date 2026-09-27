/**
 * /pack/* 与访问门禁的集成测试（docs/design/original-skin.md §3 修正 3/4、§5 A4）：
 * 无 cookie 401、有 cookie 200 与正确的头、Range 206、预压缩协商、白名单外 404、未启用素材包返回 404 JSON 而非 index.html、
 * 握手守卫、房间授权的次数与过期、吊销、滑动续期、限流退避、ACCESS_MODE=off 的行为。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { ACCESS_GRANT_MAX_USES, ACCESS_GRANT_TTL_MS } from '@rich4/shared/net';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AccessLimiter } from '../../src/access/limiter';
import { hashPasscode, parsePasscodeHash, SCRYPT_LIMITS } from '../../src/access/passcode';
import { connectBot } from '../helpers/botClient';
import { startTestServer, type TestServer } from '../helpers/startTestServer';
import { type TestPack, writeTestPack } from '../helpers/testPack';

const PASS = 'integration-passcode-42';
const SECRET = 'integration-access-secret-0123456789';
const ADMIN = 'admin-token-for-access-tests';
const root = mkdtempSync(join(tmpdir(), 'rich4-pack-it-'));
const staticDir = join(root, 'static');
let pack: TestPack;
let HASH: ReturnType<typeof parsePasscodeHash> & { ok: true };

beforeAll(async () => {
  mkdirSync(join(root, 'pack'));
  pack = writeTestPack(join(root, 'pack'));
  mkdirSync(staticDir);
  writeFileSync(
    join(staticDir, 'index.html'),
    '<!doctype html><html><head><title>rich4</title></head><body>SPA</body></html>',
  );
  const h = parsePasscodeHash(await hashPasscode(PASS, { N: SCRYPT_LIMITS.minN, r: 8, p: 1 }));
  if (!h.ok) throw new Error(h.reason);
  HASH = h;
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

let srv: TestServer | null = null;
afterEach(async () => {
  await srv?.close();
  srv = null;
});

interface GatedOptions {
  now?: () => number;
  grants?: boolean;
  publicUrl?: string;
  withPack?: boolean;
}

async function gated(o: GatedOptions = {}): Promise<TestServer> {
  const now = o.now;
  srv = await startTestServer({
    ...(o.withPack === false ? {} : { assetsDir: pack.dir }),
    staticDir,
    adminToken: ADMIN,
    ...(o.publicUrl ? { publicUrl: o.publicUrl } : {}),
    access: {
      mode: 'passcode',
      passcodeHash: HASH.value,
      secret: SECRET,
      grants: o.grants ?? true,
      secure: (o.publicUrl ?? '').startsWith('https:'),
    },
    accessOptions: {
      sleep: async () => {},
      ...(now ? { now, limiter: new AccessLimiter({ now }), epochCacheMs: 0 } : { epochCacheMs: 0 }),
    },
  });
  return srv;
}

const json = { 'content-type': 'application/json' };

async function login(s: TestServer, passcode = PASS, ip?: string): Promise<LightMyRequestResponse> {
  return s.app.fastify.inject({
    method: 'POST',
    url: '/api/access',
    headers: json,
    payload: { passcode },
    ...(ip ? { remoteAddress: ip } : {}),
  });
}

/** Set-Cookie → Cookie 请求头 */
function cookieFrom(res: LightMyRequestResponse): string {
  const sc = res.headers['set-cookie'];
  const first = Array.isArray(sc) ? sc[0] : sc;
  if (!first) throw new Error(`no set-cookie (status ${res.statusCode}: ${res.body})`);
  return first.split(';')[0]!;
}

/** 用裸 socket 发 GET（不经 URL 规范化），返回状态码 */
function rawStatus(base: string, path: string, cookie: string): Promise<number> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const sock = connect(Number(port), hostname, () => {
      sock.write(`GET ${path} HTTP/1.1\r\nHost: ${hostname}\r\nCookie: ${cookie}\r\nConnection: close\r\n\r\n`);
    });
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('latin1');
    });
    sock.on('end', () => {
      const m = /^HTTP\/1\.1 (\d{3})/.exec(buf);
      if (m) resolve(Number(m[1]));
      else reject(new Error(`bad response: ${buf.slice(0, 80)}`));
    });
    sock.on('error', reject);
  });
}

function expectPackHeaders(res: LightMyRequestResponse): void {
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
  expect(res.headers['x-robots-tag']).toBe('noindex, nofollow, noarchive');
}

describe('integration/pack-access', () => {
  it('门禁开启：无 cookie 时 /pack 与 /api 401 ACCESS_REQUIRED；健康检查、robots、SPA 外壳公开', async () => {
    const s = await gated();
    const f = s.app.fastify;
    for (const url of [
      '/pack/manifest.json',
      `/pack/${pack.pathOf('audio/sfx/090.opus')}`,
      '/pack/nope',
      '/api/maps',
      '/api/maps/test',
      '/api/nope',
    ]) {
      const res = await f.inject(url);
      expect(res.statusCode, url).toBe(401);
      expect(res.json(), url).toMatchObject({
        ok: false,
        error: { code: 'ACCESS_REQUIRED', details: { reason: 'missing' } },
      });
      expect(res.headers['cache-control']).toBe('no-store');
      if (url.startsWith('/pack')) expectPackHeaders(res);
    }
    expect((await f.inject({ method: 'POST', url: '/api/saves/import', payload: 'x' })).statusCode).toBe(401);
    expect((await f.inject('/healthz')).statusCode).toBe(200);
    expect((await f.inject('/readyz')).statusCode).toBe(200);
    const robots = await f.inject('/robots.txt');
    expect(robots.body).toBe('User-agent: *\nDisallow: /\n');
    for (const url of ['/', '/r/123456', '/lobby']) {
      const res = await f.inject(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.body).toContain('SPA');
    }
    // 伪造、过期签名的 cookie 同样被拒
    const forged = await f.inject({
      url: '/api/maps',
      headers: { cookie: 'r4_access=v1.9999999999.0.p.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
    });
    expect(forged.json()).toMatchObject({ error: { code: 'ACCESS_REQUIRED', details: { reason: 'badSignature' } } });
    // 状态接口公开
    expect((await f.inject('/api/access')).json()).toEqual({
      ok: true,
      data: {
        mode: 'passcode',
        granted: false,
        kind: null,
        expiresAt: null,
        grants: true,
        canGrant: false,
        pack: null,
      },
    });
  });

  it('口令登录：错误口令 401、非 JSON 400；正确后 cookie 属性正确，/api 与 /pack 200', async () => {
    const s = await gated();
    const f = s.app.fastify;
    const wrong = await login(s, 'wrong-passcode');
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ error: { code: 'ACCESS_REQUIRED', details: { reason: 'badPasscode' } } });
    expect(wrong.headers['set-cookie']).toBeUndefined();
    const text = await f.inject({
      method: 'POST',
      url: '/api/access',
      headers: { 'content-type': 'text/plain' },
      payload: PASS,
    });
    expect(text.statusCode).toBe(400);
    expect(
      (await f.inject({ method: 'POST', url: '/api/access', headers: json, payload: { passcode: PASS, x: 1 } }))
        .statusCode,
    ).toBe(400);

    const ok = await login(s);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(String(ok.headers['set-cookie'])).toMatch(
      /^r4_access=v1\.\d+\.0\.p\.[\w-]{43}; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax$/,
    );
    expect(ok.json()).toMatchObject({
      ok: true,
      data: { granted: true, kind: 'p', canGrant: true, pack: pack.manifest.packId },
    });
    const cookie = cookieFrom(ok);
    expect((await f.inject({ url: '/api/maps', headers: { cookie } })).statusCode).toBe(200);
    expect((await f.inject({ url: '/api/access', headers: { cookie } })).json()).toMatchObject({
      data: { granted: true },
    });
    // 登出清除 cookie（同样要求 application/json：跨站 text/plain 表单或空请求体不能强制登出）
    for (const headers of [{ cookie }, { cookie, 'content-type': 'text/plain' }]) {
      const forged = await f.inject({ method: 'POST', url: '/api/access/logout', headers, payload: 'x=1' });
      expect(forged.statusCode).toBe(400);
      expect(forged.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } });
      expect(forged.headers['set-cookie']).toBeUndefined();
    }
    const plainForm = await f.inject({
      method: 'POST',
      url: '/api/access/logout',
      headers: { 'content-type': 'text/plain' },
      payload: 'x=1',
    });
    expect(plainForm.json()).toMatchObject({ error: { details: { reason: 'contentType' } } });
    const empty = await f.inject({ method: 'POST', url: '/api/access/logout' });
    expect(empty.statusCode).toBe(400);
    expect(empty.headers['set-cookie']).toBeUndefined();
    const out = await f.inject({
      method: 'POST',
      url: '/api/access/logout',
      headers: { ...json, cookie },
      payload: {},
    });
    expect(out.statusCode).toBe(200);
    expect(String(out.headers['set-cookie'])).toContain('Max-Age=0');
  });

  it('PUBLIC_URL 为 https 时 cookie 带 Secure', async () => {
    const s = await gated({ publicUrl: 'https://rich4.example.com' });
    expect(String((await login(s)).headers['set-cookie'])).toContain('; Secure');
  });

  it('manifest：private, no-cache、ETag=packId、304、按 Accept-Encoding 返回 br/gzip、安全头', async () => {
    const s = await gated();
    const f = s.app.fastify;
    const cookie = cookieFrom(await login(s));
    const plain = await f.inject({ url: '/pack/manifest.json', headers: { cookie } });
    expect(plain.statusCode).toBe(200);
    expect(plain.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(plain.headers['cache-control']).toBe('private, no-cache');
    expect(plain.headers.etag).toBe(`"${pack.manifest.packId}"`);
    expect(plain.headers.vary).toBe('Accept-Encoding');
    expect(plain.headers['content-encoding']).toBeUndefined();
    expectPackHeaders(plain);
    expect(plain.rawPayload.equals(pack.manifestRaw)).toBe(true);

    const br = await f.inject({
      url: '/pack/manifest.json',
      headers: { cookie, 'accept-encoding': 'gzip, deflate, br' },
    });
    expect(br.headers['content-encoding']).toBe('br');
    expect(brotliDecompressSync(br.rawPayload).equals(pack.manifestRaw)).toBe(true);
    const gz = await f.inject({
      url: '/pack/manifest.json',
      headers: { cookie, 'accept-encoding': 'gzip;q=1, br;q=0' },
    });
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(gz.rawPayload).equals(pack.manifestRaw)).toBe(true);

    const nm = await f.inject({
      url: '/pack/manifest.json',
      headers: { cookie, 'if-none-match': `"${pack.manifest.packId}"` },
    });
    expect(nm.statusCode).toBe(304);
    expect(nm.body).toBe('');
  });

  it('带哈希文件：private, max-age=2592000（不用 immutable）；Range 206 / 416；预压缩协商与 Vary；HEAD', async () => {
    const s = await gated();
    const f = s.app.fastify;
    const cookie = cookieFrom(await login(s));
    const audioPath = pack.pathOf('audio/music/track10.opus');
    const audio = pack.contents.get(audioPath)!;
    const full = await f.inject({ url: `/pack/${audioPath}`, headers: { cookie } });
    expect(full.statusCode).toBe(200);
    expect(full.headers['cache-control']).toBe('private, max-age=2592000');
    expect(full.headers['content-type']).toBe('audio/ogg');
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(full.headers['content-length']).toBe(String(audio.length));
    expect(full.headers.vary).toBeUndefined();
    expect(full.headers['set-cookie']).toBeUndefined(); // 长缓存文件上不续期
    expectPackHeaders(full);
    expect(full.rawPayload.equals(audio)).toBe(true);

    const part = await f.inject({ url: `/pack/${audioPath}`, headers: { cookie, range: 'bytes=100-199' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 100-199/${audio.length}`);
    expect(part.headers['content-length']).toBe('100');
    expect(part.rawPayload.equals(audio.subarray(100, 200))).toBe(true);
    const tail = await f.inject({ url: `/pack/${audioPath}`, headers: { cookie, range: 'bytes=-10' } });
    expect(tail.statusCode).toBe(206);
    expect(tail.rawPayload.equals(audio.subarray(audio.length - 10))).toBe(true);
    const open = await f.inject({ url: `/pack/${audioPath}`, headers: { cookie, range: 'bytes=9990-' } });
    expect(open.headers['content-range']).toBe(`bytes 9990-9999/${audio.length}`);
    const bad = await f.inject({ url: `/pack/${audioPath}`, headers: { cookie, range: 'bytes=20000-' } });
    expect(bad.statusCode).toBe(416);
    expect(bad.headers['content-range']).toBe(`bytes */${audio.length}`);
    const multi = await f.inject({ url: `/pack/${audioPath}`, headers: { cookie, range: 'bytes=0-1,5-6' } });
    expect(multi.statusCode).toBe(200);
    const staleIfRange = await f.inject({
      url: `/pack/${audioPath}`,
      headers: { cookie, range: 'bytes=0-1', 'if-range': '"other"' },
    });
    expect(staleIfRange.statusCode).toBe(200);
    const video = await f.inject({
      url: `/pack/${pack.pathOf('video/start.mp4')}`,
      headers: { cookie, range: 'bytes=0-0' },
    });
    expect(video.statusCode).toBe(206);
    expect(video.headers['content-type']).toBe('video/mp4');

    const nm = await f.inject({
      url: `/pack/${audioPath}`,
      headers: { cookie, 'if-none-match': full.headers.etag as string },
    });
    expect(nm.statusCode).toBe(304);

    const jsonPath = pack.pathOf('data/voice-map.json');
    const jsonBody = pack.contents.get(jsonPath)!;
    const idJson = await f.inject({ url: `/pack/${jsonPath}`, headers: { cookie } });
    expect(idJson.headers.vary).toBe('Accept-Encoding');
    expect(idJson.headers['content-encoding']).toBeUndefined();
    expect(idJson.rawPayload.equals(jsonBody)).toBe(true);
    const brJson = await f.inject({ url: `/pack/${jsonPath}`, headers: { cookie, 'accept-encoding': 'br' } });
    expect(brJson.headers['content-encoding']).toBe('br');
    expect(brJson.headers.vary).toBe('Accept-Encoding');
    expect(brJson.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(brJson.headers.etag).not.toBe(idJson.headers.etag);
    expect(brotliDecompressSync(brJson.rawPayload).equals(jsonBody)).toBe(true);
    const flc = pack.pathOf('flic/data/482.flc');
    const gzFlc = await f.inject({ url: `/pack/${flc}`, headers: { cookie, 'accept-encoding': 'gzip' } });
    expect(gzFlc.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(gzFlc.rawPayload).equals(pack.contents.get(flc)!)).toBe(true);
    // Range 请求一律按原始字节
    const rangedJson = await f.inject({
      url: `/pack/${jsonPath}`,
      headers: { cookie, 'accept-encoding': 'br', range: 'bytes=0-9' },
    });
    expect(rangedJson.statusCode).toBe(206);
    expect(rangedJson.headers['content-encoding']).toBeUndefined();

    const head = await f.inject({ method: 'HEAD', url: `/pack/${audioPath}`, headers: { cookie } });
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-length']).toBe(String(audio.length));
    expect(head.body).toBe('');
  });

  it('白名单之外一律 404 JSON（逻辑路径、杂散文件、穿越、/pack 本身），不回退 SPA', async () => {
    const s = await gated();
    const f = s.app.fastify;
    const cookie = cookieFrom(await login(s));
    const file = pack.pathOf('audio/sfx/090.opus');
    for (const url of ['/pack/audio/sfx/090.opus', '/pack/.rich4-extract.json', '/pack/', '/pack']) {
      const res = await f.inject({ url, headers: { cookie } });
      expect(res.statusCode, url).toBe(404);
      expect(res.headers['content-type'], url).toMatch(/^application\/json/);
      expect(res.json(), url).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
      expectPackHeaders(res);
    }
    expect((await f.inject({ method: 'POST', url: `/pack/${file}`, headers: { cookie } })).statusCode).toBe(404);
    // 原始请求行里的 ..（HTTP 客户端通常会先规范化，这里用裸 socket 直接发）
    const base = file.split('/').pop()!;
    for (const raw of [
      `/pack/../pack/${file}`,
      `/pack/audio/../audio/sfx/${base}`,
      `/pack/audio/%2e%2e/audio/sfx/${base}`,
      '/pack/%2e%2e/%2e%2e/etc/passwd',
      '/pack/..%2f..%2fpackage.json',
      '/pack//etc/passwd',
    ]) {
      expect(await rawStatus(s.url, raw, cookie), raw).toBe(404);
    }
    expect(await rawStatus(s.url, `/pack/${file}`, cookie)).toBe(200);
  });

  it('未启用素材包：/pack/manifest.json 返回 404 JSON 而不是 index.html（门禁 off 与开启两种情况）', async () => {
    srv = await startTestServer({ staticDir });
    const off = await srv.app.fastify.inject('/pack/manifest.json');
    expect(off.statusCode).toBe(404);
    expect(off.headers['content-type']).toMatch(/^application\/json/);
    expect(off.json()).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'BAD_REQUEST', details: { reason: 'packDisabled' } }),
    });
    expect(off.body).not.toContain('SPA');
    expectPackHeaders(off);
    expect((await srv.app.fastify.inject('/somewhere')).body).toContain('SPA');
    // 门禁 off 时 /api 公开，状态接口 granted=true，授权接口关闭
    expect((await srv.app.fastify.inject('/api/maps')).statusCode).toBe(200);
    expect((await srv.app.fastify.inject('/api/access')).json()).toMatchObject({
      data: { mode: 'off', granted: true, grants: false, canGrant: false, pack: null },
    });
    const grant = await srv.app.fastify.inject({
      method: 'POST',
      url: '/api/access/grant',
      headers: json,
      payload: { room: '123456' },
    });
    expect(grant.statusCode).toBe(404);
    expect(grant.json()).toMatchObject({ error: { details: { reason: 'grantsDisabled' } } });
    await srv.close();

    const s = await gated({ withPack: false });
    const cookie = cookieFrom(await login(s));
    // 状态接口告诉已通过门禁的前端没有素材包（pack: null），前端就不必去请求 manifest
    expect((await s.app.fastify.inject({ url: '/api/access', headers: { cookie } })).json()).toMatchObject({
      data: { granted: true, pack: null },
    });
    const res = await s.app.fastify.inject({ url: '/pack/manifest.json', headers: { cookie } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { details: { reason: 'packDisabled' } } });
  });

  it('握手守卫：无 cookie 或 cookie 失效时 ACCESS_REQUIRED；有效 cookie 正常连接', async () => {
    const s = await gated();
    await expect(connectBot(s.url)).rejects.toMatchObject({
      data: { code: 'ACCESS_REQUIRED', details: { reason: 'missing' } },
    });
    await expect(connectBot(s.url, { transports: ['polling'] })).rejects.toMatchObject({
      data: { code: 'ACCESS_REQUIRED' },
    });
    const cookie = cookieFrom(await login(s));
    const bot = await connectBot(s.url, { extraHeaders: { cookie } });
    expect(bot.socket.connected).toBe(true);
    bot.socket.disconnect();
    const polling = await connectBot(s.url, { extraHeaders: { cookie }, transports: ['polling'] });
    expect(polling.socket.connected).toBe(true);
    polling.socket.disconnect();
    // 吊销后旧 cookie 握手被拒
    await s.app.fastify.inject({
      method: 'POST',
      url: '/admin/access/revoke',
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    await expect(connectBot(s.url, { extraHeaders: { cookie } })).rejects.toMatchObject({
      data: { code: 'ACCESS_REQUIRED', details: { reason: 'revoked' } },
    });
  });

  it('门禁 off 时握手不看 cookie（现有客户端与 E2E 不受影响）', async () => {
    srv = await startTestServer();
    const bot = await connectBot(srv.url);
    expect(bot.socket.connected).toBe(true);
    bot.socket.disconnect();
  });

  it('房间邀请授权：需要门禁 cookie；链接放在 URL 片段；兑换 8 次后失效；受邀者不能再生成授权', async () => {
    const s = await gated();
    const f = s.app.fastify;
    const host = await connectBot(s.url, { extraHeaders: { cookie: cookieFrom(await login(s)) } });
    const created = await host.req('room:create', {});
    if (!created.ok) throw new Error('room:create failed');
    const code = created.data.code;
    const hostCookie = cookieFrom(await login(s));

    const noCookie = await f.inject({
      method: 'POST',
      url: '/api/access/grant',
      headers: json,
      payload: { room: code },
    });
    expect(noCookie.statusCode).toBe(401);
    const missingRoom = await f.inject({
      method: 'POST',
      url: '/api/access/grant',
      headers: { ...json, cookie: hostCookie },
      payload: { room: '999999' },
    });
    expect(missingRoom.statusCode).toBe(404);
    expect(missingRoom.json()).toMatchObject({ error: { code: 'ROOM_NOT_FOUND' } });
    const g = await f.inject({
      method: 'POST',
      url: '/api/access/grant',
      headers: { ...json, cookie: hostCookie },
      payload: { room: code },
    });
    expect(g.statusCode).toBe(200);
    const grant = g.json().data as { token: string; path: string; uses: number; expiresAt: number; room: string };
    expect(grant).toMatchObject({ room: code, uses: ACCESS_GRANT_MAX_USES, path: `/r/${code}#g=${grant.token}` });

    const redeem = (cookie?: string) =>
      f.inject({
        method: 'POST',
        url: '/api/access/redeem',
        headers: { ...json, ...(cookie ? { cookie } : {}) },
        payload: { token: grant.token },
      });
    const guests: string[] = [];
    for (let i = 0; i < ACCESS_GRANT_MAX_USES; i++) {
      const r = await redeem();
      expect(r.statusCode, `use ${i + 1}`).toBe(200);
      expect(r.json()).toMatchObject({ data: { kind: 'g', room: code, granted: true, canGrant: false } });
      expect(String(r.headers['set-cookie'])).toContain('Max-Age=86400');
      guests.push(cookieFrom(r));
    }
    const ninth = await redeem();
    expect(ninth.statusCode).toBe(401);
    expect(ninth.json()).toMatchObject({ error: { code: 'ACCESS_REQUIRED', details: { reason: 'grantInvalid' } } });

    const guest = guests[0]!;
    expect((await f.inject({ url: '/pack/manifest.json', headers: { cookie: guest } })).statusCode).toBe(200);
    const bot = await connectBot(s.url, { extraHeaders: { cookie: guest } });
    const joined = await bot.req('room:join', { code, role: 'player' });
    expect(joined.ok).toBe(true);
    bot.socket.disconnect();
    host.socket.disconnect();
    const regrant = await f.inject({
      method: 'POST',
      url: '/api/access/grant',
      headers: { ...json, cookie: guest },
      payload: { room: code },
    });
    expect(regrant.statusCode).toBe(403);
    expect(regrant.json()).toMatchObject({
      error: { code: 'ACCESS_REQUIRED', details: { reason: 'grantNotAllowed' } },
    });
    const badToken = await f.inject({
      method: 'POST',
      url: '/api/access/redeem',
      headers: json,
      payload: { token: 'short' },
    });
    expect(badToken.statusCode).toBe(400);
  });

  it('授权 24 小时过期；滑动续期；吊销让 cookie 与授权一起失效', async () => {
    let t = Date.now();
    const s = await gated({ now: () => t });
    const f = s.app.fastify;
    const hostCookie = cookieFrom(await login(s));
    // 房间存在性检查需要一个真实房间：用机器人建
    const host = await connectBot(s.url, { extraHeaders: { cookie: hostCookie } });
    const created = await host.req('room:create', {});
    if (!created.ok) throw new Error('room:create failed');
    const code = created.data.code;
    const mk = async () =>
      (
        await f.inject({
          method: 'POST',
          url: '/api/access/grant',
          headers: { ...json, cookie: hostCookie },
          payload: { room: code },
        })
      ).json().data as { token: string };
    const g1 = await mk();
    t += ACCESS_GRANT_TTL_MS;
    const late = await f.inject({
      method: 'POST',
      url: '/api/access/redeem',
      headers: json,
      payload: { token: g1.token },
    });
    expect(late.statusCode).toBe(401);

    // 滑动续期：签发 1 天后的 /api 请求带新 Set-Cookie，manifest 也会续期
    const c0 = cookieFrom(await login(s));
    expect((await f.inject({ url: '/api/maps', headers: { cookie: c0 } })).headers['set-cookie']).toBeUndefined();
    t += 86_400_000 + 1000;
    const renewed = await f.inject({ url: '/api/maps', headers: { cookie: c0 } });
    expect(renewed.statusCode).toBe(200);
    expect(String(renewed.headers['set-cookie'])).toMatch(/^r4_access=v1\..*Max-Age=2592000/);
    expect(
      String((await f.inject({ url: '/pack/manifest.json', headers: { cookie: c0 } })).headers['set-cookie']),
    ).toContain('r4_access=');
    const status = await f.inject({ url: '/api/access', headers: { cookie: c0 } });
    expect(status.headers['set-cookie']).toBeDefined();
    // Socket.IO 握手响应（engine.io 的第一个 HTTP 响应）同样续期
    const hs = await fetch(`${s.url}/socket.io/?EIO=4&transport=polling`, { headers: { cookie: c0 } });
    expect(hs.status).toBe(200);
    expect(hs.headers.get('set-cookie')).toMatch(/^r4_access=v1\./);
    await hs.text();

    // 吊销：ADMIN_TOKEN 接口 epoch+1
    const g2 = await mk();
    expect((await f.inject({ method: 'POST', url: '/admin/access/revoke' })).statusCode).toBe(401);
    const rv = await f.inject({
      method: 'POST',
      url: '/admin/access/revoke',
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(rv.json()).toEqual({ ok: true, data: { epoch: 1 } });
    const after = await f.inject({ url: '/api/maps', headers: { cookie: c0 } });
    expect(after.statusCode).toBe(401);
    expect(after.json()).toMatchObject({ error: { details: { reason: 'revoked' } } });
    // 失效的 cookie 在状态接口上被清掉
    expect(String((await f.inject({ url: '/api/access', headers: { cookie: c0 } })).headers['set-cookie'])).toContain(
      'Max-Age=0',
    );
    expect(
      (await f.inject({ method: 'POST', url: '/api/access/redeem', headers: json, payload: { token: g2.token } }))
        .statusCode,
    ).toBe(401);
    // 新登录的 cookie 带新 epoch
    expect(cookieFrom(await login(s))).toMatch(/^r4_access=v1\.\d+\.1\.p\./);
    host.socket.disconnect();
  });

  it('限流：连续失败后退避 429 + Retry-After（不做硬锁），窗口过后正确口令可以进入；按 IP 区分', async () => {
    let t = Date.now();
    const s = await gated({ now: () => t });
    for (let i = 0; i < 5; i++) expect((await login(s, 'bad', '203.0.113.9')).statusCode).toBe(401);
    expect((await login(s, 'bad', '203.0.113.9')).statusCode).toBe(401);
    const limited = await login(s, PASS, '203.0.113.9');
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('1');
    expect(limited.json()).toMatchObject({ error: { code: 'RATE_LIMITED', details: { scope: 'ip' } } });
    // 另一个 IP 不受影响
    expect((await login(s, PASS, '198.51.100.7')).statusCode).toBe(200);
    t += 1000;
    expect((await login(s, PASS, '203.0.113.9')).statusCode).toBe(200);
  });

  it('邀请码：ADMIN_TOKEN 生成、列表、撤销；口令模式下也能用邀请码进入', async () => {
    const s = await gated();
    const f = s.app.fastify;
    const auth = { authorization: `Bearer ${ADMIN}` };
    const created = await f.inject({
      method: 'POST',
      url: '/admin/access/invites',
      headers: { ...auth, ...json },
      payload: { uses: 1, days: 1, note: 'bob' },
    });
    expect(created.statusCode).toBe(200);
    const { code, invite } = created.json().data as { code: string; invite: { id: string } };
    const list = await f.inject({ url: '/admin/access/invites', headers: auth });
    expect(list.json()).toMatchObject({ data: { epoch: 0, invites: [{ id: invite.id, usesLeft: 1, note: 'bob' }] } });
    const r = await login(s, code);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ data: { kind: 'i' } });
    expect((await login(s, code)).statusCode).toBe(401);
    const second = (
      await f.inject({ method: 'POST', url: '/admin/access/invites', headers: { ...auth, ...json }, payload: {} })
    ).json().data as { code: string; invite: { id: string } };
    expect(
      (await f.inject({ method: 'DELETE', url: `/admin/access/invites/${second.invite.id}`, headers: auth }))
        .statusCode,
    ).toBe(200);
    expect((await login(s, second.code)).statusCode).toBe(401);
  });

  it('门禁开启时受保护响应不许共享缓存：/api/maps/:id?h= 改为 private、30 天、无 immutable，且不带续期 cookie', async () => {
    let t = Date.now();
    const s = await gated({ now: () => t });
    const f = s.app.fastify;
    const cookie = cookieFrom(await login(s));
    const list = await f.inject({ url: '/api/maps', headers: { cookie } });
    expect(list.headers['cache-control']).toBe('private, no-cache');
    const mapId = (list.json() as { maps: { id: string }[] }).maps[0]!.id;
    const plain = await f.inject({ url: `/api/maps/${mapId}`, headers: { cookie } });
    expect(plain.headers['cache-control']).toBe('private, no-cache');
    const hash = String(plain.headers.etag).replaceAll('"', '');
    // 签发超过 1 天：需要续期
    t += 86_400_000 + 1000;
    const pinned = await f.inject({ url: `/api/maps/${mapId}?h=${hash}`, headers: { cookie } });
    expect(pinned.statusCode).toBe(200);
    expect(pinned.headers['cache-control']).toBe('private, max-age=2592000');
    expect(pinned.headers['set-cookie']).toBeUndefined();
    // 不可缓存的 /api 响应（列表、manifest）照常续期
    const renewed = await f.inject({ url: '/api/maps', headers: { cookie } });
    expect(renewed.headers['cache-control']).toBe('private, no-cache');
    expect(String(renewed.headers['set-cookie'])).toMatch(/^r4_access=v1\./);
    const manifest = await f.inject({ url: '/pack/manifest.json', headers: { cookie } });
    expect(String(manifest.headers['set-cookie'])).toMatch(/^r4_access=v1\./);
    // 门禁关闭时（没有素材包的普通部署）地图保持 1 年 immutable
    await srv?.close();
    srv = await startTestServer();
    const open = await srv.app.fastify.inject(`/api/maps/${mapId}?h=${hash}`);
    expect(open.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await srv.app.fastify.inject('/api/maps')).headers['cache-control']).toBe('no-cache');
  });

  it('管理接口：错误的 Bearer 连续失败后按 IP 退避 429（/admin/stats 与 /admin/access/* 共用），不同 IP 互不影响', async () => {
    let t = Date.now();
    const s = await gated({ now: () => t });
    const f = s.app.fastify;
    const attacker = '203.0.113.200';
    const statuses: number[] = [];
    for (let i = 0; i < 60; i++) {
      const url = i % 2 === 0 ? '/admin/access/invites' : '/admin/stats';
      const res = await f.inject({
        method: i % 2 === 0 ? 'POST' : 'GET',
        url,
        headers: { authorization: `Bearer guess-${i}`, ...json },
        payload: i % 2 === 0 ? { uses: 1000, days: 3650 } : undefined,
        remoteAddress: attacker,
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.filter((c) => c === 401)).toHaveLength(6);
    expect(statuses.filter((c) => c === 429)).toHaveLength(54);
    const limited = await f.inject({
      url: '/admin/access/invites',
      headers: { authorization: `Bearer ${ADMIN}` },
      remoteAddress: attacker,
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: { code: 'RATE_LIMITED', details: { reason: 'rateLimited' } } });
    expect(limited.headers['retry-after']).toBe('1');
    // 管理员从别的 IP 照常操作
    const ok = await f.inject({
      url: '/admin/access/invites',
      headers: { authorization: `Bearer ${ADMIN}` },
      remoteAddress: '198.51.100.10',
    });
    expect(ok.statusCode).toBe(200);
    // 退避过后正确的 token 可用
    t += 1000;
    expect(
      (
        await f.inject({
          url: '/admin/stats',
          headers: { authorization: `Bearer ${ADMIN}` },
          remoteAddress: attacker,
        })
      ).statusCode,
    ).toBe(200);
  });

  it('百分号编码的 /pack 路径（/%70ack/…）命中 /pack/* 时同样带安全头；没有 cookie 仍 401', async () => {
    const s = await gated();
    const f = s.app.fastify;
    const cookie = cookieFrom(await login(s));
    const file = pack.pathOf('audio/sfx/090.opus');
    const encoded = await f.inject({ url: `/%70ack/${file}`, headers: { cookie } });
    expect(encoded.statusCode).toBe(200);
    expectPackHeaders(encoded);
    expect(encoded.headers['set-cookie']).toBeUndefined();
    const missing = await f.inject({ url: '/%70ack/nope', headers: { cookie } });
    expect(missing.statusCode).toBe(404);
    expectPackHeaders(missing);
    const denied = await f.inject(`/%70ack/${file}`);
    expect(denied.statusCode).toBe(401);
    expectPackHeaders(denied);
  });

  it('握手被门禁拒绝后立即关闭底层 engine.io 连接（不保持会话到 connectTimeout）', async () => {
    const s = await gated();
    const base = `${s.url}/socket.io/?EIO=4&transport=polling`;
    const open = await fetch(base);
    const body = await open.text();
    expect(body.startsWith('0')).toBe(true);
    const sid = (JSON.parse(body.slice(1)) as { sid: string }).sid;
    const url = `${base}&sid=${sid}`;
    const post = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      body: '40{"token":"abcdefghijklmnopqrstuv","nickname":"x","protocolVersion":1}',
    });
    expect(post.status).toBe(200);
    await post.text();
    const err = await (await fetch(url)).text();
    expect(err).toContain('44{');
    expect(err).toContain('ACCESS_REQUIRED');
    // 之后的轮询立即得到 close 包（或 400 Session ID unknown）；修复前这里会挂起到下一个 ping（10 秒）
    await new Promise((r) => setTimeout(r, 100));
    const after = await fetch(url, { signal: AbortSignal.timeout(3000) });
    const packets = (await after.text()).split('\x1e');
    expect(after.status === 400 || packets.includes('1')).toBe(true);
    expect(packets).not.toContain('2');
    expect(s.app.io.engine.clientsCount).toBe(0);
  });

  it('纵深防御：素材包已启用而门禁关闭（不是 loadConfig 判定的本机例外）时 createApp 拒绝启动', async () => {
    await expect(startTestServer({ assetsDir: pack.dir })).rejects.toThrow(/拒绝启动/);
    srv = await startTestServer({ assetsDir: pack.dir, ungated: true });
    expect((await srv.app.fastify.inject('/pack/manifest.json')).statusCode).toBe(200);
  });

  it('ACCESS_GRANTS=0：授权接口关闭，状态里 grants=false', async () => {
    const s = await gated({ grants: false });
    const cookie = cookieFrom(await login(s));
    expect((await s.app.fastify.inject({ url: '/api/access', headers: { cookie } })).json()).toMatchObject({
      data: { granted: true, grants: false, canGrant: false },
    });
    const g = await s.app.fastify.inject({
      method: 'POST',
      url: '/api/access/grant',
      headers: { ...json, cookie },
      payload: { room: '123456' },
    });
    expect(g.statusCode).toBe(404);
  });

  it('JSON 存储时门禁使用 DATA_DIR/access.db', async () => {
    const dataDir = join(root, 'json-store');
    srv = await startTestServer({
      dataDir,
      store: 'json',
      access: { mode: 'passcode', passcodeHash: HASH.value, secret: SECRET },
      accessOptions: { sleep: async () => {} },
    });
    expect((await login(srv)).statusCode).toBe(200);
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(dataDir, 'access.db'))).toBe(true);
  });
});
