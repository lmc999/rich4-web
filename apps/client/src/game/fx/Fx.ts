// 棋盘小特效（design/client.md §3.3 fx / overlay 层）：飘字、金币飞行、插旗、格子脉冲。
// 全部由 AnimClock 驱动（倍速、中止、instant 即刻完成）；clear() 立即销毁所有进行中的特效。
import { type Container, Graphics, Text } from 'pixi.js';
import type { AnimClock } from '../anim/AnimClock';
import { backOut, cubicOut, linear, quadInOut } from '../anim/easing';
import { tweenValue } from '../anim/tween';
import { diamondPoints, type Pt } from '../iso/projection';
import { INK, PLAYER_COLORS } from '../procedural/building/styles';
import { COIN_COUNT, COIN_MS, COIN_STAGGER_MS, FLAG_MS, FLOAT_MS } from './timings';

export type FloatTone = 'gain' | 'loss' | 'info' | 'points';

const TONE_FILL: Record<FloatTone, number> = {
  gain: 0x5cc85a,
  loss: 0xf2545b,
  info: 0xffffff,
  points: 0xffd84d,
};

export { COIN_COUNT, COIN_MS, COIN_STAGGER_MS, FLAG_MS, FLOAT_MS } from './timings';

export class Fx {
  private readonly live = new Set<{ node: Container; abort: AbortController }>();

  constructor(
    private readonly overlay: Container,
    private readonly fxLayer: Container,
    private readonly clock: AnimClock,
  ) {}

  get count(): number {
    return this.live.size;
  }

  private track(node: Container, parent: Container, outer?: AbortSignal): { signal: AbortSignal; done: () => void } {
    const abort = new AbortController();
    const entry = { node, abort };
    parent.addChild(node);
    this.live.add(entry);
    const onOuter = (): void => abort.abort();
    outer?.addEventListener('abort', onOuter, { once: true });
    return {
      signal: abort.signal,
      done: () => {
        outer?.removeEventListener('abort', onOuter);
        if (!this.live.delete(entry)) return;
        if (!node.destroyed) node.destroy({ children: true });
      },
    };
  }

  /** 飘字：从 at 往上飘并淡出（不阻塞） */
  floatText(at: Pt, text: string, tone: FloatTone): void {
    const t = new Text({
      text,
      style: {
        fontFamily: '"Fredoka", "ZCOOL KuaiLe", sans-serif',
        fontSize: 26,
        fontWeight: '600',
        fill: TONE_FILL[tone],
        stroke: { color: INK, width: 5 },
      },
      resolution: 2,
    });
    t.anchor.set(0.5, 1);
    t.position.set(at.x, at.y);
    const h = this.track(t, this.overlay);
    void tweenValue(
      0,
      1,
      FLOAT_MS,
      (v) => {
        t.position.y = at.y - 46 * cubicOut(v);
        t.alpha = v < 0.6 ? 1 : 1 - (v - 0.6) / 0.4;
        t.scale.set(v < 0.15 ? 0.6 + (v / 0.15) * 0.4 : 1);
      },
      { clock: this.clock, signal: h.signal, ease: linear },
    ).then(h.done);
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
            g.visible = true;
            return tweenValue(
              0,
              1,
              COIN_MS,
              (v) => {
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

  /** 立即结束并销毁全部特效 */
  clear(): void {
    for (const e of [...this.live]) e.abort.abort();
    for (const e of [...this.live]) {
      this.live.delete(e);
      if (!e.node.destroyed) e.node.destroy({ children: true });
    }
  }
}
