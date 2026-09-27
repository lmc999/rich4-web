/**
 * 访问门禁服务（docs/design/original-skin.md U4、§3 修正 3；design-draft §5.3）：cookie 校验与滑动续期、
 * 口令 / 邀请码登录、房间邀请授权的签发与兑换、吊销。HTTP 路由在 http/access.ts，握手守卫在 net/io.ts。
 *
 * - cookie 有效期：口令与邀请码 ACCESS_TTL_DAYS 天；房间授权（kind g）24 小时。都按「用过就续」滑动：
 *   距上次签发超过 min(有效期/4, 1 天) 的有效 cookie 在下一次 /api、manifest 或握手时换发。
 * - 吊销：access_meta.epoch + 1（scripts/access.ts revoke 或 POST /admin/access/revoke）。epoch 每秒至多读一次库，
 *   所以 CLI 在另一个进程里吊销也会在 1 秒内生效；已建立的 Socket 连接不强制断开（下次握手被拒）。
 * - 口令与邀请码永不写日志；失败只记 IP 与累计次数。
 */
import {
  ACCESS_GRANT_COOKIE_TTL_MS,
  ACCESS_GRANT_MAX_USES,
  ACCESS_GRANT_TTL_MS,
  type AccessGrantResult,
  type AccessKind,
  type AccessMode,
  type AccessRedeemResult,
  type AccessStatusWithPack,
  accessGrantPath,
  type ErrorCode,
} from '@rich4/shared/net';
import type { Logger } from '../infra/logger';
import { TokenBucket } from '../net/rateLimit';
import type { AccessStore, InviteRecord } from './AccessStore';
import { normalizeInviteCode } from './AccessStore';
import {
  type AccessClaims,
  type CookieCheck,
  clearAccessCookie,
  cookieKey,
  readCookie,
  serializeAccessCookie,
  signAccessCookie,
  verifyAccessCookie,
} from './cookie';
import { AccessLimiter, REDEEM_LIMITS } from './limiter';
import { type PasscodeHash, verifyPasscode } from './passcode';

export interface AccessConfig {
  mode: AccessMode;
  /** mode=passcode 时必有 */
  passcodeHash: PasscodeHash | null;
  /** mode!=off 时必有（≥32 字节） */
  secret: string | null;
  ttlDays: number;
  /** ACCESS_GRANTS：允许已通过门禁的玩家生成房间邀请授权 */
  grants: boolean;
  /** PUBLIC_URL 为 https 时给 cookie 加 Secure */
  secure: boolean;
}

export interface AccessControlDeps {
  config: AccessConfig;
  /** mode=off 时可以为 null */
  store: AccessStore | null;
  log: Logger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 口令 / 邀请码登录的限流（scrypt） */
  limiter?: AccessLimiter;
  /** 房间授权兑换的限流（与登录分开计全局名额；缺省按 REDEEM_LIMITS） */
  redeemLimiter?: AccessLimiter;
  /** epoch 缓存时长（默认 1 秒） */
  epochCacheMs?: number;
  /** 房间是否存在（生成授权时检查）；缺省不检查 */
  roomExists?: (code: string) => boolean;
  /** 已启用素材包的 packId（状态接口里告诉已通过门禁的前端）；没有素材包为 null */
  packId?: string | null;
  /** 每 IP 每小时的房间授权数（缺省 GRANTS_PER_IP_PER_HOUR；RICH4_TEST_MODE 下放宽：E2E 的所有页面都来自回环地址） */
  grantsPerHour?: number;
}

/** 失败结果：HTTP 状态、错误码、details（不含口令） */
export interface AccessFailure {
  ok: false;
  status: number;
  code: ErrorCode;
  details?: Record<string, unknown>;
  retryAfterMs?: number;
}

export type AccessOutcome<T> = { ok: true; data: T; setCookie: string | null } | AccessFailure;

