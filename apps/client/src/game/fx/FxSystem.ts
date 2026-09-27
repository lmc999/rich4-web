// 特效系统（design/client.md §3.3 fx / overlay / screenFx 层、§8 画质档）：
// 统一管理进行中的特效节点（clear() 立即销毁）、粒子预算（高 400 / 中 150 / 低 0，只保留关键闪光），
// 并把各类特效（飘字、金币、插旗、爆炸、光柱、光束、闪屏、倒带……）暴露为方法。全部由 AnimClock 驱动。
import { type Container, Graphics } from 'pixi.js';
import type { AnimClock } from '../anim/AnimClock';
import { backOut, type Ease, linear, quadInOut } from '../anim/easing';
import { tweenValue } from '../anim/tween';
import { diamondPoints, type Pt } from '../iso/projection';
import { INK, PLAYER_COLORS } from '../procedural/building/styles';
import { beam } from './Beam';
import { explosion, missileStrike, nukeStrike, shockwave } from './Explosion';
import { bubble, type FloatTone, floatText } from './FloatingText';
import { lightPillar, magicCircle } from './LightPillar';
import { ParticleBudget, Particles, radial } from './Particles';
import { fireworks, rewind, screenFlash } from './ScreenFlash';
import { COIN_COUNT, COIN_MS, COIN_STAGGER_MS, FLAG_MS, PARTICLE_LIMITS } from './timings';

export type { FloatTone } from './FloatingText';

