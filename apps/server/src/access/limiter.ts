/**
 * 门禁的防暴力（docs/design/original-skin.md §3 修正 3；critique §四.2）：**退避延迟 + 全局软上限，不做硬锁**。
 *
 * - 按 IP 退避：前 FREE 次失败不限；之后每次失败把「下次允许尝试的时间」推后 base·2^k（封顶 maxDelayMs）。
 *   在退避窗口内的尝试直接 429（附 retryAfterMs），不做验证；成功一次清零；距上次失败超过 failWindowMs 也清零。
 *   IP 由 Fastify 按 TRUST_PROXY 取得：没开 TRUST_PROXY 又在反代之后时所有人共用一个 IP，
 *   退避封顶在数十秒，不会像「锁 15 分钟」那样把全站锁死（启动时会就此告警）。
 * - **在途的验证按失败预计**：admit 成功即为该 IP 记一个在途名额（调用方验证结束后 release），判断退避时
 *   「已记的失败 + 在途数」视同失败次数。同一 IP 并发发起的请求因此不能绕过退避：免费额度内最多 FREE+1 个并行，
 *   进入退避之后同一时刻至多一个在途，单个 IP 占不满全局名额。
 * - 全局软上限：验证名额按令牌桶发放（每分钟 globalPerMin 个，桶容量 globalBurst）。名额用完时请求**排队等待**
 *   （允许透支，等到名额补上再验证），只有预计等待超过 maxWaitMs 时才 429。分布式（多 IP）尝试因此被放慢，
 *   正常用户排队稍慢。scrypt 每次约 32 MiB 内存，这个上限同时限制了并发的内存与 CPU。
 *   房间授权兑换（不算 scrypt）用另一个实例（REDEEM_LIMITS），刷兑换接口不会占掉口令验证的全局名额。
 */

export interface AccessLimiterOptions {
  now?: () => number;
  /** 免退避的连续失败次数 */
  freeFailures?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** 距上次失败超过这么久，失败计数清零 */
  failWindowMs?: number;
  globalPerMin?: number;
  globalBurst?: number;
  /** 全局排队的最长等待；超过则 429 */
  maxWaitMs?: number;
  /** 全局失败超过此数（每分钟）时记一次告警 */
  alarmPerMin?: number;
}

export const ACCESS_LIMITS = Object.freeze({
  freeFailures: 5,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  failWindowMs: 30 * 60_000,
  globalPerMin: 30,
  globalBurst: 6,
  maxWaitMs: 10_000,
  alarmPerMin: 30,
});

/** 房间授权兑换的限流：token 有 256 位熵、不算 scrypt，只防刷库；与口令验证分开计全局名额 */
export const REDEEM_LIMITS = Object.freeze({
  globalPerMin: 120,
  globalBurst: 20,
});

/** 在途的请求被拒时建议的等待（ms） */
const PENDING_RETRY_MS = 1000;

interface IpState {
  fails: number;
  lastFail: number;
  nextAt: number;
}

export type Admission = { ok: true; waitMs: number } | { ok: false; retryAfterMs: number; scope: 'ip' | 'global' };

export class AccessLimiter {
  private readonly now: () => number;
  private readonly o: Required<Omit<AccessLimiterOptions, 'now'>>;
  private readonly ips = new Map<string, IpState>();
  /** 已放行、尚未 release 的验证（按 IP） */
  private readonly pending = new Map<string, number>();
  private tokens: number;
  private last: number;
  private windowStart: number;
  private windowFails = 0;
  private ops = 0;

  constructor(o: AccessLimiterOptions = {}) {
    this.now = o.now ?? (() => Date.now());
    this.o = {
      freeFailures: o.freeFailures ?? ACCESS_LIMITS.freeFailures,
      baseDelayMs: o.baseDelayMs ?? ACCESS_LIMITS.baseDelayMs,
      maxDelayMs: o.maxDelayMs ?? ACCESS_LIMITS.maxDelayMs,
      failWindowMs: o.failWindowMs ?? ACCESS_LIMITS.failWindowMs,
      globalPerMin: o.globalPerMin ?? ACCESS_LIMITS.globalPerMin,
      globalBurst: o.globalBurst ?? ACCESS_LIMITS.globalBurst,
      maxWaitMs: o.maxWaitMs ?? ACCESS_LIMITS.maxWaitMs,
      alarmPerMin: o.alarmPerMin ?? ACCESS_LIMITS.alarmPerMin,
    };
    this.tokens = this.o.globalBurst;
    this.last = this.now();
    this.windowStart = this.last;
  }

