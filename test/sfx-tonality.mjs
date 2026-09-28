// 调试：分析原版短音效的音高清晰度（找适合做倒计时「嘀」的候选）。用法：node test/sfx-tonality.mjs 006 007 ...
// 解码 rich4-assets/audio/sfx/NNN.*.opus 为 22050 Hz 单声道 f32，按帧求自相关峰值（清晰度）与主频。
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
const dir = 'rich4-assets/audio/sfx';
const files = readdirSync(dir);
const SR = 22050;
for (const id of process.argv.slice(2)) {
  const f = files.find((x) => x.startsWith(`${id}.`) && x.endsWith('.opus'));
  if (!f) continue;
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', `${dir}/${f}`, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-']);
  const x = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  let peak = 0, sumsq = 0, zc = 0;
  for (let i = 0; i < x.length; i++) { peak = Math.max(peak, Math.abs(x[i])); sumsq += x[i] * x[i]; if (i && (x[i] >= 0) !== (x[i - 1] >= 0)) zc++; }
  // 取能量最大的 2048 样本窗做自相关
  const W = Math.min(2048, x.length);
  let best = 0, bestE = -1;
  for (let s = 0; s + W <= x.length; s += 256) { let e = 0; for (let i = s; i < s + W; i++) e += x[i] * x[i]; if (e > bestE) { bestE = e; best = s; } }
  const w = x.subarray(best, best + W);
  let r0 = 0; for (const v of w) r0 += v * v;
  let bestLag = 0, bestR = 0;
  for (let lag = Math.floor(SR / 4000); lag < Math.floor(SR / 150); lag++) { let r = 0; for (let i = 0; i + lag < W; i++) r += w[i] * w[i + lag]; r /= r0 || 1; if (r > bestR) { bestR = r; bestLag = lag; } }
  console.log(id, `dur=${(x.length / SR).toFixed(3)}s`, `peak=${peak.toFixed(2)}`, `rms=${Math.sqrt(sumsq / x.length).toFixed(3)}`, `zcr=${(zc / (x.length / SR)).toFixed(0)}/s`, `pitch=${bestLag ? (SR / bestLag).toFixed(0) : '-'}Hz`, `clarity=${bestR.toFixed(2)}`);
}
