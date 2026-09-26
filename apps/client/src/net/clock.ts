// 服务器时钟偏移（design/net.md §4.7）：每 15 秒 time:ping，offset = serverNow + rtt/2 − now，取最近 5 次的中位数；
// 还没有样本时，用 batch / snapshot 带的 serverNow 做粗校准。倒计时显示 deadlineAt − serverNow()。
// 只在连接打开时采样（ready）：未连接时发 ping 要先等握手，t0 之后的等待会被算进 RTT，偏移偏大 RTT_connect/2；
// 连上后 burst 连续补采几次，尽快得到可信的中位数。

export const PING_INTERVAL_MS = 15_000;
export const CLOCK_SAMPLES = 5;

export interface ClockSample {
  rtt: number;
  offset: number;
}

export type PingFn = (t0: number) => Promise<{ t0: number; serverNow: number } | null>;

export class ClockSync {
  private samples: ClockSample[] = [];
  private coarseOffset: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(offset: number, rtt: number | null) => void>();

  constructor(
    private readonly ping: PingFn,
    private readonly now: () => number = () => Date.now(),
    private readonly intervalMs = PING_INTERVAL_MS,
    /** 连接已打开（可以立即发出 ping）；缺省总是 true */
    private readonly ready: () => boolean = () => true,
  ) {}

  /** 当前偏移（ms）：serverNow ≈ now() + offset */
  get offsetMs(): number {
    if (this.samples.length > 0) return median(this.samples.map((s) => s.offset));
    return this.coarseOffset ?? 0;
  }

  get rttMs(): number | null {
    if (this.samples.length === 0) return null;
    return median(this.samples.map((s) => s.rtt));
  }

  get sampleCount(): number {
    return this.samples.length;
  }

  serverNow(): number {
    return this.now() + this.offsetMs;
  }

  /** 距离截止时间的剩余毫秒（null 表示不限时） */
  remainingMs(deadlineAt: number | null): number | null {
    if (deadlineAt === null) return null;
    return Math.max(0, deadlineAt - this.serverNow());
  }

  onChange(cb: (offset: number, rtt: number | null) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** 记录一次 ping 往返 */
  addSample(t0: number, serverNow: number, t1: number): void {
    const rtt = Math.max(0, t1 - t0);
    const offset = serverNow + rtt / 2 - t1;
    this.samples.push({ rtt, offset });
    if (this.samples.length > CLOCK_SAMPLES) this.samples.shift();
    this.notify();
  }

  /** 粗校准：只在没有 ping 样本时使用（消息里的 serverNow 未扣除单程延迟） */
  coarse(serverNow: number): void {
    if (this.samples.length > 0) return;
    this.coarseOffset = serverNow - this.now();
    this.notify();
  }

  /** 采一次样；连接未打开时跳过（返回 false） */
  async sampleOnce(): Promise<boolean> {
    if (!this.ready()) return false;
    const t0 = this.now();
    try {
      const r = await this.ping(t0);
      if (!r) return false;
      this.addSample(r.t0, r.serverNow, this.now());
      return true;
    } catch {
      // 忽略：下次再试
      return false;
    }
  }

  /** 连续采 n 次（连上之后调用）；中途失败就停 */
  async burst(n: number): Promise<void> {
    for (let i = 0; i < n; i++) if (!(await this.sampleOnce())) return;
  }

  start(): void {
    if (this.timer) return;
    void this.sampleOnce();
    this.timer = setInterval(() => void this.sampleOnce(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private notify(): void {
    const o = this.offsetMs;
    const r = this.rttMs;
    for (const l of [...this.listeners]) l(o, r);
  }
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
