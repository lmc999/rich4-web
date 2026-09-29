// ZzFX 回退：只认 zzfx.<预设>；合成结果确定（随机度为 0）；真实 zzfx 模块生成的采样有限且非空。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine } from './AudioEngine';
import {
  ProceduralAudioSource,
  ZZFX_PRESET_IDS,
  ZZFX_PRESETS,
  type ZzfxBuilder,
  zzfxKey,
  zzfxPresetOf,
} from './procedural';
import { FakeAudioContext, FakeAudioWorld, flushMicrotasks } from './testing/fakeAudio';

const fakeBuilder: ZzfxBuilder = (params, sr) => {
  const n = Math.round(((params[4] ?? 0) + (params[5] ?? 0.1) + 0.01) * sr * 0.01);
  return Array.from({ length: n }, (_, i) => ((i % 7) - 3) / 3);
};

describe('ProceduralAudioSource', () => {
  it('只认 zzfx.<预设> 键，不提供 URL', () => {
    const src = new ProceduralAudioSource({ builder: fakeBuilder });
    expect(src.has(zzfxKey('coin'))).toBe(true);
    expect(src.has('zzfx.nope')).toBe(false);
    expect(src.has('sfx.049')).toBe(false);
    expect(src.resolve()).toBeNull();
    expect(zzfxPresetOf('zzfx.boom')).toBe('boom');
    expect(zzfxPresetOf('sfx.001')).toBeNull();
  });

  it('合成为单声道 AudioBuffer，采样钳到 [-1, 1]', async () => {
    const ctx = new FakeAudioContext(true);
    const src = new ProceduralAudioSource({ builder: (_p, _sr) => [0, 2, -3, Number.NaN, 0.5] });
    const b = await src.synth(zzfxKey('ding'), ctx);
    expect(b?.numberOfChannels).toBe(1);
    expect(Array.from(b!.getChannelData(0))).toEqual([0, 1, -1, 0, 0.5]);
    expect(await src.synth('zzfx.unknown', ctx)).toBeNull();
    const none = new ProceduralAudioSource({ loadBuilder: () => Promise.resolve(null) });
    expect(await none.synth(zzfxKey('ding'), ctx)).toBeNull();
  });

  it('预设随机度一律为 0', () => {
    for (const id of ZZFX_PRESET_IDS) expect(ZZFX_PRESETS[id][1], id).toBe(0);
  });

  it('经 AudioEngine.playSfx 播放（ZzFX 预设与素材包音效同一通路）', async () => {
    const w = new FakeAudioWorld();
    const engine = new AudioEngine({ env: w.env(), sources: [new ProceduralAudioSource({ builder: fakeBuilder })] });
    engine.installUnlock();
    w.gesture();
    await flushMicrotasks();
    engine.playSfx(zzfxKey('coin'));
    await flushMicrotasks();
    expect(w.ctx!.playing.length).toBe(1);
    expect(w.fetched).toEqual([]);
  });
});

describe('真实 zzfx 模块', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('各预设生成有限、非空、确定的采样', async () => {
    // zzfx 在模块求值时 new AudioContext：node 下用假类顶替
    let closed = 0;
    vi.stubGlobal(
      'AudioContext',
      class {
        close() {
          closed++;
          return Promise.resolve();
        }
      },
    );
    const { loadZzfxBuilder } = await import('./procedural');
    const build = await loadZzfxBuilder();
    expect(build).not.toBeNull();
    await flushMicrotasks();
    expect(closed).toBe(1);
    for (const id of ZZFX_PRESET_IDS) {
      const a = build!(ZZFX_PRESETS[id], 44_100);
      const b = build!(ZZFX_PRESETS[id], 44_100);
      expect(a.length, id).toBeGreaterThan(100);
      expect(a.length, id).toBeLessThan(44_100 * 2);
      let peak = 0;
      for (let i = 0; i < a.length; i++) {
        expect(Number.isFinite(a[i]!), id).toBe(true);
        peak = Math.max(peak, Math.abs(a[i]!));
      }
      expect(peak, id).toBeGreaterThan(0.01);
      expect(Array.from(b)).toEqual(Array.from(a));
    }
    // 掷骰的一声「咚」（原版 Effect#10：139 ms、单起音）：短于 200 ms，能量集中在开头
    const knock = build!(ZZFX_PRESETS.dice, 44_100);
    expect(knock.length / 44_100).toBeLessThan(0.2);
    let head = 0;
    let tail = 0;
    for (let i = 0; i < knock.length; i++) {
      const v = Math.abs(knock[i]!);
      if (i < 44_100 * 0.04) head = Math.max(head, v);
      else tail = Math.max(tail, v);
    }
    expect(head).toBeGreaterThan(tail);
  });
});
