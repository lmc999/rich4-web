// 飘字、头顶气泡与数字标签（design/client.md §3.3 overlay 层）。
// 飘字 / 气泡用 Text（中文）；频繁变化的数字（定时炸弹引信、倒数）用 BitmapText（动态位图字体，首次使用时生成）。
import { BitmapText, Container, Graphics, Text } from 'pixi.js';
import { cubicOut, linear } from '../anim/easing';
import type { Pt } from '../iso/projection';
import { INK } from '../procedural/building/styles';
import type { FxHost } from './FxSystem';
import { FLOAT_MS } from './timings';

export type FloatTone = 'gain' | 'loss' | 'info' | 'points';

export const TONE_FILL: Record<FloatTone, number> = {
  gain: 0x5cc85a,
  loss: 0xf2545b,
  info: 0xffffff,
  points: 0xffd84d,
};

const NUM_FONT = '"Fredoka", "ZCOOL KuaiLe", sans-serif';

/** 飘字：从 at 往上飘并淡出（不阻塞） */
export function floatText(h: FxHost, at: Pt, text: string, tone: FloatTone): void {
  const t = new Text({
    text,
    style: {
      fontFamily: NUM_FONT,
      fontSize: 26,
      fontWeight: '600',
      fill: TONE_FILL[tone],
      stroke: { color: INK, width: 5 },
    },
    resolution: 2,
  });
  t.anchor.set(0.5, 1);
  t.position.set(at.x, at.y);
  const k = h.track(t, h.overlay);
  void h
    .tween(
      FLOAT_MS,
      (v) => {
        t.position.y = at.y - 46 * cubicOut(v);
        t.alpha = v < 0.6 ? 1 : 1 - (v - 0.6) / 0.4;
        t.scale.set(v < 0.15 ? 0.6 + (v / 0.15) * 0.4 : 1);
      },
      k.signal,
      linear,
    )
    .then(k.done);
}

/** 头顶小气泡（圆角白底 + 描边 + 小尾巴），停留 ms 后淡出（不阻塞） */
export function bubble(h: FxHost, at: Pt, text: string, ms: number): void {
  const root = new Container({ label: 'bubble' });
  const t = new Text({
    text,
    style: { fontFamily: '"ZCOOL KuaiLe", "PingFang SC", sans-serif', fontSize: 18, fill: INK },
    resolution: 2,
  });
  t.anchor.set(0.5, 1);
  const w = Math.max(36, t.width + 18);
  const hh = t.height + 10;
  const bg = new Graphics()
    .roundRect(-w / 2, -hh - 8, w, hh, 12)
    .fill(0xffffff)
    .stroke({ width: 3, color: INK })
    .poly([-6, -9, 6, -9, 0, 0], true)
    .fill(0xffffff)
    .stroke({ width: 3, color: INK, join: 'round' });
  t.position.set(0, -13);
  root.addChild(bg, t);
  root.position.set(at.x, at.y);
  const k = h.track(root, h.overlay);
  void h
    .tween(
      ms,
      (v) => {
        root.scale.set(v < 0.08 ? 0.5 + (v / 0.08) * 0.5 : 1);
        root.alpha = v < 0.85 ? 1 : 1 - (v - 0.85) / 0.15;
        root.position.y = at.y - 6 * v;
      },
      k.signal,
    )
    .then(k.done);
}

/** 数字标签（定时炸弹引信、倒数）：BitmapText，白字描边 */
export function numberTag(text: string, size = 18, fill = 0xffffff): BitmapText {
  const b = new BitmapText({
    text,
    style: { fontFamily: NUM_FONT, fontSize: size, fontWeight: 'bold', fill, stroke: { color: INK, width: 4 } },
  });
  b.anchor.set(0.5, 1);
  return b;
}
