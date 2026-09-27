// 定步循环（design/minigames-ai.md §2.2、§7.1；client.md §9 按 architecture 修订）：逻辑 tick = 原版定时器周期
// （企鹅 / 气球 100ms，喜从天降 50ms），渲染在相邻两个 tick 之间按 alpha 插值。
// 时间轴按服务器时间对齐：第 t 次 step 在 startsAt + (t+1)×tickMs 完成；inputsFor(t) 提供第 t 次 step 之前生效的输入。
// 与 DOM、Pixi 无关，便于单测；MiniGameHost 每帧调用 advance / alpha。
import type { InputEvent, MinigameParams, MinigameSim, SimBase, SimFx } from '@rich4/shared/minigames';

/** 每帧最多补多少个 tick（页面回到前台时分几帧追上） */
export const MAX_CATCH_UP = 10;

export interface FixedStepOptions {
  tickMs: number;
  /** 第 0 个 tick 开始的服务器时间 */
  startsAt: number;
  maxCatchUp?: number;
}

export class FixedStepLoop<S extends SimBase> {
  /** 上一次 step 之前的状态（插值起点；回滚一步时从它重算） */
  prev: S;
  /** 当前状态（已完成 curr.tick 次 step） */
  curr: S;
  /** 上一次 step 用的输入（回滚重算时替换） */
  private lastInputs: readonly InputEvent[] = [];
  /** 自上次 drainFx 以来的表现提示 */
  private fxBuf: SimFx[] = [];
  readonly tickMs: number;
  startsAt: number;
  private readonly maxCatchUp: number;

  constructor(
    readonly sim: MinigameSim<S>,
    readonly seed: number,
    readonly params: MinigameParams,
    o: FixedStepOptions,
  ) {
    this.tickMs = o.tickMs;
    this.startsAt = o.startsAt;
    this.maxCatchUp = o.maxCatchUp ?? MAX_CATCH_UP;
    this.curr = sim.init(seed, params);
    this.prev = sim.clone(this.curr);
  }

  get over(): boolean {
    return this.sim.isOver(this.curr);
  }

  /** 还能不能再 step（未结束且未到硬上限） */
  get canStep(): boolean {
    return !this.sim.isOver(this.curr) && this.curr.tick < this.sim.spec.maxTicks;
  }

  /** 服务器时间 now 时应当完成的 step 数（不超过 maxTicks；开局前为 0） */
  targetTick(now: number): number {
    const t = Math.floor((now - this.startsAt) / this.tickMs);
    return Math.max(0, Math.min(this.sim.spec.maxTicks, t));
  }

  /** 推进一步（inputs 必须全部是 curr.tick 的输入） */
  step(inputs: readonly InputEvent[]): void {
    if (!this.canStep) return;
    this.prev = this.sim.clone(this.curr);
    this.lastInputs = inputs;
    this.sim.step(this.curr, inputs);
    if (this.curr.fx.length > 0) this.fxBuf.push(...this.curr.fx);
  }

  /**
   * 追到 target（最多 maxCatchUp 步）：beforeStep(t) 可以在 step 前记录本 tick 的输入（例如喜从天降的光标），
   * inputsFor(t) 返回第 t 次 step 的输入。返回本次推进的步数。
   */
  advanceTo(
    target: number,
    inputsFor: (tick: number) => readonly InputEvent[],
    beforeStep?: (tick: number) => void,
  ): number {
    let n = 0;
    while (this.curr.tick < target && n < this.maxCatchUp && this.canStep) {
      beforeStep?.(this.curr.tick);
      this.step(inputsFor(this.curr.tick));
      n++;
    }
    return n;
  }

  /** 按服务器时间推进 */
  advance(
    now: number,
    inputsFor: (tick: number) => readonly InputEvent[],
    beforeStep?: (tick: number) => void,
  ): number {
    return this.advanceTo(this.targetTick(now), inputsFor, beforeStep);
  }

  /** 插值系数：当前 tick 内已经过去的比例（0..1） */
  alpha(now: number): number {
    if (!this.canStep) return 1;
    const a = (now - this.startsAt - this.curr.tick * this.tickMs) / this.tickMs;
    return a <= 0 ? 0 : a >= 1 ? 1 : a;
  }

  /**
   * 「最近 tick 归属」：用新的输入集合重算上一步（从 prev 重算 curr）。
   * 只补发新增的表现提示（与原来那一步相比多出来的部分）。要求 curr.tick ≥ 1。
   */
  redoLast(inputs: readonly InputEvent[]): void {
    if (this.curr.tick === 0 || this.prev.tick !== this.curr.tick - 1) return;
    const before = this.curr.fx.map((f) => JSON.stringify(f));
    const s = this.sim.clone(this.prev);
    this.sim.step(s, inputs);
    this.lastInputs = inputs;
    this.curr = s;
    const pool = new Map<string, number>();
    for (const k of before) pool.set(k, (pool.get(k) ?? 0) + 1);
    for (const f of s.fx) {
      const k = JSON.stringify(f);
      const n = pool.get(k) ?? 0;
      if (n > 0) pool.set(k, n - 1);
      else this.fxBuf.push(f);
    }
  }

  /** 上一步用的输入 */
  get previousInputs(): readonly InputEvent[] {
    return this.lastInputs;
  }

  /** 取走累计的表现提示 */
  drainFx(): SimFx[] {
    const out = this.fxBuf;
    this.fxBuf = [];
    return out;
  }

  /** 从头重放到 tick（观战时收到迟到的输入）：表现提示丢弃 */
  rebuild(tick: number, inputsFor: (tick: number) => readonly InputEvent[]): void {
    this.curr = this.sim.init(this.seed, this.params);
    this.prev = this.sim.clone(this.curr);
    this.lastInputs = [];
    while (this.curr.tick < tick && this.canStep) this.step(inputsFor(this.curr.tick));
    this.fxBuf = [];
  }
}
