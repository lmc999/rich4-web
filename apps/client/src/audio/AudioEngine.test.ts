// AudioEngine：假 AudioContext + 假时钟下的解锁、音量、压低、音效并发、格式选择、语音与音乐调度（场景栈续播）。
import { describe, expect, it } from 'vitest';
import { AudioEngine, type AudioEngineOptions } from './AudioEngine';
import { dbToGain, volumeToGain } from './format';
import {
  type FakeAudioParam,
  FakeAudioWorld,
  type FakeGain,
  type FakeWorldOptions,
  flushMicrotasks,
} from './testing/fakeAudio';
import type { AudioClipInfo, AudioFormat, AudioSource } from './types';

interface Clip {
  durationMs: number;
  loop?: { startMs: number; endMs: number } | null;
  formats?: AudioFormat[];
}

const CLIPS: Record<string, Clip> = {
  'sfx.049': { durationMs: 300 },
  'sfx.050': { durationMs: 200 },
  'voice.1076': { durationMs: 1500 },
  'voice.1077': { durationMs: 600 },
  'voice.1078': { durationMs: 2500 },
  'music.track02': { durationMs: 60_000 },
  'music.track03': { durationMs: 50_000 },
  'music.track04': { durationMs: 40_000 },
  'music.track11': { durationMs: 8_000, loop: { startMs: 0, endMs: 8_000 } },
  'music.track14': { durationMs: 4_000, loop: { startMs: 0, endMs: 4_000 } },
  'music.track17': { durationMs: 6_000, loop: { startMs: 0, endMs: 6_000 } },
  'music.track19': { durationMs: 4_000, loop: { startMs: 1_000, endMs: 3_000 } },
};

const url = (key: string, f: AudioFormat) => `/pack/${key}.${f === 'opus' ? 'opus' : 'm4a'}`;

function testSource(clips: Record<string, Clip> = CLIPS): AudioSource {
  return {
    id: 'test',
    resolve: (key, f) => {
      const c = clips[key];
      if (!c) return null;
      return (c.formats ?? ['opus', 'm4a']).includes(f) ? url(key, f) : null;
    },
    info: (key): AudioClipInfo | null => {
      const c = clips[key];
      return c ? { durationMs: c.durationMs, loop: c.loop ?? null } : null;
    },
  };
}

function setup(o: FakeWorldOptions & { engine?: Partial<AudioEngineOptions>; clips?: Record<string, Clip> } = {}) {
  const world = new FakeAudioWorld(o);
  const clips = o.clips ?? CLIPS;
  for (const [k, c] of Object.entries(clips)) {
    for (const f of ['opus', 'm4a'] as const) world.register(url(k, f), { durationMs: c.durationMs });
  }
  const engine = new AudioEngine({ env: world.env(), sources: [testSource(clips)], ...o.engine });
  return { world, engine };
}

async function unlock(world: FakeAudioWorld, engine: AudioEngine): Promise<void> {
  engine.installUnlock();
  world.gesture();
  await flushMicrotasks();
}

/** master、duck、bgm、sfx、voice、ui 依次创建 */
function nodes(world: FakeAudioWorld) {
  const g = world.ctx!.gains as FakeGain[];
  return { master: g[0]!, duck: g[1]!, bgm: g[2]!, sfx: g[3]!, voice: g[4]!, ui: g[5]! };
}

const target = (p: FakeAudioParam) => p.target;