/** 特效模块共用的宿主能力（Explosion / LightPillar / Beam / ScreenFlash 只依赖它） */
export interface FxHost {
  readonly clock: AnimClock;
  readonly overlay: Container;
  readonly fxLayer: Container;
  /** 全屏层（不受镜头影响）；未接入时为 null，全屏效果退化为不显示 */
  readonly screen: Container | null;
  readonly particles: Particles;
  readonly screenParticles: Particles | null;
  screenSize(): { width: number; height: number };
  /** 登记一个特效节点：挂到 parent，clear() 或外部 signal 中止时销毁 */
  track(node: Container, parent: Container, outer?: AbortSignal): { signal: AbortSignal; done: () => void };
  /** 由时钟驱动的 0→1 补间 */
  tween(ms: number, apply: (v: number) => void, signal?: AbortSignal, ease?: Ease): Promise<void>;
  wait(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface FxSystemOptions {
  /** 粒子上限（画质档）；缺省高画质 400 */
  particles?: number;
}

export class FxSystem implements FxHost {
  private readonly live = new Set<{ node: Container; abort: AbortController }>();
  readonly particles: Particles;
  readonly budget: ParticleBudget;
  private _screen: Container | null = null;
  private _screenParticles: Particles | null = null;
  private sizeOf: () => { width: number; height: number } = () => ({ width: 1280, height: 720 });

  constructor(
    readonly overlay: Container,
    readonly fxLayer: Container,
    readonly clock: AnimClock,
    o: FxSystemOptions = {},
  ) {
    this.budget = new ParticleBudget(o.particles ?? PARTICLE_LIMITS.high);
    this.particles = new Particles(fxLayer, clock, this.budget);
  }

  get screen(): Container | null {
    return this._screen && !this._screen.destroyed ? this._screen : null;
  }

  get screenParticles(): Particles | null {
    return this.screen ? this._screenParticles : null;
  }

  /** 接入全屏层（闪白、倒带、烟花）；BoardStage 创建时调用 */
  attachScreen(layer: Container, size: () => { width: number; height: number }): void {
    if (this._screen === layer) return;
    this._screen = layer;
    this.sizeOf = size;
    this._screenParticles = new Particles(layer, this.clock, this.budget);
  }

  screenSize(): { width: number; height: number } {
    return this.sizeOf();
  }

  /** 画质档：粒子上限（低画质 0，只保留关键闪光） */
  setParticleLimit(n: number): void {
    this.budget.limit = n;
  }

  get particleLimit(): number {
    return this.budget.limit;
  }

  /** 进行中的特效节点数 */
  get count(): number {
    return this.live.size;
  }

  /** 存活粒子数（棋盘层 + 屏幕层） */
  get particleCount(): number {
    return this.budget.used;
  }

  track(node: Container, parent: Container, outer?: AbortSignal): { signal: AbortSignal; done: () => void } {
    const abort = new AbortController();
    const entry = { node, abort };
    parent.addChild(node);
    this.live.add(entry);
    const onOuter = (): void => abort.abort();
    if (outer?.aborted) abort.abort();
    else outer?.addEventListener('abort', onOuter, { once: true });
    return {
      signal: abort.signal,
      done: () => {
        outer?.removeEventListener('abort', onOuter);
        if (!this.live.delete(entry)) return;
        if (!node.destroyed) node.destroy({ children: true });
      },
    };
  }

  tween(ms: number, apply: (v: number) => void, signal?: AbortSignal, ease: Ease = linear): Promise<void> {
    return tweenValue(0, 1, ms, (v) => apply(v), { clock: this.clock, signal, ease });
  }

  wait(ms: number, signal?: AbortSignal): Promise<void> {
    return this.clock.wait(ms, signal);
  }

  // ───────────────────────── M3：飘字、金币、插旗、脉冲 ─────────────────────────

  /** 飘字：从 at 往上飘并淡出（不阻塞） */
  floatText(at: Pt, text: string, tone: FloatTone): void {
    floatText(this, at, text, tone);
  }

  /** 头顶气泡（不阻塞） */
  bubble(at: Pt, text: string, ms: number): void {
    bubble(this, at, text, ms);
  }

  /** 金币从 a 飞向 b（贝塞尔曲线），全部落地后 resolve */
  async coinFlight(a: Pt, b: Pt, signal?: AbortSignal): Promise<void> {
    const ctrl = { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - 110 - Math.abs(a.x - b.x) * 0.15 };
    const runs: Promise<void>[] = [];
    for (let i = 0; i < COIN_COUNT; i++) {
      const g = new Graphics().circle(0, 0, 8).fill(0xffd84d).stroke({ width: 2.5, color: INK });
      g.circle(-2, -2, 3).fill(0xfff3b0);
      g.position.set(a.x, a.y);
      g.visible = false;
      const h = this.track(g, this.fxLayer, signal);
      const jitter = (i - COIN_COUNT / 2) * 3;
      runs.push(
        this.clock
          .wait(i * COIN_STAGGER_MS, h.signal)
          .then(() => {
            // clear() / 中止之后节点已销毁（Pixi 把 position 置空）：直接收尾
            if (g.destroyed || h.signal.aborted) return;
            g.visible = true;
            return tweenValue(
              0,
              1,
              COIN_MS,
              (v) => {
                if (g.destroyed) return;
                const u = 1 - v;
                g.position.set(
                  u * u * a.x + 2 * u * v * (ctrl.x + jitter) + v * v * b.x,
                  u * u * a.y + 2 * u * v * ctrl.y + v * v * b.y,
                );
                g.scale.set(1 - 0.3 * v);
              },
              { clock: this.clock, signal: h.signal, ease: quadInOut },
            );
          })
          .then(h.done),
      );
    }
    await Promise.all(runs);
  }

  /** 插旗：旗子落下弹一下，停留片刻后淡出；落定时 resolve */
  async plantFlag(at: Pt, seat: number, signal?: AbortSignal): Promise<void> {
    const color = PLAYER_COLORS[seat % 4] ?? 0xffffff;
    const g = new Graphics();
    g.rect(-2, -58, 4, 58).fill(INK);
    g.poly([2, -58, 34, -48, 2, -38], true).fill(color).stroke({ width: 3, color: INK, join: 'round' });
    g.ellipse(0, 0, 10, 4).fill({ color: 0x000000, alpha: 0.25 });
    const h = this.track(g, this.overlay, signal);
    g.position.set(at.x, at.y - 70);
    await tweenValue(0, 1, FLAG_MS, (v) => g.position.set(at.x, at.y - 70 * (1 - v)), {
      clock: this.clock,
      signal: h.signal,
      ease: backOut,
    });
    void this.clock
      .wait(520, h.signal)
      .then(() =>
        tweenValue(
          1,
          0,
          260,
          (v) => {
            g.alpha = v;
          },
          { clock: this.clock, signal: h.signal },
        ),
      )
      .then(h.done);
  }

  /** 格子脉冲：菱形光圈放大淡出（不阻塞） */
  pulse(view: Pt, color = 0xffffff): void {
    const g = new Graphics().poly(diamondPoints(-0.5, -0.5, 0.02), true).stroke({ width: 4, color, join: 'round' });
    const h = this.track(g, this.fxLayer);
    void tweenValue(
      0,
      1,
      420,
      (v) => {
        g.position.set(view.x, view.y);
        g.alpha = 1 - v;
        g.scale.set(1 + 0.35 * v);
      },
      { clock: this.clock, signal: h.signal },
    ).then(h.done);
  }

  // ───────────────────────── M6 / M7 ─────────────────────────

  explosion(at: Pt, size: 'small' | 'big', signal?: AbortSignal): Promise<void> {
    return explosion(this, at, size, signal);
  }

  shockwave(at: Pt, radius: number, color: number, ms: number, signal?: AbortSignal): Promise<void> {
    return shockwave(this, at, radius, color, ms, signal);
  }

  /** 飞弹从天而降，落地爆炸 + 冲击波（radius：冲击范围像素） */
  missile(at: Pt, radius: number, signal?: AbortSignal): Promise<void> {
    return missileStrike(this, at, radius, signal);
  }

  /** 核弹：落下 → 全屏白闪 → 蘑菇云 + 大冲击波 */
  nuke(at: Pt, radius: number, signal?: AbortSignal): Promise<void> {
    return nukeStrike(this, at, radius, signal);
  }

  lightPillar(at: Pt, color: number, ms: number, signal?: AbortSignal): Promise<void> {
    return lightPillar(this, at, color, ms, signal);
  }

  magicCircle(at: Pt, color: number, ms: number, signal?: AbortSignal): Promise<void> {
    return magicCircle(this, at, color, ms, signal);
  }

  beam(a: Pt, b: Pt, color: number, ms: number, signal?: AbortSignal): Promise<void> {
    return beam(this, a, b, color, ms, signal);
  }

  /** 全屏闪光（不阻塞） */
  screenFlash(color: number, ms: number, peak = 0.85): void {
    void screenFlash(this, color, ms, peak);
  }

  /** 倒带：棕褐色滤镜 + 扫描线 + 倒带符号；target 为要加滤镜的容器（world） */
  rewind(ms: number, target: Container | null, signal?: AbortSignal): Promise<void> {
    return rewind(this, ms, target, signal);
  }

  /** 烟花（屏幕层，不阻塞） */
  fireworks(ms: number): void {
    fireworks(this, ms);
  }

  /** 小粒子喷发（闪光、尘土） */
  sparkles(at: Pt, color: number, count = 14): void {
    this.particles.emit(
      radial(at.x, at.y, count, {
        speed: [60, 180],
        life: [380, 680],
        size: [6, 12],
        colors: [color, 0xffffff],
        shape: 'star',
        gravity: 120,
        drag: 1.2,
        spin: 4,
      }),
    );
  }

  /** 立即结束并销毁全部特效与粒子 */
  clear(): void {
    for (const e of [...this.live]) e.abort.abort();
    for (const e of [...this.live]) {
      this.live.delete(e);
      if (!e.node.destroyed) e.node.destroy({ children: true });
    }
    this.particles.clear();
    this._screenParticles?.clear();
  }
}
