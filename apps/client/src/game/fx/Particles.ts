// 粒子池（design/client.md §8）：全局上限按画质档（高 400 / 中 150 / 低 0），超出的粒子直接不发。
// 每个粒子是一个共享 GraphicsContext 的 Graphics（圆点、方块碎片、四角星、烟团），只改位置 / 缩放 / 透明度 / tint，
// 由 AnimClock 的帧回调推进（倍速、instant 与假时钟都一致）；有存活粒子时才挂帧回调。
import { type Container, Graphics, GraphicsContext } from 'pixi.js';
import type { AnimClock } from '../anim/AnimClock';
import { PARTICLE_LIMITS } from './timings';

export type ParticleShape = 'dot' | 'square' | 'star' | 'smoke';

export interface ParticleSpec {
  x: number;
  y: number;
  /** 速度（像素 / 秒） */
  vx: number;
  vy: number;
  /** 寿命（时钟毫秒） */
  life: number;
  /** 直径（像素） */
  size: number;
  color: number;
  shape?: ParticleShape;
  /** 重力（像素 / 秒²，向下为正） */
  gravity?: number;
  /** 每秒速度衰减比例（0..1） */
  drag?: number;
  /** 结束时的缩放倍数（烟团变大、火星变小） */
  endScale?: number;
  /** 旋转速度（弧度 / 秒） */
  spin?: number;
}

interface Live {
  g: Graphics;
  s: Required<Omit<ParticleSpec, 'shape'>>;
  age: number;
  baseScale: number;
}

let contexts: Record<ParticleShape, GraphicsContext> | null = null;

/** 共享几何（首次使用时建；直径按 16 像素画，缩放到 size） */
function shapes(): Record<ParticleShape, GraphicsContext> {
  if (!contexts) {
    const star = new GraphicsContext()
      .poly([0, -8, 2.2, -2.2, 8, 0, 2.2, 2.2, 0, 8, -2.2, 2.2, -8, 0, -2.2, -2.2], true)
      .fill(0xffffff);
    contexts = {
      dot: new GraphicsContext().circle(0, 0, 8).fill(0xffffff),
      square: new GraphicsContext().rect(-8, -8, 16, 16).fill(0xffffff),
      star,
      smoke: new GraphicsContext().circle(0, 0, 8).fill({ color: 0xffffff, alpha: 0.55 }),
    };
  }
  return contexts;
}

/** 几个粒子池共用的上限（棋盘层与屏幕层合计不超过画质档的上限） */
export class ParticleBudget {
  used = 0;
  private _limit: number;
  private readonly pools = new Set<Particles>();

  constructor(limit: number = PARTICLE_LIMITS.high) {
    this._limit = Math.max(0, Math.floor(limit));
  }

  get limit(): number {
    return this._limit;
  }

  /** 画质档变化：超出新上限的粒子立即回收 */
  set limit(n: number) {
    this._limit = Math.max(0, Math.floor(n));
    for (const p of this.pools) p.trim();
  }

  get room(): number {
    return Math.max(0, this._limit - this.used);
  }

  /** @internal */
  register(p: Particles): void {
    this.pools.add(p);
  }
}

export class Particles {
  private readonly live: Live[] = [];
  private off: (() => void) | null = null;
  readonly budget: ParticleBudget;

  constructor(
    private readonly layer: Container,
    private readonly clock: AnimClock,
    budget: ParticleBudget | number = PARTICLE_LIMITS.high,
  ) {
    this.budget = typeof budget === 'number' ? new ParticleBudget(budget) : budget;
    this.budget.register(this);
  }

  get limit(): number {
    return this.budget.limit;
  }

  get count(): number {
    return this.live.length;
  }

  /** 还能发多少粒子（与同一预算的其他池合计） */
  get room(): number {
    return this.budget.room;
  }

  /** @internal 预算下调后回收超出的粒子 */
  trim(): void {
    while (this.live.length > 0 && this.budget.used > this.budget.limit) this.kill(this.live.length - 1);
  }