describe('解锁', () => {
  it('首次手势：resume、audioSession=playback、媒体元素在手势内被 play()，之后移除监听', async () => {
    const { world, engine } = setup({ autoplayBlocked: true });
    expect(engine.state).toBe('locked');
    engine.installUnlock();
    expect(world.gestures.count('pointerdown')).toBe(1);
    world.gesture('touchend');
    await flushMicrotasks();
    expect(engine.state).toBe('running');
    expect(world.ctx!.resumeCalls).toBe(1);
    expect(world.audioSession.type).toBe('playback');
    // 两个媒体元素（棋盘、场景）都在手势内 play() 过
    expect(world.elements.length).toBe(2);
    for (const el of world.elements) expect(el.playCalls).toBeGreaterThanOrEqual(1);
    expect(world.gestures.count('pointerdown')).toBe(0);
    expect(engine.logs.some((e) => e.op === 'state' && e.detail === 'running')).toBe(true);
  });

  it('resume 未生效（不在手势内）时保持 locked，监听保留到下一次手势', async () => {
    const { world, engine } = setup();
    engine.installUnlock();
    world.ctx!.resumeWorks = false;
    world.gesture();
    await flushMicrotasks();
    expect(engine.state).toBe('locked');
    expect(world.gestures.count('keydown')).toBe(1);
    world.ctx!.resumeWorks = true;
    world.gesture('keydown');
    await flushMicrotasks();
    expect(engine.state).toBe('running');
  });

  it('解锁前的音效与语音直接丢弃', async () => {
    const { world, engine } = setup();
    engine.playSfx('sfx.049');
    await expect(engine.speak({ key: 'voice.1076' })).resolves.toBe('cancelled');
    await world.advance(100);
    expect(world.ctx!.sources.length).toBe(0);
    expect(world.fetched).toEqual([]);
  });

  it('不支持 Web Audio 时为 disabled，所有调用都安全', async () => {
    const world = new FakeAudioWorld();
    const env = { ...world.env(), createContext: () => null };
    const engine = new AudioEngine({ env, sources: [testSource()] });
    expect(engine.state).toBe('disabled');
    engine.playSfx('sfx.049');
    engine.setBoardActive(true);
    expect(engine.pushScene('music.track14')).toBe(0);
    await expect(engine.speak({ key: 'voice.1076' })).resolves.toBe('cancelled');
    await engine.unlock();
    engine.dispose();
  });
});

describe('音量与静音', () => {
  it('总线增益按 dB 曲线，静音压 master，语音关闭压 voice 总线', async () => {
    const { world, engine } = setup();
    const n = nodes(world);
    expect(target(n.master.gain)).toBeCloseTo(volumeToGain(0.8));
    expect(target(n.bgm.gain)).toBeCloseTo(volumeToGain(0.6));
    expect(target(n.voice.gain)).toBeCloseTo(volumeToGain(0.7));
    engine.setMix({ master: 0.5, sfx: 1, ui: 0 });
    expect(target(n.master.gain)).toBeCloseTo(dbToGain(-20));
    expect(target(n.sfx.gain)).toBe(1);
    expect(target(n.ui.gain)).toBe(0);
    engine.setMuted(true);
    expect(target(n.master.gain)).toBe(0);
    engine.setMuted(false);
    expect(target(n.master.gain)).toBeCloseTo(dbToGain(-20));
    engine.setMix({ voiceEnabled: false });
    expect(target(n.voice.gain)).toBe(0);
    await unlock(world, engine);
    await expect(engine.speak({ key: 'voice.1076' })).resolves.toBe('disabled');
    expect(world.fetched).toEqual([]);
  });

  it('volumeToGain：端点与单调', () => {
    expect(volumeToGain(0)).toBe(0);
    expect(volumeToGain(1)).toBe(1);
    expect(volumeToGain(Number.NaN)).toBe(0);
    let prev = 0;
    for (let v = 0.05; v <= 1; v += 0.05) {
      const g = volumeToGain(v);
      expect(g).toBeGreaterThan(prev);
      prev = g;
    }
  });
});

