// 导演层：UI 场景层（节日在下、场所在上）、事件场景曲的收放、音效与语音分发、wrapHandlers、reset；
// 以及与真实 AudioEngine（假音频世界）联调：进银行切场景曲、离开续播，开局依次说宣言。
import { buildMapIndex, buildTestMap } from '@rich4/shared/data';
import type { GameEvent } from '@rich4/shared/engine';
import { describe, expect, it } from 'vitest';
import { HANDLERS } from '../presentation/handlers';
import { DICE_KNOCK } from '../presentation/soundMap';
import type { HandlerMap, PresentationContext } from '../presentation/types';
import { selfPlay } from '../test/selfPlay';
import { AudioEngine } from './AudioEngine';
import { AudioDirector, type DirectorEngine } from './director';
import type { ScenePushOptions } from './music';
import { FakeAudioWorld, flushMicrotasks } from './testing/fakeAudio';
import { slotKey, testAudioMaps } from './testing/fixtures';
import type { AudioSource } from './types';
import type { VoiceRequest } from './voice';

const map = buildMapIndex(buildTestMap());
const view = selfPlay({ seed: 1, steps: 0 }).initial.view;
const CHARS = view.players.map((p) => p.character);
const actx = (seq = 1, eventIndex = 0) => ({ view: () => view, map, epoch: 1, seq, eventIndex });

class SpyEngine implements DirectorEngine {
  ops: string[] = [];
  stack: { token: number; key: string; noResume: boolean }[] = [];
  private next = 1;
  board: string[] = [];
  boardActive = false;
  batching = 0;
  playSfx(key: string, o?: { bus?: string }): void {
    this.ops.push(`sfx ${key} ${o?.bus ?? 'sfx'}`);
  }
  speak(r: VoiceRequest) {
    this.ops.push(`voice ${r.key} ${r.policy ?? 'original'}`);
    return Promise.resolve('ended' as const);
  }
  stopVoice(): void {
    this.ops.push('stopVoice');
  }
  pushScene(key: string, o?: ScenePushOptions): number {
    const token = this.next++;
    this.stack.push({ token, key, noResume: o?.noResume === true });
    this.ops.push(`push ${key}${o?.noResume ? ' noResume' : ''}`);
    return token;
  }
  popScene(token: number): void {
    const l = this.stack.find((x) => x.token === token);
    this.stack = this.stack.filter((x) => x.token !== token);
    if (l) this.ops.push(`pop ${l.key}`);
  }
  batchScenes(fn: () => void): void {
    this.batching++;
    fn();
    this.batching--;
  }
  setBoardPlaylist(keys: readonly string[]): void {
    this.board = [...keys];
  }
  setBoardActive(on: boolean): void {
    this.boardActive = on;
  }
  preloaded: string[] = [];
  preload(keys: readonly string[]): Promise<void> {
    this.preloaded.push(...keys);
    return Promise.resolve();
  }
  get keys(): string[] {
    return this.stack.map((l) => l.key);
  }
}

function spy() {
  const e = new SpyEngine();
  const d = new AudioDirector(e);
  d.setMaps(testAudioMaps());
  return { e, d };
}

