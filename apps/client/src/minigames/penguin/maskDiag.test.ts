// 企鹅命中掩膜对拍（只诊断，不参与输入判定；design-draft §4.9、审查修正 7）：
// - 合成包（globalSetup 生成的 .cache/synthetic-pack）：掩膜按与 sim 同一几何生成，逐像素与 pickCell 完全一致；
// - 本机真实素材包（rich4-assets/，不入库；CI 没有时跳过）：区号恰好是 64 个有效格，逐像素一致率 ≥ 98%，
//   不一致只报告（原版边缘与几何菱形差一两个像素，DEV-07）。
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { penguin } from '@rich4/shared/minigames';
import { describe, expect, it } from 'vitest';
import { diagnosePenguinMask, pickCellMap } from './maskDiag';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

/** 最小 PNG 解码：8 位灰度（color type 0）或 RGBA（6），逐行去滤波；返回每像素的第一通道 */
function decodeGray(buf: Buffer): { w: number; h: number; px: Uint8Array } {
  let off = 8;
  let w = 0;
  let h = 0;
  let ctype = 0;
  const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      ctype = data[9]!;
    } else if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const bpp = ctype === 6 ? 4 : ctype === 2 ? 3 : 1;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x++) {
      const a = raw[y * (stride + 1) + 1 + x]!;
      const left = x >= bpp ? out[y * stride + x - bpp]! : 0;
      const up = y > 0 ? out[(y - 1) * stride + x]! : 0;
      const ul = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp]! : 0;
      let v = a;
      if (f === 1) v = a + left;
      else if (f === 2) v = a + up;
      else if (f === 3) v = a + ((left + up) >> 1);
      else if (f === 4) {
        const p = left + up - ul;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - ul);
        v = a + (pa <= pb && pa <= pc ? left : pb <= pc ? up : ul);
      }
      out[y * stride + x] = v & 255;
    }
  }
  const px = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) px[i] = out[i * bpp]!;
  return { w, h, px };
}

function maskOf(packDir: string): { w: number; h: number; px: Uint8Array } | null {
  const mf = join(packDir, 'manifest.json');
  if (!existsSync(mf)) return null;
  const m = JSON.parse(readFileSync(mf, 'utf8')) as {
    entries: Record<string, { type: string; file?: string }>;
    files: Record<string, { path: string }>;
  };
  const e = m.entries['mg.penguin.mask'];
  if (e?.type !== 'mask' || !e.file) return null;
  return decodeGray(readFileSync(join(packDir, m.files[e.file]!.path)));
}

describe('企鹅掩膜与 pickCell 对拍', () => {
  it('pickCellMap 与 sim 的 pickCell 逐像素相同', { timeout: 60_000 }, () => {
    const map = pickCellMap(640, 480);
    let diff = 0;
    for (let y = 0; y < 480; y++) for (let x = 0; x < 640; x++) if (map[y * 640 + x] !== penguin.pickCell(x, y)) diff++;
    expect(diff).toBe(0);
  });

  // 640×480 逐像素 × 64 格：全量并行测试下单条可能超过默认 5 秒
  it('合成包：区号 = 格号，逐像素与 pickCell 一致', { timeout: 60_000 }, () => {
    const mask = maskOf(join(REPO, '.cache', 'synthetic-pack'));
    expect(mask, '合成包缺少 mg.penguin.mask').not.toBeNull();
    const d = diagnosePenguinMask((x, y) => mask!.px[y * mask!.w + x]!, mask!.w, mask!.h);
    expect(d.regionsMatch).toBe(true);
    expect(d.diff).toBe(0);
  });

  const real = join(REPO, 'rich4-assets');
  it.skipIf(!existsSync(join(real, 'manifest.json')))(
    '本机真实素材包：区号是 64 个有效格，边缘差异只报告',
    { timeout: 60_000 },
    () => {
      const mask = maskOf(real);
      if (!mask) return;
      const d = diagnosePenguinMask((x, y) => mask.px[y * mask.w + x]!, mask.w, mask.h);
      console.info(`[mask] Panel#81 与 pickCell：一致 ${d.same}、不一致 ${d.diff}`, d.top);
      expect(d.regionsMatch).toBe(true);
      expect(d.same / (d.same + d.diff)).toBeGreaterThan(0.98);
    },
  );
});