export interface GateCheck {
  granted: boolean;
  claims: AccessClaims | null;
  reason: Exclude<CookieCheck, { ok: true }>['reason'] | null;
  /** 需要滑动续期时的 Set-Cookie 值 */
  renew: string | null;
}

/** 每 IP 每小时最多生成的房间授权数 */
export const GRANTS_PER_IP_PER_HOUR = 30;
const DAY_S = 86_400;

export class AccessControl {
  readonly mode: AccessMode;
  readonly enabled: boolean;
  readonly grantsEnabled: boolean;
  private readonly key: Buffer | null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  readonly limiter: AccessLimiter;
  readonly redeemLimiter: AccessLimiter;
  private readonly grantBuckets = new Map<string, TokenBucket>();
  private epochCache: { value: number; at: number } | null = null;
  private readonly epochCacheMs: number;
  private readonly grantsPerHour: number;
  private lastPrune = 0;

  constructor(private readonly d: AccessControlDeps) {
    const c = d.config;
    this.mode = c.mode;
    this.enabled = c.mode !== 'off';
    if (this.enabled) {
      if (!c.secret) throw new Error('ACCESS_SECRET 未设置');
      if (!d.store) throw new Error('访问门禁需要 AccessStore');
      if (c.mode === 'passcode' && !c.passcodeHash) throw new Error('ACCESS_PASSCODE_HASH 未设置');
    }
    this.key = c.secret ? cookieKey(c.secret) : null;
    this.grantsEnabled = this.enabled && c.grants;
    this.now = d.now ?? (() => Date.now());
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.limiter = d.limiter ?? new AccessLimiter({ now: this.now });
    this.redeemLimiter = d.redeemLimiter ?? new AccessLimiter({ now: this.now, ...REDEEM_LIMITS });
    this.epochCacheMs = d.epochCacheMs ?? 1000;
    this.grantsPerHour = Math.max(1, Math.trunc(d.grantsPerHour ?? GRANTS_PER_IP_PER_HOUR));
  }

  private get store(): AccessStore {
    return this.d.store!;
  }

  /** 当前 epoch（缓存 epochCacheMs） */
  epoch(): number {
    if (!this.enabled) return 0;
    const now = this.now();
    if (this.epochCache && now - this.epochCache.at < this.epochCacheMs) return this.epochCache.value;
    const value = this.store.epoch();
    this.epochCache = { value, at: now };
    return value;
  }

  /** 某种 cookie 的有效期（秒） */
  ttlSec(kind: AccessKind): number {
    const full = Math.round(this.d.config.ttlDays * DAY_S);
    return kind === 'g' ? Math.min(full, ACCESS_GRANT_COOKIE_TTL_MS / 1000) : full;
  }

  private issue(kind: AccessKind): { value: string; setCookie: string; exp: number } {
    const ttl = this.ttlSec(kind);
    const exp = Math.floor(this.now() / 1000) + ttl;
    const value = signAccessCookie({ exp, epoch: this.epoch(), kind }, this.key!);
    return { value, exp, setCookie: serializeAccessCookie(value, { maxAgeSec: ttl, secure: this.d.config.secure }) };
  }

  /** 校验请求的 Cookie 头；需要续期时带上新的 Set-Cookie */
  check(cookieHeader: string | string[] | undefined): GateCheck {
    if (!this.enabled) return { granted: true, claims: null, reason: null, renew: null };
    const r = verifyAccessCookie(readCookie(cookieHeader), this.key!, this.now(), this.epoch());
    if (!r.ok) return { granted: false, claims: null, reason: r.reason, renew: null };
    const ttl = this.ttlSec(r.claims.kind);
    const age = ttl - (r.claims.exp - Math.floor(this.now() / 1000));
    const renew = age >= Math.min(ttl / 4, DAY_S) ? this.issue(r.claims.kind).setCookie : null;
    return { granted: true, claims: r.claims, reason: null, renew };
  }