  private state(ip: string, now: number): IpState | null {
    const s = this.ips.get(ip);
    if (!s) return null;
    if (now - s.lastFail > this.o.failWindowMs) {
      this.ips.delete(ip);
      return null;
    }
    return s;
  }

  private delayFor(fails: number): number {
    const over = fails - this.o.freeFailures;
    return over > 0 ? Math.min(this.o.maxDelayMs, this.o.baseDelayMs * 2 ** (over - 1)) : 0;
  }

  /** 该 IP 还要等多久才能再试（0 表示可以）；在途的验证按失败预计 */
  retryAfter(ip: string): number {
    const now = this.now();
    const s = this.state(ip, now);
    const recorded = s ? Math.max(0, s.nextAt - now) : 0;
    const inFlight = this.pending.get(ip) ?? 0;
    if (inFlight === 0) return recorded;
    // 在途的都失败时这次尝试会落在退避窗口里：同一 IP 不能靠并发绕过退避
    const projected = this.delayFor((s?.fails ?? 0) + inFlight) > 0 ? PENDING_RETRY_MS : 0;
    return Math.max(recorded, projected);
  }

  /** 该 IP 在途的验证数 */
  inFlight(ip: string): number {
    return this.pending.get(ip) ?? 0;
  }

  /**
   * 申请一次验证：先看 IP 退避窗口（含在途数），再从全局令牌桶取名额。
   * 返回 ok 时 waitMs 为需要排队等待的毫秒数（调用方 await 之后再验证），并且**必须**在验证结束后调用 release(ip)
   * （先 fail / success，再 release）。
   */
  admit(ip: string): Admission {
    const wait = this.retryAfter(ip);
    if (wait > 0) return { ok: false, retryAfterMs: wait, scope: 'ip' };
    const now = this.now();
    const perMs = 60_000 / this.o.globalPerMin;
    this.tokens = Math.min(this.o.globalBurst, this.tokens + (now - this.last) / perMs);
    this.last = now;
    let waitMs = 0;
    if (this.tokens < 1) {
      waitMs = Math.ceil((1 - this.tokens) * perMs);
      if (waitMs > this.o.maxWaitMs) return { ok: false, retryAfterMs: waitMs - this.o.maxWaitMs, scope: 'global' };
    }
    this.tokens -= 1; // 名额不足时透支：排在前面的请求先用补上的名额
    this.pending.set(ip, (this.pending.get(ip) ?? 0) + 1);
    return { ok: true, waitMs };
  }

  /** 一次放行的验证结束（无论成败、是否抛错）：释放在途名额 */
  release(ip: string): void {
    const n = (this.pending.get(ip) ?? 0) - 1;
    if (n > 0) this.pending.set(ip, n);
    else this.pending.delete(ip);
  }

  /** 记一次失败；返回该 IP 的累计失败次数，以及是否触发全局告警 */
  fail(ip: string): { fails: number; alarm: boolean } {
    const now = this.now();
    if (++this.ops % 256 === 0) this.prune();
    const s = this.state(ip, now) ?? { fails: 0, lastFail: now, nextAt: now };
    s.fails += 1;
    s.lastFail = now;
    s.nextAt = now + this.delayFor(s.fails);
    this.ips.set(ip, s);
    if (now - this.windowStart >= 60_000) {
      this.windowStart = now;
      this.windowFails = 0;
    }
    this.windowFails += 1;
    return { fails: s.fails, alarm: this.windowFails === this.o.alarmPerMin };
  }

  success(ip: string): void {
    this.ips.delete(ip);
  }

  prune(): void {
    const now = this.now();
    for (const [ip, s] of this.ips) if (now - s.lastFail > this.o.failWindowMs) this.ips.delete(ip);
  }

  get trackedIps(): number {
    return this.ips.size;
  }
}