describe('音效', () => {
  it('解码后播放到 sfx / ui 总线；同一键第二次命中缓存', async () => {
    const { world, engine } = setup();
    await unlock(world, engine);
    engine.playSfx('sfx.049');
    await flushMicrotasks();
    expect(world.fetched).toEqual(['/pack/sfx.049.opus']);
    const s = world.ctx!.playing;
    expect(s.length).toBe(1);
    expect((s[0]!.outputs[0] as FakeGain).outputs[0]).toBe(nodes(world).sfx);
    engine.playUi('sfx.049');
    await flushMicrotasks();
    expect(world.fetched.length).toBe(1);
    expect((world.ctx!.playing[1]!.outputs[0] as FakeGain).outputs[0]).toBe(nodes(world).ui);
    await world.advance(400);
    expect(world.ctx!.playing.length).toBe(0);
    expect(engine.activeCount('sfx.049')).toBe(0);
  });

  it('同一键并发上限 4：第 5、6 次停掉最早的实例', async () => {
    const { world, engine } = setup();
    await unlock(world, engine);
    await engine.preload(['sfx.049']);
    for (let i = 0; i < 6; i++) engine.playSfx('sfx.049');
    await flushMicrotasks();
    expect(engine.activeCount('sfx.049')).toBe(4);
    expect(world.ctx!.playing.length).toBe(4);
    expect(engine.logs.filter((e) => e.op === 'steal').length).toBe(2);
    // 其他键不受影响
    engine.playSfx('sfx.050', { maxConcurrent: 1 });
    engine.playSfx('sfx.050', { maxConcurrent: 1 });
    await flushMicrotasks();
    expect(engine.activeCount('sfx.050')).toBe(1);
  });

  it('加载超过 maxSfxLatencyMs 的音效作废，不迟到补播', async () => {
    const { world, engine } = setup({ engine: { maxSfxLatencyMs: 300 } });
    world.register(url('sfx.049', 'opus'), { durationMs: 300, delayMs: 500 });
    await unlock(world, engine);
    engine.playSfx('sfx.049');
    await world.advance(600);
    expect(world.ctx!.playing.length).toBe(0);
    expect(engine.logs.some((e) => e.op === 'late' && e.key === 'sfx.049')).toBe(true);
  });

  it('不认识的键记 missing', async () => {
    const { world, engine } = setup();
    await unlock(world, engine);
    engine.playSfx('sfx.999');
    await flushMicrotasks();
    expect(engine.logs.some((e) => e.op === 'missing' && e.key === 'sfx.999')).toBe(true);
  });
});

describe('格式选择', () => {
  it('Opus 可播时取 .opus；不可播时取 .m4a', async () => {
    const a = setup();
    expect(a.engine.formatPreference).toEqual(['opus', 'm4a']);
    const b = setup({ canPlay: { opus: false, m4a: true } });
    expect(b.engine.formatPreference).toEqual(['m4a', 'opus']);
    await unlock(b.world, b.engine);
    b.engine.playSfx('sfx.049');
    await flushMicrotasks();
    expect(b.world.fetched).toEqual(['/pack/sfx.049.m4a']);
  });

  it('首选格式解码失败时换另一格式；只有一种格式时直接用它', async () => {
    const { world, engine } = setup({
      clips: { ...CLIPS, 'sfx.051': { durationMs: 100, formats: ['m4a'] } },
    });
    world.register(url('sfx.049', 'opus'), { durationMs: 300, failDecode: true });
    world.register(url('sfx.051', 'm4a'), { durationMs: 100 });
    await unlock(world, engine);
    engine.playSfx('sfx.049');
    engine.playSfx('sfx.051');
    await flushMicrotasks();
    expect(world.fetched).toEqual(['/pack/sfx.049.opus', '/pack/sfx.051.m4a', '/pack/sfx.049.m4a']);
    expect(world.ctx!.playing.length).toBe(2);
    expect(engine.logs.some((e) => e.op === 'decodeError' && e.key === 'sfx.049')).toBe(true);
  });
});

describe('语音与压低', () => {
  it('语音期间 BGM 压低 6 dB，结束后恢复', async () => {
    const { world, engine } = setup();
    await unlock(world, engine);
    const duck = nodes(world).duck.gain;
    const done = engine.speak({ key: 'voice.1077', speaker: 'seat:0' });
    await flushMicrotasks();
    expect(engine.voiceStatus?.key).toBe('voice.1077');
    expect(target(duck)).toBeCloseTo(dbToGain(-6));
    expect(engine.duckLevel).toBeCloseTo(dbToGain(-6));
    await world.advance(700);
    await expect(done).resolves.toBe('ended');
    expect(target(duck)).toBe(1);
    expect(engine.duckLevel).toBe(1);
  });

  it('多个压低取最低；逐个释放', async () => {
    const { world, engine } = setup();
    const duck = nodes(world).duck.gain;
    const a = engine.duck(-6);
    const b = engine.duck(-12);
    expect(target(duck)).toBeCloseTo(dbToGain(-12));
    b();
    expect(target(duck)).toBeCloseTo(dbToGain(-6));
    a();
    a();
    expect(target(duck)).toBe(1);
  });

  it('原版阻塞语义：后一句最早在前一句开口 1000 ms 后打断它', async () => {
    const { world, engine } = setup();
    await unlock(world, engine);
    const first = engine.speak({ key: 'voice.1078' });
    await flushMicrotasks();
    const t0 = world.clock.now;
    const second = engine.speak({ key: 'voice.1076' });
    const voiceBus = nodes(world).voice;
    const onVoiceBus = () => world.ctx!.playing.filter((s) => (s.outputs[0] as FakeGain).outputs[0] === voiceBus);
    await world.advance(990);
    expect(engine.voiceStatus?.key).toBe('voice.1078');
    await world.advance(30);
    expect(engine.voiceStatus?.key).toBe('voice.1076');
    expect(engine.voiceStatus!.startedAt - t0).toBeGreaterThanOrEqual(1000);
    // 同一时刻只有一个语音声源
    expect(onVoiceBus().length).toBe(1);
    await expect(first).resolves.toBe('interrupted');
    await world.advance(1600);
    await expect(second).resolves.toBe('ended');
    expect(onVoiceBus().length).toBe(0);
  });
});