describe('UI 场景层', () => {
  it('标题 → 房间（开局设定，noResume）→ 对局（棋盘轮播）→ 银行 → 离开', () => {
    const { e, d } = spy();
    expect(e.board).toEqual(['music.board-0', 'music.board-1', 'music.board-2']);
    d.setUi({ screen: 'title' });
    expect(e.keys).toEqual(['music.scene-title']);
    d.setUi({ screen: 'lobby' });
    expect(e.stack).toEqual([expect.objectContaining({ key: 'music.scene-setup', noResume: true })]);
    expect(e.boardActive).toBe(false);
    d.setUi({ screen: 'game' });
    expect(e.keys).toEqual([]);
    expect(e.boardActive).toBe(true);
    d.setUi({ screen: 'game', venue: { kind: 'BANK_COUNTER' } });
    expect(e.keys).toEqual(['music.scene-bank']);
    // 同一场景重复设置不重挂
    const n = e.ops.length;
    d.setUi({ screen: 'game', venue: { kind: 'BANK_ATM' } });
    expect(e.ops.length).toBe(n);
    d.setUi({ screen: 'game' });
    expect(e.keys).toEqual([]);
  });

  it('节日层始终在场所层下面', () => {
    const { e, d } = spy();
    d.setUi({ screen: 'game', venue: { kind: 'SHOP' } });
    d.setUi({ screen: 'game', venue: { kind: 'SHOP' }, holiday: 'christmas' });
    expect(e.keys).toEqual(['music.scene-christmas', 'music.scene-shop']);
    expect(e.stack[0]!.noResume).toBe(true);
    d.setUi({ screen: 'game', holiday: 'christmas' });
    expect(e.keys).toEqual(['music.scene-christmas']);
    d.setUi({ screen: 'game', venue: { kind: 'MAGIC_CAST' }, holiday: 'christmas' });
    expect(e.keys).toEqual(['music.scene-christmas', 'music.scene-magic']);
    d.setUi({ screen: 'game', venue: { kind: 'MAGIC_CAST' } });
    expect(e.keys).toEqual(['music.scene-magic']);
  });

  it('按场景预载原版音效集（每组只预载一次）；进对局另预载掷骰的「咚」', () => {
    const { e, d } = spy();
    d.setUi({ screen: 'game' });
    expect(e.preloaded).toEqual(['sfx.000', 'sfx.001', 'sfx.044', 'sfx.049', 'sfx.050', 'sfx.010']);
    d.setUi({ screen: 'game', venue: { kind: 'SHOP' } });
    expect(e.preloaded.length).toBe(6);
  });

  it('素材包晚于 setUi(game) 到达（实际接线的顺序）：setMaps 之后照样按当前 UI 预载', () => {
    const e = new SpyEngine();
    const d = new AudioDirector(e);
    d.setUi({ screen: 'game' });
    // 还没有素材包：只预合成掷骰「咚」与按 GO 点击声的 ZzFX 回退
    expect(e.preloaded).toEqual(['zzfx.dice', 'zzfx.click']);
    d.setMaps(testAudioMaps());
    // 有素材包：GO 的点击声（cue.ui.go = sfx.001）已在全局音效集里
    expect(e.preloaded.slice(2)).toEqual(['sfx.000', 'sfx.001', 'sfx.044', 'sfx.049', 'sfx.050', 'sfx.010']);
    // 换一份映射表（新素材包）重新预载；没有素材包时只有 ZzFX
    d.setMaps(testAudioMaps());
    expect(e.preloaded.length).toBe(14);
    d.setMaps(null);
    expect(e.preloaded.slice(14)).toEqual(['zzfx.dice', 'zzfx.click']);
  });

  it('没有素材包：场景曲与语音静默，音效走 ZzFX', () => {
    const e = new SpyEngine();
    const d = new AudioDirector(e);
    d.setUi({ screen: 'game', venue: { kind: 'BANK_COUNTER' } });
    expect(e.keys).toEqual([]);
    const a = d.onEvent({ type: 'LAND_BOUGHT', seat: 0, lot: 'L1', price: 1 }, actx());
    expect(a.sfx?.key).toBe('zzfx.stamp');
    expect(a.voices).toEqual([]);
    expect(e.ops).toEqual(['sfx zzfx.stamp sfx']);
  });

  it('setMaps 换包后按当前 UI 重新挂层', () => {
    const e = new SpyEngine();
    const d = new AudioDirector(e);
    d.setUi({ screen: 'game', venue: { kind: 'BANK_COUNTER' } });
    d.setMaps(testAudioMaps());
    expect(e.keys).toEqual(['music.scene-bank']);
    d.setMaps(null);
    expect(e.keys).toEqual([]);
    expect(e.board).toEqual([]);
  });
});

