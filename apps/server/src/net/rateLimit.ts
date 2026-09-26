/**
 * 令牌桶限流（design/net.md §4.8；额度常量在 shared/net/limits.ts，客户端引用同一份）。
 * 按会话（tokenHash）+ 分组计：断开重连不会重置额度（同一 token 的多个连接共用一个桶）；
 * 另有按 IP 的 room:join / room:resume 失败与 room:create 限额。空闲的桶早已补满，由 prune 统一清理。
 */
import {
  type C2SEventName,
  CREATE_ROOM_PER_IP_PER_MIN,
  JOIN_FAIL_PER_IP_PER_MIN,
  RATE_LIMITS,
  type RateRule,
} from '@rich4/shared/net';

export class TokenBucket {
  private tokens: number;
  private last: number;

  /** 最近一次补充的时间（清理空闲桶用） */
  get lastSeen(): number {
    return this.last;
  }

  constructor(
    private readonly rule: RateRule,
    now: number,
  ) {
    this.tokens = rule.burst;
    this.last = now;
  }

  private refill(now: number): void {
    const dt = Math.max(0, now - this.last);
    this.last = now;
    this.tokens = Math.min(this.rule.burst, this.tokens + (dt * this.rule.count) / this.rule.perMs);
  }

  /** 取 1 个令牌；不够时返回 false（不扣） */
  take(now: number): boolean {
    this.refill(now);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** 只查询，不扣 */
  peek(now: number): boolean {
    this.refill(now);
    return this.tokens >= 1;
  }
}

export type BucketGroup = keyof typeof RATE_LIMITS;

/** C2S 事件 → 限流分组；room:*、lobby:*、saves:* 与其余 game:* 共用 room 组 */
export function bucketOf(event: C2SEventName): BucketGroup {
  if (Object.hasOwn(RATE_LIMITS, event)) return event as BucketGroup;
  return 'room';
}

export const IP_RULES = Object.freeze({
  joinFail: { count: JOIN_FAIL_PER_IP_PER_MIN, perMs: 60_000, burst: JOIN_FAIL_PER_IP_PER_MIN },
  create: { count: CREATE_ROOM_PER_IP_PER_MIN, perMs: 60_000, burst: CREATE_ROOM_PER_IP_PER_MIN },
} as const satisfies Record<string, RateRule>);

export interface RateLimiterOptions {
  now?: () => number;
  /** 额度倍率（测试用放宽）；0 表示关闭限流 */
  scale?: number;
}

/** 空闲这么久的桶会被清理（所有规则的补满时间都远小于它，清掉与新建等价） */
const BUCKET_IDLE_MS = 10 * 60_000;

export class RateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly now: () => number;
  private readonly scale: number;
  private ops = 0;

  constructor(o: RateLimiterOptions = {}) {
    this.now = o.now ?? (() => Date.now());
    this.scale = o.scale ?? 1;
  }

  private bucket(key: string, rule: RateRule): TokenBucket {
    if (++this.ops % 256 === 0) this.prune();
    let b = this.buckets.get(key);
    if (!b) {
      const r = this.scale === 1 ? rule : { ...rule, count: rule.count * this.scale, burst: rule.burst * this.scale };
      b = new TokenBucket(r, this.now());
      this.buckets.set(key, b);
    }
    return b;
  }

  /** 按会话（tokenHash）+ 分组取令牌 */
  take(subject: string, group: BucketGroup): boolean {
    if (this.scale === 0) return true;
    return this.bucket(`s:${subject}:${group}`, RATE_LIMITS[group]).take(this.now());
  }

  /** 按 IP 的额度（join 失败只在失败时扣，先用 peek 判断） */
  peekIp(ip: string, kind: keyof typeof IP_RULES): boolean {
    if (this.scale === 0) return true;
    return this.bucket(`ip:${ip}:${kind}`, IP_RULES[kind]).peek(this.now());
  }

  takeIp(ip: string, kind: keyof typeof IP_RULES): boolean {
    if (this.scale === 0) return true;
    return this.bucket(`ip:${ip}:${kind}`, IP_RULES[kind]).take(this.now());
  }

  /** 立即释放某会话的桶（会话被删除时可用；断开连接时不要调用，否则重连即可拿回满额） */
  forget(subject: string): void {
    const prefix = `s:${subject}:`;
    for (const k of this.buckets.keys()) if (k.startsWith(prefix)) this.buckets.delete(k);
  }

  /** 清理空闲超过 10 分钟的桶（会话桶与按 IP 的桶一视同仁） */
  prune(): void {
    const now = this.now();
    for (const [k, b] of this.buckets) if (now - b.lastSeen > BUCKET_IDLE_MS) this.buckets.delete(k);
  }

  get size(): number {
    return this.buckets.size;
  }
}
