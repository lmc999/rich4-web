// 临时调试脚本：SPR/SMP 透明与特殊调色板索引统计（只读 original/**，输出 .cache/assets-research/sprite/key-stats.json）
import { writeFileSync } from 'node:fs';
import { Mkf, parseSheet, sniff } from './sprite-proto.ts';

const G = './original/Game/';
const out: Record<string, unknown> = {};
for (const a of ['Data.mkf', 'Panel.mkf', 'jump.mkf', 'map.mkf', 'help.mkf']) {
  const m = Mkf.open(G + a);
  const pal0 = new Map<number, number>();
  const pal255 = new Map<number, number>();
  let sprFrames = 0, sprPx = 0, sprIdx0 = 0, sprIdx255 = 0, sprResWith255 = 0;
  let smpFrames = 0, smpPx = 0, smpZero = 0, smpOpaqueFull = 0, smpFullFrames = 0;
  const idx255Res: number[] = [];
  const smpFullZero: string[] = [];
  for (const e of m.entries) {
    if (!e.rawSize) continue;
    const d = m.read(e.index);
    const k = sniff(d);
    if (k !== 'SPR' && k !== 'SMP') continue;
    const sh = parseSheet(d);
    if (k === 'SPR') {
      pal0.set(sh.palette![0]!, (pal0.get(sh.palette![0]!) ?? 0) + 1);
      pal255.set(sh.palette![255]!, (pal255.get(sh.palette![255]!) ?? 0) + 1);
      let used255 = 0;
      for (const f of sh.frames) {
        sprFrames++;
        for (let p = 0; p < f.w * f.h; p++) {
          const v = d[f.off + p]!;
          sprPx++;
          if (v === 0) sprIdx0++;
          if (v === 255) { sprIdx255++; used255++; }
        }
      }
      if (used255) { sprResWith255++; idx255Res.push(e.index); }
    } else {
      for (const f of sh.frames) {
        smpFrames++;
        let z = 0;
        for (let p = 0; p < f.w * f.h; p++) {
          const c = d[f.off + p * 2]! | (d[f.off + p * 2 + 1]! << 8);
          if (c === 0) z++;
        }
        smpPx += f.w * f.h; smpZero += z;
        if (f.w === 640 && f.h === 480) { smpFullFrames++; if (z === 0) smpOpaqueFull++; else smpFullZero.push(`${e.index}:${sh.frames.indexOf(f)}=${z}`); }
      }
    }
  }
  const top = (mp: Map<number, number>) => [...mp.entries()].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([c, n]) => `0x${c.toString(16).padStart(4, '0')}x${n}`);
  out[a] = {
    spr: { frames: sprFrames, px: sprPx, idx0Pct: +(100 * sprIdx0 / Math.max(1, sprPx)).toFixed(2), idx255Px: sprIdx255, resWith255: sprResWith255, idx255Res: idx255Res.slice(0, 40), pal0: top(pal0), pal255: top(pal255) },
    smp: { frames: smpFrames, px: smpPx, zeroPct: +(100 * smpZero / Math.max(1, smpPx)).toFixed(2), full640Frames: smpFullFrames, full640NoZero: smpOpaqueFull, full640WithZero: smpFullZero.slice(0, 20) },
  };
  console.log(a, JSON.stringify(out[a]));
}
writeFileSync('./.cache/assets-research/sprite/key-stats.json', JSON.stringify(out, null, 1));
