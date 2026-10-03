// 访问门禁的密码学部分：cookie 签名与校验（v2 与 v1 兼容）、Cookie 头解析、scrypt 口令哈希
import { createHmac } from 'node:crypto';
import { ACCESS_COOKIE } from '@rich4/shared/net';
import { describe, expect, it } from 'vitest';
import {
  clearAccessCookie,
  cookieKey,
  readCookie,
  serializeAccessCookie,
  signAccessCookie,
  verifyAccessCookie,
} from '../../src/access/cookie';
import {
  belowRecommendedScrypt,
  DEFAULT_SCRYPT,
  hashPasscode,
  parsePasscodeHash,
  SCRYPT_LIMITS,
  verifyPasscode,
} from '../../src/access/passcode';

const KEY = cookieKey('x'.repeat(40));
const NOW = 1_800_000_000_000;

describe('access cookie', () => {
  const exp = NOW / 1000 + 3600;
  const ROOM = { code: '482913', instance: 'lq2x3k9a' };

  /** 用同一个密钥签一个旧格式 v1 cookie（迁移兼容测试用） */
  const signV1 = (e: number, epoch: number, kind: string, key = KEY): string => {
    const body = `v1.${e}.${epoch}.${kind}`;
    return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
  };

  it('格式为 v2.<exp>.<epoch>.<kind>.<cap>.<room>.<HMAC>，签名可验证；g 带房间实例，p / i 为 -', () => {
    const v = signAccessCookie({ exp, epoch: 3, kind: 'p', cap: 0, room: null, invite: null }, KEY);
    expect(v).toMatch(/^v2\.\d+\.3\.p\.0\.-\.[A-Za-z0-9_-]{43}$/);
    expect(verifyAccessCookie(v, KEY, NOW, 3)).toEqual({
      ok: true,
      claims: { exp, epoch: 3, kind: 'p', cap: 0, room: null, invite: null },
    });
    const g = signAccessCookie({ exp, epoch: 0, kind: 'g', cap: 0, room: ROOM, invite: null }, KEY);
    expect(g).toMatch(/^v2\.\d+\.0\.g\.0\.482913-lq2x3k9a\.[A-Za-z0-9_-]{43}$/);
    expect(verifyAccessCookie(g, KEY, NOW, 0)).toEqual({
      ok: true,
      claims: { exp, epoch: 0, kind: 'g', cap: 0, room: ROOM, invite: null },
    });
    const i = signAccessCookie({ exp, epoch: 0, kind: 'i', cap: exp + 60, room: null, invite: null }, KEY);
    expect(verifyAccessCookie(i, KEY, NOW, 0)).toMatchObject({ ok: true, claims: { kind: 'i', cap: exp + 60 } });
    // g 必须绑定房间、p / i 不能绑定
    expect(() => signAccessCookie({ exp, epoch: 0, kind: 'g', cap: 0, room: null, invite: null }, KEY)).toThrow();
    expect(() => signAccessCookie({ exp, epoch: 0, kind: 'p', cap: 0, room: ROOM, invite: null }, KEY)).toThrow();
  });

  it('kind i 的 ref 是邀请码 id（8 位十六进制，停用即失效）；不带 id 时为 -；别的 kind 不能带邀请码 id', () => {
    const v = signAccessCookie({ exp, epoch: 0, kind: 'i', cap: exp, room: null, invite: '0a1b2c3d' }, KEY);
    expect(v).toMatch(/^v2\.\d+\.0\.i\.\d+\.0a1b2c3d\.[A-Za-z0-9_-]{43}$/);
    expect(verifyAccessCookie(v, KEY, NOW, 0)).toEqual({
      ok: true,
      claims: { exp, epoch: 0, kind: 'i', cap: exp, room: null, invite: '0a1b2c3d' },
    });
    const noId = signAccessCookie({ exp, epoch: 0, kind: 'i', cap: 0, room: null, invite: null }, KEY);
    expect(noId).toMatch(/\.i\.0\.-\./);
    expect(verifyAccessCookie(noId, KEY, NOW, 0)).toMatchObject({ ok: true, claims: { invite: null } });
    // 篡改邀请码 id：签名错误；把 i 改成 p（p 不能带 id）：格式错误
    expect(verifyAccessCookie(v.replace('0a1b2c3d', '0a1b2c3e'), KEY, NOW, 0)).toEqual({
      ok: false,
      reason: 'badSignature',
    });
    expect(verifyAccessCookie(v.replace('.i.', '.p.'), KEY, NOW, 0)).toEqual({ ok: false, reason: 'malformed' });
    expect(() => signAccessCookie({ exp, epoch: 0, kind: 'p', cap: 0, room: null, invite: '0a1b2c3d' }, KEY)).toThrow();
    expect(() => signAccessCookie({ exp, epoch: 0, kind: 'g', cap: 0, room: ROOM, invite: '0a1b2c3d' }, KEY)).toThrow();
    expect(() => signAccessCookie({ exp, epoch: 0, kind: 'i', cap: 0, room: null, invite: 'XYZ' }, KEY)).toThrow();
  });

  it('篡改任一字段（含 cap 与房间）、换密钥都判为签名错误', () => {
    const v = signAccessCookie({ exp, epoch: 0, kind: 'g', cap: 0, room: ROOM, invite: null }, KEY);
    const parts = v.split('.');
    const tampered = [
      [parts[0], String(exp + 1), ...parts.slice(2)].join('.'),
      [...parts.slice(0, 2), '1', ...parts.slice(3)].join('.'),
      [...parts.slice(0, 4), '99', ...parts.slice(5)].join('.'),
      [...parts.slice(0, 5), '482914-lq2x3k9a', parts[6]].join('.'),
      [...parts.slice(0, 5), '482913-lq2x3k9b', parts[6]].join('.'),
    ];
    for (const t of tampered) expect(verifyAccessCookie(t, KEY, NOW, 0)).toEqual({ ok: false, reason: 'badSignature' });
    // 把 g 改成 p（房间字段对不上）是格式错误
    expect(verifyAccessCookie([...parts.slice(0, 3), 'p', ...parts.slice(4)].join('.'), KEY, NOW, 0)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(verifyAccessCookie(v, cookieKey('y'.repeat(40)), NOW, 0)).toEqual({ ok: false, reason: 'badSignature' });
  });

  it('过期、epoch 变化、格式错误、缺失', () => {
    const v = signAccessCookie({ exp, epoch: 1, kind: 'i', cap: 0, room: null, invite: null }, KEY);
    expect(verifyAccessCookie(v, KEY, exp * 1000, 1)).toEqual({ ok: false, reason: 'expired' });
    expect(verifyAccessCookie(v, KEY, NOW, 2)).toEqual({ ok: false, reason: 'revoked' });
    expect(verifyAccessCookie('v1.x.y', KEY, NOW, 1)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyAccessCookie(v.replace('.i.', '.z.'), KEY, NOW, 1)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyAccessCookie('v3.1.2.p.0.-.' + 'A'.repeat(43), KEY, NOW, 1)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(verifyAccessCookie(null, KEY, NOW, 1)).toEqual({ ok: false, reason: 'missing' });
  });

  it('旧格式 v1：p / i 继续有效（cap 0、不绑房间）；g 判为 outdated；v1 同样验签、查过期与 epoch', () => {
    expect(verifyAccessCookie(signV1(exp, 2, 'p'), KEY, NOW, 2)).toEqual({
      ok: true,
      claims: { exp, epoch: 2, kind: 'p', cap: 0, room: null, invite: null },
    });
    expect(verifyAccessCookie(signV1(exp, 2, 'i'), KEY, NOW, 2)).toMatchObject({ ok: true, claims: { kind: 'i' } });
    expect(verifyAccessCookie(signV1(exp, 2, 'g'), KEY, NOW, 2)).toEqual({ ok: false, reason: 'outdated' });
    expect(verifyAccessCookie(signV1(exp, 2, 'p', cookieKey('z'.repeat(40))), KEY, NOW, 2)).toEqual({
      ok: false,
      reason: 'badSignature',
    });
    expect(verifyAccessCookie(signV1(exp, 2, 'p'), KEY, exp * 1000, 2)).toEqual({ ok: false, reason: 'expired' });
    expect(verifyAccessCookie(signV1(exp, 2, 'p'), KEY, NOW, 3)).toEqual({ ok: false, reason: 'revoked' });
    // v1 的签名正文不能套到 v2 上（版本前缀参与签名）
    const v1 = signV1(exp, 0, 'p');
    const sig = v1.split('.').pop();
    expect(verifyAccessCookie(`v2.${exp}.0.p.0.-.${sig}`, KEY, NOW, 0)).toEqual({ ok: false, reason: 'badSignature' });
  });

  it('readCookie 从多个 cookie 中取出 r4_access（优先格式正确的一个，v1 / v2 都认）', () => {
    const v = signAccessCookie({ exp, epoch: 0, kind: 'p', cap: 0, room: null, invite: null }, KEY);
    expect(readCookie(`a=1; ${ACCESS_COOKIE}=${v}; b=2`)).toBe(v);
    expect(readCookie(`${ACCESS_COOKIE}=junk; ${ACCESS_COOKIE}=${v}`)).toBe(v);
    expect(readCookie(`${ACCESS_COOKIE}="${v}"`)).toBe(v);
    const old = signV1(exp, 0, 'i');
    expect(readCookie(`${ACCESS_COOKIE}=junk; ${ACCESS_COOKIE}=${old}`)).toBe(old);
    expect(readCookie(`${ACCESS_COOKIE}=junk`)).toBe('junk');
    expect(readCookie('other=1')).toBeNull();
    expect(readCookie(undefined)).toBeNull();
  });

  it('Set-Cookie：HttpOnly、SameSite=Lax、Path=/，https 时 Secure；清除用 Max-Age=0', () => {
    const plain = serializeAccessCookie('v', { maxAgeSec: 86400, secure: false });
    expect(plain).toBe(`${ACCESS_COOKIE}=v; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax`);
    expect(serializeAccessCookie('v', { maxAgeSec: 1, secure: true })).toContain('; Secure');
    expect(clearAccessCookie(false)).toBe(`${ACCESS_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
  });
});

describe('access passcode (scrypt)', () => {
  const params = { N: SCRYPT_LIMITS.minN, r: 8, p: 1 };

  it('哈希格式不含 $（compose 会插值），往返验证；错误口令、空口令为 false', async () => {
    const h = await hashPasscode('大富翁 correct horse', params);
    expect(h).toMatch(/^scrypt:16384:8:1:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]{43}$/);
    const parsed = parsePasscodeHash(h);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(await verifyPasscode('大富翁 correct horse', parsed.value)).toBe(true);
    expect(await verifyPasscode('大富翁 correct hors', parsed.value)).toBe(false);
    expect(await verifyPasscode('', parsed.value)).toBe(false);
    // 同一口令两次哈希的盐不同
    expect(await hashPasscode('大富翁 correct horse', params)).not.toBe(h);
  });

  it('口令按 NFC 规范化后比较', async () => {
    const parsed = parsePasscodeHash(await hashPasscode('café-passcode', params));
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(await verifyPasscode('café-passcode', parsed.value)).toBe(true);
  });

  it('解析：兼容 $ 分隔；拒绝过弱参数、非 2 的幂、错误格式', async () => {
    const h = await hashPasscode('passcode-1234', params);
    expect(parsePasscodeHash(`$${h.replaceAll(':', '$')}`).ok).toBe(true);
    expect(parsePasscodeHash(h.replace(':16384:', ':1024:'))).toMatchObject({ ok: false });
    expect(parsePasscodeHash(h.replace(':16384:', ':20000:'))).toMatchObject({ ok: false });
    expect(parsePasscodeHash('plaintext-passcode')).toMatchObject({ ok: false });
    expect(parsePasscodeHash(h.replace(/:[^:]+$/, ':!!'))).toMatchObject({ ok: false });
    await expect(hashPasscode('', params)).rejects.toThrow();
    await expect(hashPasscode('x', { N: 1000, r: 8, p: 1 })).rejects.toThrow();
  });

  it('默认参数是 OWASP 建议表里的一档（2^15/8/3），每次验证内存约 32 MiB；低于建议表最低计算量的判为偏弱', () => {
    expect(DEFAULT_SCRYPT).toEqual({ N: 1 << 15, r: 8, p: 3 });
    expect(128 * DEFAULT_SCRYPT.N * DEFAULT_SCRYPT.r).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(belowRecommendedScrypt(DEFAULT_SCRYPT)).toBe(false);
    expect(belowRecommendedScrypt({ N: SCRYPT_LIMITS.minN, r: 8, p: 1 })).toBe(true);
    expect(belowRecommendedScrypt({ N: 1 << 17, r: 8, p: 1 })).toBe(false);
    expect(belowRecommendedScrypt({ N: 1 << 14, r: 8, p: 5 })).toBe(false);
    expect(belowRecommendedScrypt({ N: 1 << 15, r: 8, p: 1 })).toBe(true);
  });

  it('上限按资源算：每次验证内存 128·N·r ≤ 256 MiB、计算量受限（不再接受约 4 GiB 的参数）', async () => {
    const h = await hashPasscode('passcode-1234', params);
    const withParams = (n: number, r: number, p: number) => h.replace(':16384:8:1:', `:${n}:${r}:${p}:`);
    expect(parsePasscodeHash(withParams(1 << 20, 32, 16))).toMatchObject({ ok: false, reason: /MiB/ });
    expect(parsePasscodeHash(withParams(1 << 20, 8, 1))).toMatchObject({ ok: false }); // 1 GiB
    expect(parsePasscodeHash(withParams(1 << 18, 8, 1)).ok).toBe(true); // 256 MiB
    expect(parsePasscodeHash(withParams(1 << 18, 8, 16))).toMatchObject({ ok: false }); // 计算量超限
    expect(parsePasscodeHash(withParams(1 << 17, 8, 1)).ok).toBe(true);
    expect(parsePasscodeHash(withParams(1 << 15, 8, 3)).ok).toBe(true);
    await expect(hashPasscode('x', { N: 1 << 20, r: 32, p: 1 })).rejects.toThrow(/MiB/);
  });

  it('p>1 的哈希能正常验证（maxmem 按 128·N·r 计）', async () => {
    const parsed = parsePasscodeHash(await hashPasscode('p-three-passcode', { N: SCRYPT_LIMITS.minN, r: 8, p: 3 }));
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(await verifyPasscode('p-three-passcode', parsed.value)).toBe(true);
  });
});
