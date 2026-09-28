// 调试：合成倒计时提示音的 ZzFX 预设（与 apps/client/src/audio/procedural.ts 同参数），打印长度、峰值与振幅包络；
// 写 wav 到 .cache/pc/countdown 试听（countdownFinalDouble.wav 为最后 3 秒实际听到的两次间隔 130ms 的双响）。用法：node test/countdown-beep-shape.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
globalThis.AudioContext = class { close() { return Promise.resolve(); } };
const { ZZFX } = await import('zzfx');
const SR = 44100;
const presets = {
  countdown: [0.3, 0, 1318, 0, 0.05, 0.03, 5, 1],
  countdownFinal: [0.32, 0, 1760, 0, 0.04, 0.025, 5, 1],
  // 对照：ZzFX 的 delay 回声做双响（第二声只有一半且渐弱，没采用）
  delayEcho: [0.55, 0, 1760, 0, 0.04, 0.025, 5, 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 0.11],
  tick: [0.35, 0, 1400, 0, 0, 0.02, 0],
};
mkdirSync('.cache/pc/countdown', { recursive: true });
for (const [name, p] of Object.entries(presets)) {
  const s = ZZFX.buildSamples.apply({ volume: 1, sampleRate: SR }, [...p]);
  let peak = 0;
  for (const v of s) peak = Math.max(peak, Math.abs(v));
  const env = [];
  for (let i = 0; i < s.length; i += SR / 100) {
    let m = 0;
    for (let j = i; j < Math.min(s.length, i + SR / 100); j++) m = Math.max(m, Math.abs(s[j]));
    env.push(m.toFixed(2));
  }
  console.log(name, `len=${(s.length / SR).toFixed(3)}s peak=${peak.toFixed(2)}`, env.join(' '));
  // 16-bit PCM wav
  const n = s.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s[i])) * 32767), 44 + i * 2);
  writeFileSync(`.cache/pc/countdown/${name}.wav`, buf);
  if (name === 'countdownFinal') {
    // 双响：同一段在 0ms 与 130ms 各放一次
    const gap = Math.round(0.13 * SR);
    const m = gap + n;
    const d = Buffer.alloc(44 + m * 2);
    buf.copy(d, 0, 0, 44);
    d.writeUInt32LE(36 + m * 2, 4);
    d.writeUInt32LE(m * 2, 40);
    for (let i = 0; i < m; i++) {
      const v = (i < n ? s[i] : 0) + (i >= gap ? s[i - gap] : 0);
      d.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2);
    }
    writeFileSync('.cache/pc/countdown/countdownFinalDouble.wav', d);
  }
}