describe('事件', () => {
  it('音效与语音分发；事件场景曲在 end() 时收起', () => {
    const { e, d } = spy();
    const seat = { t: 'seat', seat: 2 } as const;
    const a = d.onEvent(
      { type: 'CONFINED', actor: seat, where: 'jail', days: 3, total: 3, cause: { k: 'system', ref: null, by: null } },
      actx(),
    );
    expect(a.scene).toBe('music.scene-jail');
    expect(e.keys).toEqual(['music.scene-jail']);
    expect(e.ops).toContain(`voice ${slotKey(CHARS[2]!, 19)} original`);
    expect(e.ops).toContain('sfx zzfx.siren sfx');
    a.end();
    a.end();
    expect(e.keys).toEqual([]);
  });

  it('observe：没播放的事件只收起以它为终点的场景曲，不放任何声音', () => {
    const { e, d } = spy();
    d.onEvent(
      { type: 'AUCTION_STARTED', lot: 'L1', seller: null, source: 'card', start: 1, bidders: [0, 1] },
      actx(),
    ).end();
    expect(d.heldScenes).toBe(1);
    const before = e.ops.length;
    d.observe({ type: 'AUCTION_BID', seat: 0, price: 2 } as GameEvent);
    expect(e.keys).toEqual(['music.scene-auction']);
    d.observe({ type: 'AUCTION_ENDED', lot: 'L1', winner: 0, price: 2 } as GameEvent);
    expect(e.keys).toEqual([]);
    expect(d.heldScenes).toBe(0);
    expect(e.ops.slice(before)).toEqual(['pop music.scene-auction']);
  });

  it('拍卖曲从 AUCTION_STARTED 保持到 AUCTION_ENDED；结算曲一直保持到 reset', () => {
    const { e, d } = spy();
    d.onEvent(
      { type: 'AUCTION_STARTED', lot: 'L1', seller: null, source: 'card', start: 1, bidders: [0, 1] },
      actx(),
    ).end();
    expect(e.keys).toEqual(['music.scene-auction']);
    d.onEvent({ type: 'AUCTION_BID', seat: 0, price: 2 }, actx()).end();
    expect(e.keys).toEqual(['music.scene-auction']);
    d.onEvent({ type: 'AUCTION_ENDED', lot: 'L1', winner: 0, price: 2 }, actx()).end();
    expect(e.keys).toEqual([]);
    d.onEvent(
      {
        type: 'GAME_OVER',
        result: { reason: 'timeLimit', code: 2, winner: 1, date: 0, elapsedDays: 1, ranking: [] },
      },
      actx(),
    ).end();
    expect(e.stack).toEqual([expect.objectContaining({ key: 'music.scene-gameOver', noResume: true })]);
    expect(e.ops).toContain(`voice ${slotKey(CHARS[1]!, 24)} original`);
    d.reset();
    expect(e.keys).toEqual([]);
    expect(e.ops.at(-1)).toBe('stopVoice');
  });

  it('开局：四人依次排队说宣言', () => {
    const { e, d } = spy();
    d.onEvent({ type: 'GAME_STARTED', seats: [0, 1, 2, 3], date: 20050505 }, actx());
    expect(e.ops.filter((o) => o.startsWith('voice'))).toEqual(CHARS.map((c) => `voice ${slotKey(c, 26)} queue`));
  });

  it('guessOriginal / flicSfx 选项', () => {
    const { e, d } = spy();
    const move: GameEvent = { type: 'MOVE_SEGMENT', actor: { t: 'seat', seat: 0 }, path: [1, 2], remaining: 0 };
    const vwalk = structuredClone(view);
    vwalk.players[0]!.vehicle = 'walk';
    const c = { ...actx(), view: () => vwalk };
    expect(d.onEvent(move, c).sfx?.key).toBe('zzfx.step');
    d.setOptions({ guessOriginal: true });
    expect(d.onEvent(move, c).sfx?.key).toBe('sfx.044');
    d.setOptions({ flicSfx: true });
    expect(d.onEvent({ type: 'POINTS_GAINED', seat: 0, amount: 10, source: 'square' }, c).sfx).toBeNull();
    expect(e.ops.filter((o) => o.startsWith('sfx'))).toEqual(['sfx zzfx.step sfx', 'sfx sfx.044 sfx']);
  });

  it('掷骰（timed）：事件开始时不放；handler 按演出时刻经 playCue 放原版 Effect#10，没有素材包时放 ZzFX 预设 dice', () => {
    const { e, d } = spy();
    const roll: GameEvent = { type: 'DICE_ROLLED', seat: 0, dice: [3, 4], steps: 7, forced: false, diceCount: 2 };
    const a = d.onEvent(roll, actx());
    expect(a.sfx).toBeNull();
    expect(e.ops.filter((o) => o.startsWith('sfx'))).toEqual([]);
    expect(d.playCue(DICE_KNOCK)?.key).toBe('sfx.010');
    expect(d.playCue(DICE_KNOCK)?.key).toBe('sfx.010');
    expect(e.ops).toEqual(['sfx sfx.010 sfx', 'sfx sfx.010 sfx']);
    const bare = new SpyEngine();
    const d2 = new AudioDirector(bare);
    expect(d2.playCue(DICE_KNOCK)?.key).toBe('zzfx.dice');
    expect(bare.ops).toEqual(['sfx zzfx.dice sfx']);
  });

  it('界面音：guess 默认 ZzFX，走 ui 总线', () => {
    const { e, d } = spy();
    expect(d.uiCue('click')?.key).toBe('zzfx.click');
    d.setOptions({ guessOriginal: true });
    expect(d.uiCue('click')?.key).toBe('sfx.001');
    expect(d.uiCue('tick')?.key).toBe('zzfx.tick');
    expect(e.ops).toEqual(['sfx zzfx.click ui', 'sfx sfx.001 ui', 'sfx zzfx.tick ui']);
  });

  it('GO 钮的点击声：cue.ui.go 是 exe 置信度（0x417ac9 = Effect#1），不开 guessOriginal 也用原版；没有素材包时 ZzFX click', () => {
    const { e, d } = spy();
    expect(d.uiCue('go')?.key).toBe('sfx.001');
    expect(e.ops).toEqual(['sfx sfx.001 ui']);
    const bare = new SpyEngine();
    expect(new AudioDirector(bare).uiCue('go')?.key).toBe('zzfx.click');
    expect(bare.ops).toEqual(['sfx zzfx.click ui']);
  });

  it('决策倒计时提示音：只用 ZzFX（素材包里没有对应音效），走音效总线；可预载', async () => {
    const { e, d } = spy();
    d.setOptions({ guessOriginal: true });
    expect(d.uiCue('countdown')?.key).toBe('zzfx.countdown');
    expect(d.uiCue('countdownFinal')?.key).toBe('zzfx.countdownFinal');
    expect(e.ops).toEqual(['sfx zzfx.countdown sfx', 'sfx zzfx.countdownFinal sfx']);
    const before = e.preloaded.length;
    await d.preloadUiCues(['countdown', 'countdownFinal']);
    expect(e.preloaded.slice(before)).toEqual(['zzfx.countdown', 'zzfx.countdownFinal']);
  });

  it('wrapHandlers：handler 抛错或被中止时仍收起事件场景曲；ctx.at 决定语音种子', async () => {
    const { e, d } = spy();
    let calls = 0;
    const handlers = { ...HANDLERS } as Record<string, unknown>;
    handlers.BANKRUPT = async () => {
      calls++;
      expect(e.keys).toEqual(['music.scene-bankrupt']);
      throw new Error('boom');
    };
    const wrapped = d.wrapHandlers(handlers as unknown as HandlerMap);
    expect(Object.keys(wrapped).sort()).toEqual(Object.keys(HANDLERS).sort());
    const ctx = {
      view: () => view,
      map,
      at: { epoch: 1, seq: 9, eventIndex: 2 },
    } as unknown as PresentationContext;
    await expect(
      wrapped.BANKRUPT({ type: 'BANKRUPT', seat: 0, cause: { k: 'system', ref: null, by: null }, creditor: null }, ctx),
    ).rejects.toThrow('boom');
    expect(calls).toBe(1);
    expect(e.keys).toEqual([]);
  });
});

