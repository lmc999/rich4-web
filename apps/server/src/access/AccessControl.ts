/**
 * 访问门禁服务（docs/design/original-skin.md U4、§3 修正 3；design-draft §5.3；architecture §35）：cookie 校验与滑动续期、
 * 口令 / 邀请码登录、房间邀请授权的签发与兑换、吊销。HTTP 路由在 http/access.ts，握手守卫在 net/io.ts，
 * g 会话的房间作用域在 net/accessScope.ts 强制。
 *
 * - cookie 有效期：口令与邀请码 ACCESS_TTL_DAYS 天；房间授权（kind g）24 小时。都按「用过就续」滑动：
 *   距上次签发超过 min(有效期/4, 1 天) 的有效 cookie 在下一次 /api、manifest 或握手时换发。
 *   例外：用带到期时间的邀请码登录的会话，到期时间 = min(现在 + 有效期, 邀请码到期时间)，续期也不超过邀请码到期时间
 *   （cookie 的 cap 字段），到点即失效；没有到期时间的邀请码照常滑动。
 * - 邀请码的可用次数 = 可登录的设备数：只有 POST /api/access 消耗次数，同一设备凭 cookie 再进（含续期）不消耗。
 * - 停用邀请码（DELETE /admin/access/invites/:id）：i cookie 带邀请码 id，check 时查它是否已撤销（已撤销 id 的集合与 epoch
 *   一样按 epochCacheMs 缓存，另一进程撤销 1 秒内生效）；撤销后下一次 /api、manifest 或握手即被拒（reason revoked），已建立的
 *   Socket 不强制断开。用这个码的人生成的房间授权、经授权进来的 g 会话不受影响；旧格式换发来的 i（不带 id）照旧只按到期。
 * - 房间授权：30 分钟、1 次（ACCESS_GRANT_*），绑定房间实例；兑换得到的 g cookie 只对那个房间实例有效。
 *   持 p / i 会话的人打开链接不消耗次数；持 g 会话的人打开同一房间的链接不消耗，打开别的房间的链接正常兑换并换绑新房间。
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
  ROOM_INSTANCE_RE,
  type RoomBinding,
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
  /**
   * 房间号 → 当前房间实例（net/accessScope.ts 的 roomInstanceOf）；房间不存在返回 null。生成授权时检查房间存在并绑定实例，
   * 兑换时检查实例仍在。缺省（单元测试）不检查，实例一律记为 '0'
   */
  roomInstance?: (code: string) => string | null;
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

/** 每 IP 每小时最多生成的房间授权数（一个链接只给一个人：邀请框每复制 / 出示一次二维码就换一个） */
export const GRANTS_PER_IP_PER_HOUR = 60;
const DAY_S = 86_400;
/** roomInstance 缺省时（单元测试）授权绑定的实例 */
const ANY_INSTANCE = '0';

