// 调研：掷骰音效取证。从 original/Game/Effect.mkf 解出候选音效（u8 单声道 22.05 kHz WAV），分析包络起音点、时长、主频，
// 并画波形图；再用 ffmpeg 解码素材包 rich4-assets 的同号音效核对键名。只读原版，产物放 .cache/dice/sfx/（不入库）。
// exe v2.06 依据：掷骰 fcn.00418d0b 先 fcn.0044f501(0x47f63a,0) 设 FLIC 帧同步音效（棋盘音效集 0x47f62a 下标 2 = Effect#10），
// FLIC 播到第 30 帧时播一次（fcn.0044f72b @0x44fb9d），FLIC 结束后 0x418dc8 再播一次同一音效。
// 用法：node test/dice-sfx-probe.mjs [音效号逗号分隔]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { canvas, contactSheet, label, rect, savePng } from './ui-lib.mjs';

const ROOT = '.';
const OUT = `${ROOT}/.cache/dice/sfx`;
fs.mkdirSync(OUT, { recursive: true });
const ids = (process.argv[2] ?? '10,9,1,7,32,37,43,48,44,45,46,54,62').split(',').map(Number);

// ── MKF：首 u32 = 索引表偏移，表内为各项起点；每项 16 字节头 {raw, stored, imgOff, imgSize}，音效项 stored==raw 不压缩
const mkf = fs.readFileSync(`${ROOT}/original/Game/Effect.mkf`);
const X = mkf.readUInt32LE(0);
const starts = [];
for (let o = X; o + 4 <= mkf.length; o += 4) starts.push(mkf.readUInt32LE(o));
function entry(i) {
  const o = starts[i];
  const raw = mkf.readUInt32LE(o);
  const stored = mkf.readUInt32LE(o + 4);
  if (raw === 0) return null;
  if (raw !== stored) throw new Error(`Effect#${i} 压缩项（未预期）`);
  return mkf.subarray(o + 16, o + 16 + stored);
}

function parseWav(b) {
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('不是 WAV');
  let p = 12;
  let fmt = null;
  let data = null;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4);
    const sz = b.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(p + 10), rate: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    if (id === 'data') data = b.subarray(p + 8, Math.min(b.length, p + 8 + sz));
    p += 8 + sz + (sz & 1);
  }
  const s = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) s[i] = (data[i] - 128) / 128;
  return { ...fmt, s };
}

/** 5 ms 窗 RMS 包络；起音 = 包络从低于 峰值×0.12 升到高于 峰值×0.35（两次起音之间至少隔 40 ms） */
function analyze(w) {
  const win = Math.round(w.rate * 0.005);
  const env = [];
  for (let i = 0; i < w.s.length; i += win) {
    let a = 0;
    const e = Math.min(w.s.length, i + win);
    for (let j = i; j < e; j++) a += w.s[j] * w.s[j];
    env.push(Math.sqrt(a / Math.max(1, e - i)));
  }
  const peak = Math.max(...env);
  const onsets = [];
  let armed = true;
  let last = -1e9;
  for (let k = 0; k < env.length; k++) {
    if (env[k] < peak * 0.12) armed = true;
    if (armed && env[k] >= peak * 0.35 && k * 5 - last >= 40) {
      onsets.push(k * 5);
      last = k * 5;
      armed = false;
    }
  }
  // 有声段：包络 ≥ 峰值×0.05 的首末
  const on = env.findIndex((v) => v >= peak * 0.05);
  let off = env.length - 1;
  while (off > 0 && env[off] < peak * 0.05) off--;
  // 主频：前 60 ms（起音后）做朴素 DFT，40..4000 Hz
  const st = Math.max(0, on * win);
  const n = Math.min(w.s.length - st, Math.round(w.rate * 0.06));
  let best = 0;
  let bestF = 0;
  let cen = 0;
  let tot = 0;
  for (let f = 40; f <= 4000; f += 10) {
    let re = 0;
    let im = 0;
    for (let j = 0; j < n; j++) {
      const ph = (2 * Math.PI * f * j) / w.rate;
      re += w.s[st + j] * Math.cos(ph);
      im -= w.s[st + j] * Math.sin(ph);
    }
    const mag = Math.hypot(re, im);
    cen += f * mag;
    tot += mag;
    if (mag > best) {
      best = mag;
      bestF = f;
    }
  }
  // 过零率（每秒）
  let zc = 0;
  for (let j = 1; j < w.s.length; j++) if (w.s[j - 1] < 0 !== w.s[j] < 0) zc++;
  return {
    durMs: Math.round((w.s.length / w.rate) * 1000),
    peak: +peak.toFixed(3),
    soundMs: [on * 5, off * 5 + 5],
    onsets,
    domHz: bestF,
    centroidHz: Math.round(cen / Math.max(1e-9, tot)),
    zcr: Math.round(zc / (w.s.length / w.rate)),
    env,
  };
}