describe('与 AudioEngine 联调（假音频世界）', () => {
  function world() {
    const w = new FakeAudioWorld();
    const maps = testAudioMaps();
    const keys = [
      ...maps.musicMap!.board.map((t) => t.key),
      ...Object.values(maps.musicMap!.scenes).map((s) => s!.key),
    ];
    const clip = (k: string) => (k.startsWith('music.board') ? 120_000 : k.startsWith('music.scene') ? 5_000 : 800);
    const src: AudioSource = {
      id: 't',
      resolve: (k) => `/p/${k}`,
      info: (k) => (k.startsWith('music.scene') ? { durationMs: 5000, loop: { startMs: 0, endMs: 5000 } } : null),
    };
    for (const k of keys) w.register(`/p/${k}`, { durationMs: clip(k) });
    for (const c of maps.voiceMap!.characters)
      for (const s of c.slots) for (const l of s) w.register(`/p/${l.key}`, { durationMs: 1500 });
    const engine = new AudioEngine({ env: w.env(), sources: [src] });
    const d = new AudioDirector(engine);
    d.setMaps(maps);
    return { w, engine, d };
  }

  it('进银行切 track14 同位的场景曲，离开后棋盘曲续播误差 ≤ 0.5 s', async () => {
    const { w, engine, d } = world();
    engine.installUnlock();
    w.gesture();
    await flushMicrotasks();
    d.setUi({ screen: 'game' });
    await w.advance(42_000);
    const board = w.elementPlaying('/p/music.board-0')!;
    const at = board.currentTime;
    d.setUi({ screen: 'game', venue: { kind: 'BANK_COUNTER' } });
    await w.advance(300);
    expect(engine.musicSnapshot()?.key).toBe('music.scene-bank');
    expect(board.paused).toBe(true);
    await w.advance(15_000);
    d.setUi({ screen: 'game' });
    await w.advance(50);
    expect(board.paused).toBe(false);
    expect(Math.abs(board.currentTime - 0.05 - at)).toBeLessThanOrEqual(0.5);
    const log = engine.logs.filter((x) => x.kind === 'music').map((x) => `${x.op} ${x.key ?? ''}`);
    expect(log).toEqual(
      expect.arrayContaining([
        'board.start music.board-0',
        'scene.start music.scene-bank',
        'board.resume music.board-0',
      ]),
    );
  });

  it('开局宣言按座位依次开口，各自说完整句', async () => {
    const { w, engine, d } = world();
    engine.installUnlock();
    w.gesture();
    await flushMicrotasks();
    d.onEvent({ type: 'GAME_STARTED', seats: [0, 1, 2, 3], date: 20050505 }, actx());
    await w.advance(7000);
    const starts = engine.logs.filter((x) => x.kind === 'voice' && x.op === 'start');
    expect(starts.map((x) => x.key)).toEqual(CHARS.map((c) => slotKey(c, 26)));
    const gaps = starts.slice(1).map((x, i) => x.t - starts[i]!.t);
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(1500);
  });
});
