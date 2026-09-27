// 访问门禁的密码学部分：cookie 签名与校验、Cookie 头解析、scrypt 口令哈希
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

  it('格式为 v1.<exp>.<epoch>.<kind>.<HMAC>，签名可验证', () => {
    const v = signAccessCookie({ exp, epoch: 3, kind: 'p' }, KEY);
    expect(v).toMatch(/^v1\.\d+\.3\.p\.[A-Za-z0-9_-]{43}$/);
    expect(verifyAccessCookie(v, KEY, NOW, 3)).toEqual({ ok: true, claims: { exp, epoch: 3, kind: 'p' } });
  });

  it('篡改任一字段、换密钥都判为签名错误', () => {
    const v = signAccessCookie({ exp, epoch: 0, kind: 'g' }, KEY);
    const parts = v.split('.');
    const tampered = [
      [parts[0], String(exp + 1), ...parts.slice(2)].join('.'),
      [...parts.slice(0, 3), 'p', parts[4]].join('.'),
      [...parts.slice(0, 2), '1', ...parts.slice(3)].join('.'),
    ];
    for (const t of tampered) expect(verifyAccessCookie(t, KEY, NOW, 0)).toMatchObject({ ok: false });
    expect(verifyAccessCookie(tampered[0], KEY, NOW, 0)).toEqual({ ok: false, reason: 'badSignature' });
    expect(verifyAccessCookie(v, cookieKey('y'.repeat(40)), NOW, 0)).toEqual({ ok: false, reason: 'badSignature' });
  });

  it('过期、epoch 变化、格式错误、缺失', () => {
    const v = signAccessCookie({ exp, epoch: 1, kind: 'i' }, KEY);
    expect(verifyAccessCookie(v, KEY, exp * 1000, 1)).toEqual({ ok: false, reason: 'expired' });
    expect(verifyAccessCookie(v, KEY, NOW, 2)).toEqual({ ok: false, reason: 'revoked' });
    expect(verifyAccessCookie('v1.x.y', KEY, NOW, 1)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyAccessCookie(v.replace('.i.', '.z.'), KEY, NOW, 1)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyAccessCookie(null, KEY, NOW, 1)).toEqual({ ok: false, reason: 'missing' });
  });

  it('readCookie 从多个 cookie 中取出 r4_access（优先格式正确的一个）', () => {
    const v = signAccessCookie({ exp, epoch: 0, kind: 'p' }, KEY);
    expect(readCookie(`a=1; ${ACCESS_COOKIE}=${v}; b=2`)).toBe(v);
    expect(readCookie(`${ACCESS_COOKIE}=junk; ${ACCESS_COOKIE}=${v}`)).toBe(v);
    expect(readCookie(`${ACCESS_COOKIE}="${v}"`)).toBe(v);
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