function wavePng(w, a, title) {
  const W = 900;
  const H = 160;
  const c = canvas(W, H, [24, 24, 30, 255]);
  const n = w.s.length;
  for (let x = 0; x < W; x++) {
    const i0 = Math.floor((x * n) / W);
    const i1 = Math.max(i0 + 1, Math.floor(((x + 1) * n) / W));
    let mn = 1;
    let mx = -1;
    for (let j = i0; j < i1; j++) {
      mn = Math.min(mn, w.s[j]);
      mx = Math.max(mx, w.s[j]);
    }
    const y0 = Math.round(H / 2 - mx * (H / 2 - 4));
    const y1 = Math.round(H / 2 - mn * (H / 2 - 4));
    rect(c, x, y0, 1, Math.max(1, y1 - y0), [120, 200, 255, 255]);
  }
  // 包络与起音点
  const ms = (n / w.rate) * 1000;
  a.env.forEach((v, k) => rect(c, Math.round((k * 5 * W) / ms), H - 2 - Math.round((v / a.peak) * 40), 2, 2, [255, 200, 80, 255]));
  for (const t of a.onsets) rect(c, Math.round((t * W) / ms), 0, 1, H, [255, 60, 60, 255]);
  label(c, 4, 4, title, [255, 255, 0, 255], 2);
  return c;
}

const imgs = [];
const report = {};
for (const id of ids) {
  const b = entry(id);
  if (!b) {
    console.log(`Effect#${id}：空占位`);
    continue;
  }
  fs.writeFileSync(`${OUT}/effect-${String(id).padStart(3, '0')}.wav`, b);
  const w = parseWav(b);
  const a = analyze(w);
  report[id] = { ...a, env: undefined };
  console.log(
    `Effect#${String(id).padStart(3)}：${w.rate} Hz ${w.bits} bit ${w.ch} ch，时长 ${a.durMs} ms，有声 ${a.soundMs[0]}–${a.soundMs[1]} ms，` +
      `起音 ${a.onsets.length} 个 @ [${a.onsets.join(', ')}] ms，主频 ${a.domHz} Hz，谱心 ${a.centroidHz} Hz，过零率 ${a.zcr}/s`,
  );
  imgs.push(wavePng(w, a, `E${id} ${a.durMs}ms`));
}
savePng(`${OUT}/waveforms.png`, contactSheet(imgs, { maxW: 920 }));

// ── 模拟原版掷骰时序：同一音效在 t1、t2 两次叠加（默认速度 1：FLIC 30 ms/帧 → 第 30 帧 29×30=870 ms、结束 36×30=1080 ms）
for (const [speed, frameMs] of [[0, 50], [1, 30], [2, 20]]) {
  const w = parseWav(entry(10));
  const t1 = 29 * frameMs;
  const t2 = 36 * frameMs;
  const len = Math.round(((t2 + 400) / 1000) * w.rate);
  const mix = new Float32Array(len);
  for (const t of [t1, t2]) {
    const o = Math.round((t / 1000) * w.rate);
    for (let j = 0; j < w.s.length && o + j < len; j++) mix[o + j] += w.s[j];
  }
  const pcm = Buffer.alloc(len);
  for (let j = 0; j < len; j++) pcm[j] = Math.max(0, Math.min(255, Math.round(mix[j] * 128 + 128)));
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0);
  hdr.writeUInt32LE(36 + len, 4);
  hdr.write('WAVEfmt ', 8);
  hdr.writeUInt32LE(16, 16);
  hdr.writeUInt16LE(1, 20);
  hdr.writeUInt16LE(1, 22);
  hdr.writeUInt32LE(w.rate, 24);
  hdr.writeUInt32LE(w.rate, 28);
  hdr.writeUInt16LE(1, 32);
  hdr.writeUInt16LE(8, 34);
  hdr.write('data', 36);
  hdr.writeUInt32LE(len, 40);
  fs.writeFileSync(`${OUT}/dice-roll-speed${speed}.wav`, Buffer.concat([hdr, pcm]));
  const a = analyze({ rate: w.rate, s: mix });
  console.log(`模拟速度 ${speed}（${frameMs} ms/帧）：两次 Effect#10 于 ${t1} / ${t2} ms，检测到起音 [${a.onsets.join(', ')}] ms`);
}

// ── 素材包核对：rich4-assets 的 sfx.010 解码后与 Effect#10 比较时长与起音
try {
  const man = JSON.parse(fs.readFileSync(`${ROOT}/rich4-assets/manifest.json`, 'utf8'));
  for (const id of [10]) {
    const key = `sfx.${String(id).padStart(3, '0')}`;
    const e = man.entries[key];
    const file = fs.readdirSync(`${ROOT}/rich4-assets/audio/sfx`).find((f) => f.startsWith(String(id).padStart(3, '0')) && f.endsWith('.opus'));
    const wav = `${OUT}/pack-${key}.wav`;
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', `${ROOT}/rich4-assets/audio/sfx/${file}`, '-ac', '1', '-ar', '22050', '-c:a', 'pcm_u8', wav]);
    const a = analyze(parseWav(fs.readFileSync(wav)));
    console.log(`素材包 ${key}（${file}，manifest src ${e?.src}，durationMs ${e?.durationMs}）：解码 ${a.durMs} ms，起音 [${a.onsets.join(', ')}] ms，主频 ${a.domHz} Hz`);
  }
} catch (err) {
  console.log('素材包核对失败：', err.message);
}
fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 1));
console.log('输出目录', OUT);