describe('音乐：棋盘轮播', () => {
  it('解锁前只记状态；解锁后从第一首开头播，一曲放完接下一首并循环到第一首', async () => {
    const { world, engine } = setup({
      clips: {
        'music.track02': { durationMs: 3000 },
        'music.track03': { durationMs: 2000 },
      },
    });
    engine.setBoardPlaylist(['music.track02', 'music.track03']);
    engine.setBoardActive(true);
    await world.advance(500);
    expect(world.elements.every((e) => e.paused)).toBe(true);
    await unlock(world, engine);
    const board = world.elementPlaying('/pack/music.track02.opus');
    expect(board).not.toBeNull();
    expect(board!.currentTime).toBe(0);
    await world.advance(3050);
    expect(world.elementPlaying('/pack/music.track03.opus')).toBe(board);
    await world.advance(2050);
    expect(world.elementPlaying('/pack/music.track02.opus')).toBe(board);
    const ops = engine.logs.filter((e) => e.kind === 'music').map((e) => `${e.op}:${e.key ?? ''}`);
    expect(ops).toContain('board.start:music.track02');
    expect(ops.filter((o) => o.startsWith('board.next')).length).toBe(2);
    // MediaElementSource 接在 bgm 总线上（经各自的淡入淡出增益）
    expect(world.ctx!.mediaSources.length).toBe(2);
  });

  it('离开对局画面停止棋盘曲，回来从原处继续', async () => {
    const { world, engine } = setup();
    engine.setBoardPlaylist(['music.track02', 'music.track03']);
    await unlock(world, engine);
    engine.setBoardActive(true);
    await world.advance(5000);
    engine.setBoardActive(false);
    await world.advance(1000);
    const el = world.elements.find((e) => e.src === '/pack/music.track02.opus')!;
    expect(el.paused).toBe(true);
    const at = el.currentTime;
    engine.setBoardActive(true);
    expect(el.paused).toBe(false);
    expect(Math.abs(el.currentTime - at)).toBeLessThan(0.01);
  });
});