  statusOf(g: Pick<GateCheck, 'granted' | 'claims'>): AccessStatusWithPack {
    const kind = this.enabled && g.claims ? g.claims.kind : null;
    return {
      mode: this.mode,
      granted: g.granted,
      kind,
      expiresAt: this.enabled && g.claims ? g.claims.exp * 1000 : null,
      grants: this.grantsEnabled,
      canGrant: this.grantsEnabled && g.granted && (kind === 'p' || kind === 'i'),
      pack: g.granted ? (this.d.packId ?? null) : null,
    };
  }

  clearCookie(): string {
    return clearAccessCookie(this.d.config.secure);
  }

  private rateLimited(retryAfterMs: number, scope: string): AccessFailure {
    return { ok: false, status: 429, code: 'RATE_LIMITED', details: { retryAfterMs, scope }, retryAfterMs };
  }

  /**
   * 经限流器放行后执行 attempt（排队等待在前）；attempt 结束（含抛错）后释放该 IP 的在途名额。
   * 被限流时返回 429，不执行 attempt。
   */
  private async limited<T>(
    limiter: AccessLimiter,
    ip: string,
    attempt: () => Promise<AccessOutcome<T>> | AccessOutcome<T>,
  ): Promise<AccessOutcome<T>> {
    const a = limiter.admit(ip);
    if (!a.ok) {
      this.d.log.warn({ ip, scope: a.scope, retryAfterMs: a.retryAfterMs }, 'access: attempt throttled');
      return this.rateLimited(a.retryAfterMs, a.scope);
    }
    try {
      if (a.waitMs > 0) await this.sleep(a.waitMs);
      return await attempt();
    } finally {
      limiter.release(ip);
    }
  }

  private failed(limiter: AccessLimiter, ip: string, what: string, reason: string): AccessFailure {
    const { fails, alarm } = limiter.fail(ip);
    this.d.log.warn({ ip, what, fails }, 'access: attempt rejected');
    if (alarm) this.d.log.error('access: many failed attempts within a minute (possible brute force)');
    return { ok: false, status: 401, code: 'ACCESS_REQUIRED', details: { reason } };
  }

  /** POST /api/access：口令模式先比口令、再试邀请码；邀请模式只认邀请码 */
  async login(passcode: string, ip: string): Promise<AccessOutcome<AccessStatusWithPack>> {
    if (!this.enabled) return { ok: true, data: this.statusOf({ granted: true, claims: null }), setCookie: null };
    return this.limited(this.limiter, ip, async () => {
      let kind: AccessKind | null = null;
      if (this.mode === 'passcode') {
        if (await verifyPasscode(passcode, this.d.config.passcodeHash!)) kind = 'p';
      }
      if (kind === null && normalizeInviteCode(passcode) !== null && this.store.redeemInvite(passcode, this.now())) {
        kind = 'i';
      }
      if (kind === null) {
        return this.failed(this.limiter, ip, 'login', this.mode === 'invite' ? 'badInvite' : 'badPasscode');
      }
      this.limiter.success(ip);
      const c = this.issue(kind);
      this.d.log.info({ ip, kind }, 'access: granted');
      return {
        ok: true,
        data: this.statusOf({ granted: true, claims: { exp: c.exp, epoch: this.epoch(), kind } }),
        setCookie: c.setCookie,
      };
    });
  }

