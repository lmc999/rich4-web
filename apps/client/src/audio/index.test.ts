// AudioSystem：组装（ZzFX 回退常驻）、切换素材包、ctx.audio 端口、调试钩子、收尾。
import { describe, expect, it, vi } from 'vitest';
import { AudioSystem } from './index';
import { FakeAudioWorld, flushMicrotasks } from './testing/fakeAudio';

describe('AudioSystem', () => {
  it('无素材包时只有 ZzFX；端口可播裸预设名；钩子能读日志与音乐状态', async () => {
    const world = new FakeAudioWorld();
    const sys = new AudioSystem({ env: world.env() });
    expect(sys.engine.sourceIds).toEqual(['procedural']);
    expect(world.gestures.count('pointerdown')).toBe(1);
    world.gesture();
    await flushMicrotasks();
    const hooks = sys.hooks();
    expect(hooks.state).toBe('running');
    sys.port().play('coin');
    sys.port().play('zzfx.nope');
    // ctx.audio.cue：按 soundMap 同一套提示解析（没有素材包 → ZzFX 预设）
    const played = vi.spyOn(sys.engine, 'playSfx');
    sys.port().cue?.({ cue: 'dice.roll', zzfx: 'dice', timed: true });
    expect(played).toHaveBeenCalledWith('zzfx.dice', { bus: 'sfx' });
    played.mockRestore();
    // ctx.audio.voices：说出事件在开始时选好的 timed 台词（亮卡之后的卡片台词）
    const timed = vi.spyOn(sys.director, 'speakTimed');
    const used = { type: 'CARD_USED', seat: 0, card: 2, target: { t: 'none' } } as const;
    sys.port().voices?.(used);
    expect(timed).toHaveBeenCalledWith(used);
    timed.mockRestore();
    await flushMicrotasks();
    expect(hooks.log.some((e) => e.op === 'missing' && e.key === 'zzfx.nope')).toBe(true);
    expect(hooks.music()?.mode).toBe('idle');
    hooks.clearLog();
    expect(hooks.log.length).toBe(0);
    await sys.applyPack(null);
    expect(sys.engine.sourceIds).toEqual(['procedural']);
    // 后台静音缺省开启
    world.visibility.set(true);
    await flushMicrotasks();
    expect(sys.engine.state).toBe('suspended');
    sys.dispose();
    expect(sys.engine.state).toBe('disposed');
  });

  it('绑定设置 store：立即应用；后台静音可关', async () => {
    const world = new FakeAudioWorld();
    const state = { volume: { master: 0.5, bgm: 0.6, sfx: 0.8, voice: 0.7 }, muted: true, muteInBackground: false };
    const sys = new AudioSystem({
      env: world.env(),
      settings: { getState: () => state, subscribe: () => () => {} },
      unlockOnGesture: false,
    });
    expect(sys.engine.settings.muted).toBe(true);
    expect(sys.engine.settings.master).toBe(0.5);
    world.visibility.set(true);
    await flushMicrotasks();
    expect(sys.engine.state).toBe('locked');
    sys.dispose();
  });
});
