/**
 * 访问 cookie（docs/design/original-skin.md U4、§3 修正 3；design-draft §5.3；architecture §35）：
 * `r4_access=v2.<exp>.<epoch>.<kind>.<cap>.<ref>.<HMAC>`
 * - exp：到期时间（Unix 秒）；epoch：签发时的 access_meta.epoch（吊销即 +1）；kind：p 口令 / i 邀请码 / g 房间授权；
 * - cap：硬性到期（Unix 秒），续期换发时 exp 不超过它；0 表示没有。用带到期时间的邀请码登录的 i 会话 = 邀请码到期时间；
 * - ref：按 kind 解释——g 是绑定的房间实例 `<房间号>-<实例>`（实例 = 房间创建时间的 base36，见 net/accessScope.ts）；
 *   i 是登录所用邀请码的 id（8 位十六进制；停用这个邀请码即让会话失效），由 v1 换发来的 i 不知道 id，为 `-`；p 为 `-`；
 * - HMAC = base64url(HMAC-SHA256(K, `v2.<exp>.<epoch>.<kind>.<cap>.<ref>`))，K 由 ACCESS_SECRET 派生（域分离）；
 *   更换 ACCESS_SECRET 即让全部 cookie 失效。
 * - 兼容：旧格式 `v1.<exp>.<epoch>.<kind>.<HMAC>`（同一个 K）的 p / i 继续有效（cap = 0、不绑房间、不带邀请码 id，
 *   续期时换发成 v2）；v1 的 g 不知道绑定哪个房间，一律判为 outdated（GET /api/access 清掉它，需要重新兑换邀请链接）。
 * - 属性：HttpOnly、SameSite=Lax、Path=/，PUBLIC_URL 为 https 时 Secure。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ACCESS_COOKIE, ACCESS_KINDS, type AccessKind } from '@rich4/shared/net';

/** kind g 绑定的房间实例 */
export interface RoomBinding {
  /** 6 位房间号 */
  code: string;
  /** 房间实例（同号的新房间实例不同） */
  instance: string;
}

export interface AccessClaims {
  /** 到期（Unix 秒） */
  exp: number;
  epoch: number;
  kind: AccessKind;
  /** 硬性到期（Unix 秒）；0 = 没有 */
  cap: number;
  /** kind g 绑定的房间；p / i 为 null */
  room: RoomBinding | null;
  /** kind i 登录所用邀请码的 id（停用即失效）；p / g、旧格式换发来的 i 为 null */
  invite: string | null;
}

export type CookieCheck =
  | { ok: true; claims: AccessClaims }
  | { ok: false; reason: 'missing' | 'malformed' | 'badSignature' | 'expired' | 'revoked' | 'outdated' };

const VERSION = 'v2';
const SIG = '([A-Za-z0-9_-]{43})';
const V1_RE = new RegExp(`^v1\\.(\\d{1,12})\\.(\\d{1,12})\\.([a-z])\\.${SIG}$`);
const V2_RE = new RegExp(
  `^v2\\.(\\d{1,12})\\.(\\d{1,12})\\.([a-z])\\.(\\d{1,12})\\.(-|[0-9a-f]{8}|[1-9]\\d{5}-[0-9a-z]{1,12})\\.${SIG}$`,
);
/** 房间实例的写法（base36，1–12 位） */
export const ROOM_INSTANCE_RE = /^[0-9a-z]{1,12}$/;
/** 邀请码 id 的写法（AccessStore.createInvite：4 字节随机数的十六进制） */
export const INVITE_ID_RE = /^[0-9a-f]{8}$/;
const ROOM_REF_RE = /^([1-9]\d{5})-([0-9a-z]{1,12})$/;

/** cookie 签名密钥：HMAC(ACCESS_SECRET, 固定标签)，与其他用途域分离（v1、v2 共用：签名正文自带版本前缀） */
export function cookieKey(secret: string): Buffer {
  return createHmac('sha256', secret).update('rich4/access-cookie/v1').digest();
}

function mac(key: Buffer, body: string): string {
  return createHmac('sha256', key).update(body).digest('base64url');
}