describe('音乐：场景栈', () => {
  async function boardAt(sec: number) {
    const s = setup();
    s.engine.setBoardPlaylist(['music.track02', 'music.track03', 'music.track04']);
    s.engine.setBoardActive(true);
    await unlock(s.world, s.engine);
    await s.world.advance(sec * 1000);
    const board = s.world.elementPlaying('/pack/music.track02.opus')!;
    return { ...s, board };
  }

  it('进银行切 track14；离开后棋盘曲从中断处续播（误差 ≤ 0.5 s）', async () => {
    const { world, engine, board } = await boardAt(30);
    const before = board.currentTime;
    expect(before).toBeCloseTo(30, 1);
    const token = engine.pushScene('music.track14');
    await world.advance(400);
    expect(board.paused).toBe(true);
    const scene = world.ctx!.playing;
    expect(scene.length).toBe(1);
    expect(scene[0]!.loop).toBe(true);
    expect(scene[0]!.loopEnd).toBeCloseTo(4);
    expect(engine.musicSnapshot()).toMatchObject({ mode: 'scene', key: 'music.track14', layers: ['music.track14'] });
    // 场景曲在里面循环了好几圈
    await world.advance(20_000);
    expect(world.ctx!.playing.length).toBe(1);
    engine.popScene(token);
    await world.advance(300);
    expect(world.ctx!.playing.length).toBe(0);
    expect(board.paused).toBe(false);
    expect(Math.abs(board.currentTime - 0.3 - before)).toBeLessThanOrEqual(0.5);
    const resume = engine.logs.find((e) => e.op === 'board.resume');
    expect(resume?.key).toBe('music.track02');
    expect(Math.abs(resume!.atSec! - before)).toBeLessThanOrEqual(0.5);
    const start = engine.logs.find((e) => e.op === 'scene.start');
    expect(start?.key).toBe('music.track14');
  });

  it('noResume（开局设定、结算、节日）：离开后从下一首开头播', async () => {
    const { world, engine, board } = await boardAt(10);
    const t = engine.pushScene('music.track11', { noResume: true });
    await world.advance(2000);
    engine.popScene(t);
    await world.advance(100);
    expect(board.src).toBe('/pack/music.track03.opus');
    expect(board.currentTime).toBeLessThan(0.2);
    expect(engine.musicSnapshot()?.boardIdx).toBe(1);
  });

  it('场景盖场景：揭开后被盖者从原处续播，最后回到棋盘曲断点', async () => {
    const { world, engine, board } = await boardAt(12);
    const at = board.currentTime;
    const a = engine.pushScene('music.track17');
    await world.advance(2500);
    const b = engine.pushScene('music.track14');
    await world.advance(1000);
    expect(engine.musicSnapshot()?.key).toBe('music.track14');
    engine.popScene(b);
    await flushMicrotasks();
    const resumed = engine.logs.filter((e) => e.op === 'scene.resume');
    expect(resumed.at(-1)?.key).toBe('music.track17');
    expect(resumed.at(-1)!.atSec!).toBeCloseTo(2.5, 0);
    engine.popScene(a);
    await world.advance(100);
    expect(Math.abs(board.currentTime - 0.1 - at)).toBeLessThanOrEqual(0.5);
  });

  it('弹出非栈顶层不产生可闻变化；同一首曲子的两层不重播', async () => {
    const { world, engine } = await boardAt(1);
    const a = engine.pushScene('music.track17');
    await world.advance(300);
    const b = engine.pushScene('music.track14');
    await world.advance(300);
    const src = world.ctx!.playing[0]!;
    engine.popScene(a);
    await world.advance(300);
    expect(world.ctx!.playing).toEqual([src]);
    const c = engine.pushScene('music.track14');
    await world.advance(300);
    expect(world.ctx!.playing).toEqual([src]);
    engine.popScene(b);
    await world.advance(300);
    expect(world.ctx!.playing).toEqual([src]);
    engine.popScene(c);
    await world.advance(400);
    expect(world.ctx!.playing).toEqual([]);
  });

  it('batchScenes：先弹后压同一首曲子时不重播', async () => {
    const { world, engine } = await boardAt(1);
    let t = engine.pushScene('music.track17');
    await world.advance(300);
    const src = world.ctx!.playing[0]!;
    engine.batchScenes(() => {
      engine.popScene(t);
      t = engine.pushScene('music.track17');
    });
    await world.advance(300);
    expect(world.ctx!.playing).toEqual([src]);
  });

  it('循环区间：缓冲模式用 loopStart / loopEnd，位置在区间内回绕', async () => {
    const { world, engine } = await boardAt(1);
    engine.pushScene('music.track19');
    await world.advance(100);
    const s = world.ctx!.playing[0]!;
    expect(s.loopStart).toBeCloseTo(1);
    expect(s.loopEnd).toBeCloseTo(3);
    expect(s.offset).toBeCloseTo(1);
    await world.advance(5000);
    const pos = engine.musicSnapshot()!.positionSec!;
    expect(pos).toBeGreaterThanOrEqual(1);
    expect(pos).toBeLessThan(3);
  });

  it('元素模式：整段循环用原生 loop，部分循环手动跳回', async () => {
    const { world, engine } = setup({ engine: { sceneMode: 'element' } });
    await unlock(world, engine);
    engine.pushScene('music.track14');
    await world.advance(100);
    const el = world.elementPlaying('/pack/music.track14.opus')!;
    expect(el.loop).toBe(true);
    const t = engine.pushScene('music.track19');
    await world.advance(100);
    expect(el.src).toBe('/pack/music.track19.opus');
    expect(el.loop).toBe(false);
    expect(el.currentTime).toBeCloseTo(1.1, 1);
    await world.advance(2500);
    expect(el.currentTime).toBeGreaterThanOrEqual(1);
    expect(el.currentTime).toBeLessThan(3.05);
    expect(el.paused).toBe(false);
    engine.popScene(t);
  });

  it('元素模式：来源里没有这首场景曲时记 missing，弹出它不抛错', async () => {
    const { world, engine } = setup({ engine: { sceneMode: 'element' } });
    await unlock(world, engine);
    const t = engine.pushScene('music.track99');
    await world.advance(100);
    expect(engine.logs.some((e) => e.op === 'scene.missing' && e.key === 'music.track99')).toBe(true);
    expect(() => engine.popScene(t)).not.toThrow();
    await world.advance(100);
  });

  it('场景曲解码失败时退回 <audio loop>', async () => {
    const { world, engine } = setup();
    world.register(url('music.track14', 'opus'), { durationMs: 4000, failDecode: true });
    world.register(url('music.track14', 'm4a'), { durationMs: 4000, failDecode: true });
    await unlock(world, engine);
    engine.pushScene('music.track14');
    await world.advance(100);
    expect(world.elementPlaying('/pack/music.track14.opus')?.loop).toBe(true);
    expect(engine.logs.some((e) => e.op === 'scene.decodeFallback')).toBe(true);
  });
});

