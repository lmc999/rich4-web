// 全屏效果（screenFx 层，不受镜头影响）：闪白（核弹）、倒带滤镜（时光机）、终局烟花。
// 没有接入全屏层时（开发页、单测）闪屏与烟花直接跳过，倒带只做计时。
import { ColorMatrixFilter, Container, type Filter, Graphics, Text } from 'pixi.js';
import type { FxHost } from './FxSystem';
import { pseudoRandom, radial } from './Particles';

/** 全屏闪光：瞬间到 peak 透明度，ms 内淡出（signal 已中止时不显示；中止时立即移除） */
export async function screenFlash(
  h: FxHost,
  color: number,
  ms: number,
  peak = 0.85,
  signal?: AbortSignal,
): Promise<void> {
  const layer = h.screen;
  if (!layer || signal?.aborted) return;
  const { width, height } = h.screenSize();
  const g = new Graphics().rect(0, 0, width, height).fill(color);
  g.alpha = peak;
  const k = h.track(g, layer, signal);
  await h.tween(
    ms,
    (v) => {
      if (!g.destroyed) g.alpha = peak * (1 - v) * (1 - v);
    },
    k.signal,
  );
  k.done();
}

/** 棕褐色滤镜（浏览器下可用；node 没有 document 时返回 null） */
function sepiaFilter(): Filter | null {
  if (typeof document === 'undefined') return null;
  try {
    const f = new ColorMatrixFilter();
    f.sepia(false);
    return f;
  } catch {
    return null;
  }
}

/** 倒带：world 加棕褐色滤镜 + 屏幕扫描线与倒带符号，ms 后移除 */
export async function rewind(h: FxHost, ms: number, target: Container | null, signal?: AbortSignal): Promise<void> {
  const layer = h.screen;
  const filter = target ? sepiaFilter() : null;
  const prev = target?.filters ?? null;
  if (target && filter) target.filters = [...(Array.isArray(prev) ? prev : prev ? [prev] : []), filter];
  let k: { signal: AbortSignal; done: () => void } | null = null;
  let lines: Graphics | null = null;
  let icon: Text | null = null;
  if (layer) {
    const { width, height } = h.screenSize();
    lines = new Graphics();
    lines.rect(0, 0, width, height).fill({ color: 0x7a5a2a, alpha: 0.18 });
    for (let y = 0; y < height; y += 6) lines.rect(0, y, width, 2).fill({ color: 0x000000, alpha: 0.12 });
    icon = new Text({
      text: '⏪',
      style: { fontSize: 96, fill: 0xffffff, stroke: { color: 0x3a2a1a, width: 8 } },
      resolution: 2,
    });
    icon.anchor.set(0.5);
    icon.position.set(width / 2, height / 2);
    lines.addChild(icon);
    k = h.track(lines, layer, signal);
  }
  try {
    await h.tween(
      ms,
      (v) => {
        if (lines && !lines.destroyed) {
          lines.alpha = v < 0.15 ? v / 0.15 : v > 0.8 ? (1 - v) / 0.2 : 1;
          // 画面抖动模拟磁带回卷
          lines.position.set(Math.sin(v * 80) * 3, 0);
        }
        if (icon && !icon.destroyed) icon.scale.set(1 + 0.08 * Math.sin(v * 30));
      },
      k?.signal ?? signal,
    );
  } finally {
    k?.done();
    if (target && filter && !target.destroyed) {
      target.filters = (Array.isArray(target.filters) ? target.filters : []).filter((f) => f !== filter);
      filter.destroy();
    }
  }
}

/** 烟花：屏幕上方随机位置依次爆开（不阻塞） */
export function fireworks(h: FxHost, ms: number): void {
  const pool = h.screenParticles;
  if (!pool) return;
  const { width, height } = h.screenSize();
  const rand = pseudoRandom(width * 7 + height);
  const colors = [
    [0xf2545b, 0xffd84d],
    [0x3d8bfd, 0xbfe8ff],
    [0x5cc85a, 0xfff3b0],
    [0x9b6bff, 0xffffff],
    [0xff9f43, 0xffd84d],
  ] as const;
  const shots = 7;
  // 空节点只用来拿到「clear() 时中止」的信号
  const k = h.track(new Container({ label: 'fireworks' }), h.screen ?? h.fxLayer);
  void h.wait(ms, k.signal).then(k.done);
  for (let i = 0; i < shots; i++) {
    void h.wait((i * ms * 0.7) / shots, k.signal).then(() => {
      if (h.screen === null || k.signal.aborted) return;
      const x = width * (0.15 + 0.7 * rand());
      const y = height * (0.12 + 0.35 * rand());
      pool.emit(
        radial(
          x,
          y,
          36,
          {
            speed: [120, 300],
            life: [700, 1100],
            size: [6, 10],
            colors: colors[i % colors.length]!,
            gravity: 160,
            drag: 1.1,
            endScale: 0.4,
          },
          rand,
        ),
      );
    });
  }
}
