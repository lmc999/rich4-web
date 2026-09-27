/**
 * 访问 cookie（docs/design/original-skin.md U4、§3 修正 3；design-draft §5.3）：
 * `r4_access=v1.<exp>.<epoch>.<kind>.<HMAC>`
 * - exp：到期时间（Unix 秒）；epoch：签发时的 access_meta.epoch（吊销即 +1）；kind：p 口令 / i 邀请码 / g 房间授权；
 * - HMAC = base64url(HMAC-SHA256(K, `v1.<exp>.<epoch>.<kind>`))，K 由 ACCESS_SECRET 派生（域分离）；
 *   更换 ACCESS_SECRET 即让全部 cookie 失效。
 * - 属性：HttpOnly、SameSite=Lax、Path=/，PUBLIC_URL 为 https 时 Secure。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ACCESS_COOKIE, ACCESS_KINDS, type AccessKind } from '@rich4/shared/net';

export interface AccessClaims {
  /** 到期（Unix 秒） */
  exp: number;
  epoch: number;
  kind: AccessKind;
}

export type CookieCheck =
  | { ok: true; claims: AccessClaims }
  | { ok: false; reason: 'missing' | 'malformed' | 'badSignature' | 'expired' | 'revoked' };

const VERSION = 'v1';
const COOKIE_RE = /^v1\.(\d{1,12})\.(\d{1,12})\.([a-z])\.([A-Za-z0-9_-]{43})$/;

/** cookie 签名密钥：HMAC(ACCESS_SECRET, 固定标签)，与其他用途域分离 */
export function cookieKey(secret: string): Buffer {
  return createHmac('sha256', secret).update('rich4/access-cookie/v1').digest();
}

function mac(key: Buffer, body: string): string {
  return createHmac('sha256', key).update(body).digest('base64url');
}

export function signAccessCookie(c: AccessClaims, key: Buffer): string {
  const body = `${VERSION}.${c.exp}.${c.epoch}.${c.kind}`;
  return `${body}.${mac(key, body)}`;
}

/** 校验 cookie 值（不含名字）：格式、签名（常数时间）、到期、epoch */
export function verifyAccessCookie(
  value: string | null | undefined,
  key: Buffer,
  nowMs: number,
  currentEpoch: number,
): CookieCheck {
  if (!value) return { ok: false, reason: 'missing' };
  const m = COOKIE_RE.exec(value);
  if (!m) return { ok: false, reason: 'malformed' };
  const [, expS, epochS, kind, sig] = m as unknown as [string, string, string, string, string];
  if (!(ACCESS_KINDS as readonly string[]).includes(kind)) return { ok: false, reason: 'malformed' };
  const expected = Buffer.from(mac(key, `${VERSION}.${expS}.${epochS}.${kind}`));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return { ok: false, reason: 'badSignature' };
  const exp = Number(expS);
  const epoch = Number(epochS);
  if (exp * 1000 <= nowMs) return { ok: false, reason: 'expired' };
  if (epoch !== currentEpoch) return { ok: false, reason: 'revoked' };
  return { ok: true, claims: { exp, epoch, kind: kind as AccessKind } };
}

/** 解析 Cookie 请求头，取出指定名字的值（同名多个时取第一个格式正确的） */
export function readCookie(header: string | string[] | undefined, name: string = ACCESS_COOKIE): string | null {
  if (!header) return null;
  const all = Array.isArray(header) ? header.join('; ') : header;
  let first: string | null = null;
  for (const part of all.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    let v = part.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    if (COOKIE_RE.test(v)) return v;
    first ??= v;
  }
  return first;
}

export interface CookieAttrs {
  maxAgeSec: number;
  secure: boolean;
}

/** Set-Cookie 头的值 */
export function serializeAccessCookie(value: string, a: CookieAttrs, name: string = ACCESS_COOKIE): string {
  const parts = [`${name}=${value}`, 'Path=/', `Max-Age=${Math.max(0, Math.floor(a.maxAgeSec))}`, 'HttpOnly'];
  parts.push('SameSite=Lax');
  if (a.secure) parts.push('Secure');
  return parts.join('; ');
}

/** 清除 cookie 的 Set-Cookie 头 */
export function clearAccessCookie(secure: boolean, name: string = ACCESS_COOKIE): string {
  return serializeAccessCookie('', { maxAgeSec: 0, secure }, name);
}