  /** POST /api/access/grant：已通过口令或邀请码的玩家为房间生成 24 小时、限次的授权 */
  grant(g: GateCheck, room: string, ip: string): AccessOutcome<AccessGrantResult> {
    if (!this.grantsEnabled)
      return { ok: false, status: 404, code: 'BAD_REQUEST', details: { reason: 'grantsDisabled' } };
    if (!g.granted || !g.claims) {
      return { ok: false, status: 401, code: 'ACCESS_REQUIRED', details: { reason: g.reason ?? 'missing' } };
    }
    if (g.claims.kind === 'g') {
      return { ok: false, status: 403, code: 'ACCESS_REQUIRED', details: { reason: 'grantNotAllowed' } };
    }
    if (this.d.roomExists && !this.d.roomExists(room)) return { ok: false, status: 404, code: 'ROOM_NOT_FOUND' };
    const now = this.now();
    let b = this.grantBuckets.get(ip);
    if (!b) {
      b = new TokenBucket({ count: this.grantsPerHour, perMs: 3_600_000, burst: this.grantsPerHour }, now);
      this.grantBuckets.set(ip, b);
    }
    if (!b.take(now)) return this.rateLimited(Math.ceil(3_600_000 / this.grantsPerHour), 'grant');
    this.maybePrune(now);
    const expiresAt = now + ACCESS_GRANT_TTL_MS;
    const token = this.store.createGrant({ room, uses: ACCESS_GRANT_MAX_USES, expiresAt, epoch: this.epoch(), now });
    this.d.log.info({ ip, room }, 'access: room grant issued');
    return {
      ok: true,
      data: { room, token, expiresAt, uses: ACCESS_GRANT_MAX_USES, path: accessGrantPath(room, token) },
      setCookie: g.renew,
    };
  }

  /** POST /api/access/redeem：兑换房间授权；已持有效 cookie 时不消耗次数 */
  async redeem(
    g: GateCheck,
    token: string,
    ip: string,
  ): Promise<AccessOutcome<AccessRedeemResult & AccessStatusWithPack>> {
    if (!this.grantsEnabled)
      return { ok: false, status: 404, code: 'BAD_REQUEST', details: { reason: 'grantsDisabled' } };
    if (g.granted && g.claims) {
      const peek = this.store.peekGrant(token, this.now(), this.epoch());
      return { ok: true, data: { ...this.statusOf(g), room: peek?.room ?? null }, setCookie: g.renew };
    }
    return this.limited(this.redeemLimiter, ip, () => {
      const rec = this.store.redeemGrant(token, this.now(), this.epoch());
      if (!rec) return this.failed(this.redeemLimiter, ip, 'redeem', 'grantInvalid');
      this.redeemLimiter.success(ip);
      const c = this.issue('g');
      this.d.log.info({ ip, room: rec.room, usesLeft: rec.usesLeft }, 'access: room grant redeemed');
      return {
        ok: true,
        data: {
          ...this.statusOf({ granted: true, claims: { exp: c.exp, epoch: this.epoch(), kind: 'g' } }),
          room: rec.room,
        },
        setCookie: c.setCookie,
      };
    });
  }

  private maybePrune(now: number): void {
    if (now - this.lastPrune < 3_600_000) return;
    this.lastPrune = now;
    try {
      const n = this.store.prune(now);
      if (n > 0) this.d.log.info({ removed: n }, 'access: pruned expired grants and invites');
    } catch (err) {
      this.d.log.warn({ err }, 'access: prune failed');
    }
    for (const [ip, b] of this.grantBuckets) if (now - b.lastSeen > 3_600_000) this.grantBuckets.delete(ip);
  }

  // ───────────────────────── 管理（ADMIN_TOKEN 与 CLI） ─────────────────────────

  createInvite(o: { uses: number; days: number | null; note?: string }): { code: string; invite: InviteRecord } {
    const now = this.now();
    const expiresAt = o.days === null ? null : now + Math.round(o.days * DAY_S * 1000);
    return this.store.createInvite({ uses: o.uses, expiresAt, now, ...(o.note ? { note: o.note } : {}) });
  }

  listInvites(): InviteRecord[] {
    return this.store.listInvites();
  }

  revokeInvite(id: string): boolean {
    return this.store.revokeInvite(id);
  }

  /** epoch + 1：全部 cookie 与未兑换的授权立即失效 */
  revokeAll(): number {
    const e = this.store.bumpEpoch();
    this.epochCache = { value: e, at: this.now() };
    this.d.log.warn({ epoch: e }, 'access: all sessions revoked');
    return e;
  }
}