  /** 发射粒子（超出上限的部分丢弃）；返回实际发出的数量。instant 模式下不发 */
  emit(specs: readonly ParticleSpec[]): number {
    if (this.clock.instant || this.layer.destroyed) return 0;
    const n = Math.min(specs.length, this.room);
    if (n <= 0) return 0;
    const ctx = shapes();
    for (let i = 0; i < n; i++) {
      const sp = specs[i]!;
      const g = new Graphics(ctx[sp.shape ?? 'dot']);
      g.tint = sp.color;
      const baseScale = sp.size / 16;
      g.scale.set(baseScale);
      g.position.set(sp.x, sp.y);
      this.layer.addChild(g);
      this.budget.used++;
      this.live.push({
        g,
        s: {
          x: sp.x,
          y: sp.y,
          vx: sp.vx,
          vy: sp.vy,
          life: Math.max(1, sp.life),
          size: sp.size,
          color: sp.color,
          gravity: sp.gravity ?? 0,
          drag: sp.drag ?? 0,
          endScale: sp.endScale ?? 0.3,
          spin: sp.spin ?? 0,
        },
        age: 0,
        baseScale,
      });
    }
    if (!this.off) this.off = this.clock.onFrame((_now, dt) => this.step(dt));
    return n;
  }

  clear(): void {
    while (this.live.length > 0) this.kill(this.live.length - 1);
    this.off?.();
    this.off = null;
  }

  private step(dt: number): void {
    const sec = dt / 1000;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i]!;
      p.age += dt;
      if (p.age >= p.s.life || p.g.destroyed) {
        this.kill(i);
        continue;
      }
      const s = p.s;
      if (s.drag > 0) {
        const k = Math.max(0, 1 - s.drag * sec);
        s.vx *= k;
        s.vy *= k;
      }
      s.vy += s.gravity * sec;
      s.x += s.vx * sec;
      s.y += s.vy * sec;
      const t = p.age / s.life;
      p.g.position.set(s.x, s.y);
      p.g.scale.set(p.baseScale * (1 + (s.endScale - 1) * t));
      p.g.alpha = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
      if (s.spin !== 0) p.g.rotation += s.spin * sec;
    }
    if (this.live.length === 0) {
      this.off?.();
      this.off = null;
    }
  }

  private kill(i: number): void {
    const [p] = this.live.splice(i, 1);
    if (!p) return;
    this.budget.used = Math.max(0, this.budget.used - 1);
    if (!p.g.destroyed) p.g.destroy();
  }
}

/** 均匀分布的放射状粒子（爆炸碎片、闪光） */
export function radial(
  x: number,
  y: number,
  count: number,
  o: {
    speed: [number, number];
    life: [number, number];
    size: [number, number];
    colors: readonly number[];
    shape?: ParticleShape;
    gravity?: number;
    drag?: number;
    endScale?: number;
    /** 纵向压扁（等角地面上的扩散） */
    squash?: number;
    spin?: number;
  },
  rand: () => number = pseudoRandom(x * 31 + y * 17 + count),
): ParticleSpec[] {
  const out: ParticleSpec[] = [];
  const lerp = (r: [number, number]): number => r[0] + (r[1] - r[0]) * rand();
  for (let i = 0; i < count; i++) {
    const a = ((i + rand() * 0.8) / count) * Math.PI * 2;
    const v = lerp(o.speed);
    out.push({
      x,
      y,
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v * (o.squash ?? 1),
      life: lerp(o.life),
      size: lerp(o.size),
      color: o.colors[i % o.colors.length] ?? 0xffffff,
      shape: o.shape ?? 'dot',
      gravity: o.gravity ?? 0,
      drag: o.drag ?? 0,
      endScale: o.endScale ?? 0.3,
      spin: o.spin ?? 0,
    });
  }
  return out;
}

/** 演出用的小伪随机（与规则无关；固定种子让截图基线稳定） */
export function pseudoRandom(seed: number): () => number {
  let s = Math.floor(Math.abs(seed)) % 2147483647 || 1;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}