/** 签发 cookie 的附加信息：硬性到期（Unix 秒，0 = 无）、g 的房间、i 的邀请码 id */
interface IssueOptions {
  cap?: number;
  room?: RoomBinding | null;
  invite?: string | null;
}

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
  private revokedCache: { ids: ReadonlySet<string>; at: number } | null = null;
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

  /** 邀请码是否已撤销（已撤销 id 的集合缓存 epochCacheMs） */
  private inviteRevoked(id: string): boolean {
    const now = this.now();
    if (!this.revokedCache || now - this.revokedCache.at >= this.epochCacheMs) {
      this.revokedCache = { ids: new Set(this.store.revokedInviteIds()), at: now };
    }
    return this.revokedCache.ids.has(id);
  }

  /** 某种 cookie 的有效期（秒） */
  ttlSec(kind: AccessKind): number {
    const full = Math.round(this.d.config.ttlDays * DAY_S);
    return kind === 'g' ? Math.min(full, ACCESS_GRANT_COOKIE_TTL_MS / 1000) : full;
  }

  /** 这一刻签发的到期时间（Unix 秒）：现在 + 有效期，有 cap 时不超过 cap */
  private expiryFor(kind: AccessKind, cap: number): number {
    const full = Math.floor(this.now() / 1000) + this.ttlSec(kind);
    return cap > 0 ? Math.min(full, cap) : full;
  }

  private issue(kind: AccessKind, o: IssueOptions = {}): { claims: AccessClaims; setCookie: string } {
    const cap = o.cap ?? 0;
    const exp = this.expiryFor(kind, cap);
    const claims: AccessClaims = {
      exp,
      epoch: this.epoch(),
      kind,
      cap,
      room: o.room ?? null,
      invite: o.invite ?? null,
    };
    const value = signAccessCookie(claims, this.key!);
    const maxAgeSec = exp - Math.floor(this.now() / 1000);
    return { claims, setCookie: serializeAccessCookie(value, { maxAgeSec, secure: this.d.config.secure }) };
  }

  /**
   * 校验请求的 Cookie 头；需要续期时带上新的 Set-Cookie（保留 kind、cap、房间与邀请码 id）。
   * 邀请码会话：登录所用的邀请码已撤销时判为 revoked。
   * 续期条件：距上次签发超过 min(有效期/4, 1 天)，且新的到期时间确实更晚（到了 cap 的会话不再换发）。
   */
  check(cookieHeader: string | string[] | undefined): GateCheck {
    if (!this.enabled) return { granted: true, claims: null, reason: null, renew: null };
    const r = verifyAccessCookie(readCookie(cookieHeader), this.key!, this.now(), this.epoch());
    if (!r.ok) return { granted: false, claims: null, reason: r.reason, renew: null };
    const c = r.claims;
    if (c.invite !== null && this.inviteRevoked(c.invite)) {
      return { granted: false, claims: null, reason: 'revoked', renew: null };
    }
    const ttl = this.ttlSec(c.kind);
    const age = ttl - (c.exp - Math.floor(this.now() / 1000));
    const due = age >= Math.min(ttl / 4, DAY_S) && this.expiryFor(c.kind, c.cap) > c.exp;
    const renew = due ? this.issue(c.kind, { cap: c.cap, room: c.room, invite: c.invite }).setCookie : null;
    return { granted: true, claims: c, reason: null, renew };
  }

  /** g 会话绑定的房间实例是否还在（roomInstance 缺省时按还在） */
  private roomOpen(r: RoomBinding): boolean {
    return this.d.roomInstance ? this.d.roomInstance(r.code) === r.instance : true;
  }

  statusOf(g: Pick<GateCheck, 'granted' | 'claims'>): AccessStatusWithPack {
    const c = this.enabled && g.claims ? g.claims : null;
    const kind = c ? c.kind : null;
    return {
      mode: this.mode,
      granted: g.granted,
      kind,
      expiresAt: c ? c.exp * 1000 : null,
      deadline: c && c.cap > 0 ? c.cap * 1000 : null,
      room: c?.room ? c.room.code : null,
      roomOpen: c?.room ? this.roomOpen(c.room) : null,
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

  /**
   * POST /api/access：口令模式先比口令、再试邀请码；邀请模式只认邀请码。不看请求里已有的 cookie：持房间授权（g）的人
   * 后来拿到口令或邀请码，登录成功即换发 p / i cookie（Set-Cookie 覆盖同名 cookie），恢复完整权限。
   */
  async login(passcode: string, ip: string): Promise<AccessOutcome<AccessStatusWithPack>> {
    if (!this.enabled) return { ok: true, data: this.statusOf({ granted: true, claims: null }), setCookie: null };
    return this.limited(this.limiter, ip, async () => {
      let kind: AccessKind | null = null;
      let cap = 0;
      let invite: string | null = null;
      if (this.mode === 'passcode') {
        if (await verifyPasscode(passcode, this.d.config.passcodeHash!)) kind = 'p';
      }
      if (kind === null && normalizeInviteCode(passcode) !== null) {
        const inv = this.store.redeemInvite(passcode, this.now());
        if (inv) {
          kind = 'i';
          invite = inv.id;
          // 会话到期 = min(现在 + 有效期, 邀请码到期)，续期不超过邀请码到期（向下取整到秒：不晚于邀请码本身）
          cap = inv.expiresAt === null ? 0 : Math.floor(inv.expiresAt / 1000);
        }
      }
      if (kind === null) {
        return this.failed(this.limiter, ip, 'login', this.mode === 'invite' ? 'badInvite' : 'badPasscode');
      }
      this.limiter.success(ip);
      const c = this.issue(kind, { cap, invite });
      this.d.log.info({ ip, kind, capped: cap > 0 }, 'access: granted');
      return {
        ok: true,
        data: this.statusOf({ granted: true, claims: c.claims }),
        setCookie: c.setCookie,
      };
    });
  }

  /**
   * POST /api/access/grant：已通过口令或邀请码的玩家为房间生成授权（30 分钟、1 次，绑定当前房间实例）。
   * g 会话不能生成（403 ACCESS_SCOPE，防链式扩散）。
   */
  grant(g: GateCheck, room: string, ip: string): AccessOutcome<AccessGrantResult> {
    if (!this.grantsEnabled)
      return { ok: false, status: 404, code: 'BAD_REQUEST', details: { reason: 'grantsDisabled' } };
    if (!g.granted || !g.claims) {
      return { ok: false, status: 401, code: 'ACCESS_REQUIRED', details: { reason: g.reason ?? 'missing' } };
    }
    if (g.claims.kind === 'g') {
      return { ok: false, status: 403, code: 'ACCESS_SCOPE', details: { reason: 'grantNotAllowed' } };
    }
    const instance = this.d.roomInstance ? this.d.roomInstance(room) : ANY_INSTANCE;
    if (instance === null || !ROOM_INSTANCE_RE.test(instance)) {
      return { ok: false, status: 404, code: 'ROOM_NOT_FOUND' };
    }
    const now = this.now();
    let b = this.grantBuckets.get(ip);
    if (!b) {
      b = new TokenBucket({ count: this.grantsPerHour, perMs: 3_600_000, burst: this.grantsPerHour }, now);
      this.grantBuckets.set(ip, b);
    }
    if (!b.take(now)) return this.rateLimited(Math.ceil(3_600_000 / this.grantsPerHour), 'grant');
    this.maybePrune(now);
    const expiresAt = now + ACCESS_GRANT_TTL_MS;
    const token = this.store.createGrant({
      room,
      instance,
      uses: ACCESS_GRANT_MAX_USES,
      expiresAt,
      epoch: this.epoch(),
      now,
    });
    this.d.log.info({ ip, room }, 'access: room grant issued');
    return {
      ok: true,
      data: { room, token, expiresAt, uses: ACCESS_GRANT_MAX_USES, path: accessGrantPath(room, token) },
      setCookie: g.renew,
    };
  }

  /**
   * POST /api/access/redeem：兑换房间授权。
   * - 持 p / i 会话：不消耗次数，原样返回状态（target = 链接对应的房间，链接已失效为 null）；
   * - 持 g 会话且链接就是它绑定的房间实例：同样不消耗；
   * - 其余（没有有效 cookie，或 g 会话打开别的房间的链接）：经兑换限流器消耗一次，签发绑定该房间实例的 g cookie。
   *   房间已关闭（实例不在了）时不消耗，返回 404 ROOM_NOT_FOUND（reason roomClosed）。
   */
  async redeem(
    g: GateCheck,
    token: string,
    ip: string,
  ): Promise<AccessOutcome<AccessRedeemResult & AccessStatusWithPack>> {
    if (!this.grantsEnabled)
      return { ok: false, status: 404, code: 'BAD_REQUEST', details: { reason: 'grantsDisabled' } };
    if (g.granted && g.claims) {
      const bound = g.claims.room;
      const peek = this.store.peekGrant(token, this.now(), this.epoch());
      if (!bound) return { ok: true, data: { ...this.statusOf(g), target: peek?.room ?? null }, setCookie: g.renew };
      if (peek && peek.room === bound.code && peek.instance === bound.instance) {
        return { ok: true, data: { ...this.statusOf(g), target: peek.room }, setCookie: g.renew };
      }
    }
    return this.limited(this.redeemLimiter, ip, () => {
      const now = this.now();
      const epoch = this.epoch();
      const peek = this.store.peekGrant(token, now, epoch);
      if (peek && this.d.roomInstance && this.d.roomInstance(peek.room) !== peek.instance) {
        this.d.log.info({ ip, room: peek.room }, 'access: room grant for a closed room');
        return { ok: false, status: 404, code: 'ROOM_NOT_FOUND', details: { reason: 'roomClosed' } };
      }
      const rec = peek ? this.store.redeemGrant(token, now, epoch) : null;
      if (!rec) return this.failed(this.redeemLimiter, ip, 'redeem', 'grantInvalid');
      this.redeemLimiter.success(ip);
      const c = this.issue('g', { room: { code: rec.room, instance: rec.instance } });
      this.d.log.info(
        { ip, room: rec.room, usesLeft: rec.usesLeft, rebind: g.claims?.kind === 'g' },
        'access: room grant redeemed',
      );
      return {
        ok: true,
        data: { ...this.statusOf({ granted: true, claims: c.claims }), target: rec.room },
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
    // 外部程序可能天天签发限时邀请码：签发时顺带（每小时至多一次）清掉过期、用完与撤销的
    this.maybePrune(now);
    const expiresAt = o.days === null ? null : now + Math.round(o.days * DAY_S * 1000);
    return this.store.createInvite({ uses: o.uses, expiresAt, now, ...(o.note ? { note: o.note } : {}) });
  }

  listInvites(): InviteRecord[] {
    return this.store.listInvites();
  }

  /** 撤销邀请码：不能再登录，用它登录的会话下一次请求即失效（本进程立即生效，不等缓存过期） */
  revokeInvite(id: string): boolean {
    const ok = this.store.revokeInvite(id);
    if (ok) this.revokedCache = null;
    return ok;
  }

  /** epoch + 1：全部 cookie 与未兑换的授权立即失效 */
  revokeAll(): number {
    const e = this.store.bumpEpoch();
    this.epochCache = { value: e, at: this.now() };
    this.d.log.warn({ epoch: e }, 'access: all sessions revoked');
    return e;
  }
}