/** ref 字段：g → 房间实例，i → 邀请码 id（没有为 -），p → - */
function refField(c: AccessClaims): string {
  if (c.kind === 'g') {
    if (!c.room || !ROOM_INSTANCE_RE.test(c.room.instance)) throw new Error('kind g 必须绑定房间实例');
    if (c.invite !== null) throw new Error('kind g 不带邀请码');
    return `${c.room.code}-${c.room.instance}`;
  }
  if (c.room !== null) throw new Error('只有 kind g 绑定房间');
  if (c.kind === 'i') {
    if (c.invite === null) return '-';
    if (!INVITE_ID_RE.test(c.invite)) throw new Error('邀请码 id 格式不对');
    return c.invite;
  }
  if (c.invite !== null) throw new Error('只有 kind i 带邀请码');
  return '-';
}

export function signAccessCookie(c: AccessClaims, key: Buffer): string {
  const body = `${VERSION}.${c.exp}.${c.epoch}.${c.kind}.${c.cap}.${refField(c)}`;
  return `${body}.${mac(key, body)}`;
}

function sigOk(key: Buffer, body: string, sig: string): boolean {
  const expected = Buffer.from(mac(key, body));
  const given = Buffer.from(sig);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** 按 kind 解析 ref；与 kind 对不上时 null（malformed） */
function parseRef(kind: string, ref: string): Pick<AccessClaims, 'room' | 'invite'> | null {
  if (kind === 'g') {
    const m = ROOM_REF_RE.exec(ref);
    return m ? { room: { code: m[1]!, instance: m[2]! }, invite: null } : null;
  }
  if (kind === 'i') {
    if (ref === '-') return { room: null, invite: null };
    return INVITE_ID_RE.test(ref) ? { room: null, invite: ref } : null;
  }
  return ref === '-' ? { room: null, invite: null } : null;
}

/**
 * 校验 cookie 值（不含名字）：格式、签名（常数时间）、到期、epoch；v1 只认 p / i。
 * 邀请码是否已停用不在这里查（要读库，见 AccessControl.check）。
 */
export function verifyAccessCookie(
  value: string | null | undefined,
  key: Buffer,
  nowMs: number,
  currentEpoch: number,
): CookieCheck {
  if (!value) return { ok: false, reason: 'missing' };
  let claims: AccessClaims;
  const m2 = V2_RE.exec(value);
  if (m2) {
    const [, expS, epochS, kind, capS, refS, sig] = m2 as unknown as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (!(ACCESS_KINDS as readonly string[]).includes(kind)) return { ok: false, reason: 'malformed' };
    const ref = parseRef(kind, refS);
    if (!ref) return { ok: false, reason: 'malformed' };
    if (!sigOk(key, `v2.${expS}.${epochS}.${kind}.${capS}.${refS}`, sig)) return { ok: false, reason: 'badSignature' };
    claims = { exp: Number(expS), epoch: Number(epochS), kind: kind as AccessKind, cap: Number(capS), ...ref };
  } else {
    const m1 = V1_RE.exec(value);
    if (!m1) return { ok: false, reason: 'malformed' };
    const [, expS, epochS, kind, sig] = m1 as unknown as [string, string, string, string, string];
    if (!(ACCESS_KINDS as readonly string[]).includes(kind)) return { ok: false, reason: 'malformed' };
    if (!sigOk(key, `v1.${expS}.${epochS}.${kind}`, sig)) return { ok: false, reason: 'badSignature' };
    // 旧格式的房间授权不带房间：不能按作用域限制，要求重新兑换
    if (kind === 'g') return { ok: false, reason: 'outdated' };
    claims = { exp: Number(expS), epoch: Number(epochS), kind: kind as AccessKind, cap: 0, room: null, invite: null };
  }
  if (claims.exp * 1000 <= nowMs) return { ok: false, reason: 'expired' };
  if (claims.epoch !== currentEpoch) return { ok: false, reason: 'revoked' };
  return { ok: true, claims };
}

/** 是否像一个访问 cookie 值（任一版本的格式；不验签） */
function wellFormed(v: string): boolean {
  return V2_RE.test(v) || V1_RE.test(v);
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
    if (wellFormed(v)) return v;
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