describe('后台标签页', () => {
  it('隐藏时挂起上下文、暂停音乐并停掉语音；回到前台从原处续播', async () => {
    const { world, engine } = setup();
    engine.suspendWhenHidden(true);
    engine.setBoardPlaylist(['music.track02']);
    engine.setBoardActive(true);
    await unlock(world, engine);
    await world.advance(8000);
    const el = world.elementPlaying('/pack/music.track02.opus')!;
    const v = engine.speak({ key: 'voice.1078' });
    await flushMicrotasks();
    world.visibility.set(true);
    await flushMicrotasks();
    expect(engine.state).toBe('suspended');
    expect(world.ctx!.state).toBe('suspended');
    expect(el.paused).toBe(true);
    await expect(v).resolves.toBe('cancelled');
    const at = el.currentTime;
    await world.advance(30_000);
    expect(el.currentTime).toBe(at);
    engine.playSfx('sfx.049');
    world.visibility.set(false);
    await flushMicrotasks();
    expect(engine.state).toBe('running');
    expect(el.paused).toBe(false);
    expect(Math.abs(el.currentTime - at)).toBeLessThan(0.01);
    expect(world.fetched.includes('/pack/sfx.049.opus')).toBe(false);
  });
});

describe('后台恢复失败', () => {
  it('回到前台时 resume 未生效（iOS 要求手势）：退回 locked 并重新挂手势监听', async () => {
    const { world, engine } = setup();
    engine.suspendWhenHidden(true);
    await unlock(world, engine);
    expect(world.gestures.count('pointerdown')).toBe(0);
    world.visibility.set(true);
    await flushMicrotasks();
    world.ctx!.resumeWorks = false;
    world.visibility.set(false);
    await flushMicrotasks();
    expect(engine.state).toBe('locked');
    expect(world.gestures.count('pointerdown')).toBe(1);
    world.ctx!.resumeWorks = true;
    world.gesture();
    await flushMicrotasks();
    expect(engine.state).toBe('running');
  });
});

describe('来源与收尾', () => {
  it('换来源时当前曲目在原位置改用新 URL', async () => {
    const { world, engine } = setup();
    engine.setBoardPlaylist(['music.track02']);
    engine.setBoardActive(true);
    await unlock(world, engine);
    await world.advance(7000);
    world.register('/v2/music.track02', { durationMs: 60_000 });
    engine.setSources([
      { id: 'v2', resolve: (k) => (k === 'music.track02' ? '/v2/music.track02' : null), info: () => null },
    ]);
    const el = world.elementPlaying('/v2/music.track02')!;
    expect(el).not.toBeNull();
    expect(el.currentTime).toBeCloseTo(7, 1);
  });

  it('setSources 清空解码缓存并按新来源重播音乐；dispose 关闭上下文', async () => {
    const { world, engine } = setup();
    await unlock(world, engine);
    await engine.preload(['sfx.049']);
    expect(engine.cacheBytes).toBeGreaterThan(0);
    engine.setSources([testSource()]);
    expect(engine.cacheBytes).toBe(0);
    expect(engine.has('sfx.049')).toBe(true);
    expect(engine.has('nope')).toBe(false);
    engine.dispose();
    expect(engine.state).toBe('disposed');
    expect(world.ctx!.state).toBe('closed');
    engine.playSfx('sfx.049');
  });
});
