// 企鹅挖宝命中掩膜（Panel#81，640×480，区号 = 格号）与 sim 拾取（pickCell）的逐像素对拍（design-draft §4.9；审查修正 7）。
// 只做诊断：输入命中一律走 pickCell（DEV-07 的几何菱形，golden 与服务器复验依赖它），掩膜不参与判定；
// 对拍结果只报告（原版边缘与几何菱形差一两个像素），不阻断。
import { penguin } from '@rich4/shared/minigames';

export interface MaskDiag {
  w: number;
  h: number;
  /** 一致的像素数 */
  same: number;
  /** 不一致的像素数 */
  diff: number;
  /** 掩膜里出现的区号（不含 0）是否恰好是 64 个有效格 */
  regionsMatch: boolean;
  /** 不一致最多的若干对「掩膜格 → pickCell 格」（−1 表示不在任何格上） */
  top: [pair: string, count: number][];
}

/**
 * 整张舞台的 pickCell 结果（−1 = 不在任何格上），逐格扫菱形包围盒求最小度量：与 pickCell 同一度量
 * （|dx|·半高 + |dy|·半宽 ≤ 半宽·半高）、同一并列规则（度量相同取格号小者：按格号升序、严格小于才替换），
 * 结果逐像素相同（maskDiag.test 全图核对），但只需约 30 万次运算（逐像素调 pickCell 要 2000 万次），浏览器里诊断不卡帧。
 */
export function pickCellMap(w = 640, h = 480): Int16Array {
  const HW = penguin.CELL_HALF_W;
  const HH = penguin.CELL_HALF_H;
  const limit = HW * HH;
  const cell = new Int16Array(w * h).fill(-1);
  const best = new Int32Array(w * h).fill(limit + 1);
  for (const c of penguin.VALID_CELLS) {
    const { x: cx, y: cy } = penguin.cellCenter(c);
    for (let y = Math.max(0, cy - HH); y <= Math.min(h - 1, cy + HH); y++) {
      for (let x = Math.max(0, cx - HW); x <= Math.min(w - 1, cx + HW); x++) {
        const d = Math.abs(x - cx) * HH + Math.abs(y - cy) * HW;
        const i = y * w + x;
        if (d < best[i]!) {
          best[i] = d;
          cell[i] = c;
        }
      }
    }
  }
  return cell;
}

/** region(x, y)：掩膜在 (x, y) 的区号（0 = 不在格上） */
export function diagnosePenguinMask(region: (x: number, y: number) => number, w = 640, h = 480): MaskDiag {
  const pick = pickCellMap(w, h);
  let same = 0;
  let diff = 0;
  const seen = new Set<number>();
  const pairs = new Map<string, number>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = region(x, y);
      if (v !== 0) seen.add(v);
      const m = v === 0 ? -1 : v;
      const c = pick[y * w + x]!;
      if (m === c) {
        same++;
        continue;
      }
      diff++;
      const k = `${m}->${c}`;
      pairs.set(k, (pairs.get(k) ?? 0) + 1);
    }
  }
  const valid = new Set(penguin.VALID_CELLS);
  const regionsMatch = seen.size === valid.size && [...seen].every((r) => valid.has(r));
  const top = [...pairs.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 8);
  return { w, h, same, diff, regionsMatch, top };
}

/** 从 8 位灰度（RGBA 的 R 通道）像素数组取区号 */
export function regionFromRgba(rgba: ArrayLike<number>, w: number): (x: number, y: number) => number {
  return (x, y) => rgba[(y * w + x) * 4]!;
}
