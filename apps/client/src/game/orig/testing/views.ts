// 测试用的 8 视角参数（自拟，不含原版数表）：θ = −22.5° + 45°·view，每世界像素 38.95/32 源像素，纵向压缩 0.7086
// （render.md 的拟合结论）。合成素材包（tools/extract assets synth）用的是同一套三角参数化。
import type { ViewAffine } from '../OrigProjection';

export function trigViews(scale = 38.95 / 32, squash = 0.7086): ViewAffine[] {
  return Array.from({ length: 8 }, (_, v) => {
    const t = ((-22.5 + 45 * v) * Math.PI) / 180;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    return { a: scale * cos, b: squash * scale * sin, c: -scale * sin, d: squash * scale * cos, tx: 0, ty: 0 };
  });
}
