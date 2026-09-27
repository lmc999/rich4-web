// client-browser：真实 Chromium 的 Web Audio 与 <audio>（MediaElementSource）下跑一遍引擎：
// 手势解锁、解码播放音效、ZzFX 合成、棋盘曲流式播放、进场景（AudioBuffer 循环）再离开后续播。
// 音频是测试里现生成的 WAV（Blob URL），不含任何素材。
import { describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { AudioEngine } from './AudioEngine';
import { ProceduralAudioSource, zzfxKey } from './procedural';
import type { AudioClipInfo, AudioSource } from './types';
import { browserAudioEnv } from './webaudio';

/** 单声道 16 位 PCM 正弦 WAV */
function wav(seconds: number, hz: number, rate = 22_050): Blob {
  const n = Math.round(seconds * rate);
  const b = new ArrayBuffer(44 + n * 2);
  const v = new DataView(b);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 8000), true);
  return new Blob([b], { type: 'audio/wav' });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('AudioEngine（真实浏览器）', () => {
  it('解锁、音效、ZzFX、棋盘曲与场景栈续播', async () => {
    const urls: Record<string, string> = {
      'sfx.test': URL.createObjectURL(wav(0.2, 880)),
      'music.board': URL.createObjectURL(wav(20, 220)),
      'music.scene': URL.createObjectURL(wav(1.5, 440)),
    };
    const info: Record<string, AudioClipInfo> = {
      'music.scene': { durationMs: 1500, loop: { startMs: 0, endMs: 1500 } },
    };
    const src: AudioSource = { id: 'wav', resolve: (k) => urls[k] ?? null, info: (k) => info[k] ?? null };
    const engine = new AudioEngine({ env: browserAudioEnv(), sources: [src, new ProceduralAudioSource()] });
    expect(['locked', 'running']).toContain(engine.state);
    engine.installUnlock();
    const btn = document.createElement('button');
    btn.textContent = 'unlock';
    document.body.append(btn);
    await userEvent.click(btn);
    await sleep(100);
    expect(engine.state).toBe('running');

    engine.playSfx('sfx.test');
    engine.playSfx(zzfxKey('coin'));
    await sleep(300);
    const sfx = engine.logs.filter((e) => e.kind === 'sfx');
    expect(sfx.filter((e) => e.op === 'play').map((e) => e.key)).toEqual(['sfx.test', 'zzfx.coin']);

    engine.setBoardPlaylist(['music.board']);
    engine.setBoardActive(true);
    await sleep(1200);
    const b1 = engine.musicSnapshot()!;
    expect(b1.mode).toBe('board');
    expect(b1.positionSec!).toBeGreaterThan(0.5);

    const tok = engine.pushScene('music.scene');
    await sleep(2200); // 场景曲循环了一圈多
    const sc = engine.musicSnapshot()!;
    expect(sc.mode).toBe('scene');
    expect(sc.positionSec!).toBeGreaterThanOrEqual(0);
    expect(sc.positionSec!).toBeLessThan(1.5);
    const saved = engine.logs.find((e) => e.op === 'board.stop')!.atSec!;
    engine.popScene(tok);
    await sleep(300);
    const b2 = engine.musicSnapshot()!;
    expect(b2.mode).toBe('board');
    const resume = engine.logs.find((e) => e.op === 'board.resume')!;
    expect(Math.abs(resume.atSec! - saved)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(b2.positionSec! - saved)).toBeLessThanOrEqual(0.8);
    expect(engine.logs.some((e) => e.op === 'playError')).toBe(false);

    engine.dispose();
    btn.remove();
    for (const u of Object.values(urls)) URL.revokeObjectURL(u);
  });
});
