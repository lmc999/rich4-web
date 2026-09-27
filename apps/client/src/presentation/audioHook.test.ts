// 事件声音钩子（原版皮肤 A9 接线）：withEventAudio 的包装语义，以及 GameClient.setAudio 把钩子接到 EventPlayer
// （ctx.audio 端口、ctx.at 事件位置、演出结束收尾、reset / 离开房间时 reset）。
import type { GameEvent } from '@rich4/shared/engine';
import type { GameBatchMsg } from '@rich4/shared/net';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AudioDirector, audioCtxOf, type DirectorEngine } from '../audio/director';
import { testAudioMaps } from '../audio/testing/fixtures';
import { initI18n } from '../i18n';
import { memoryStorage } from '../net/identity';
import { useGameStore } from '../store/gameStore';
import { useRoomStore } from '../store/roomStore';
import { makeTestClient } from '../test/fakeTransport';
import { selfPlay } from '../test/selfPlay';
import { withEventAudio } from './audioHook';
import type { AudioPort, EventAudioHook, EventStamp, HandlerMap, PresentationContext } from './types';

beforeAll(() => {
  initI18n('original');
});

afterEach(() => {
  useGameStore.getState().clear();
  useRoomStore.getState().clear();
});

const ev = (type: string): GameEvent => ({ type }) as unknown as GameEvent;

function recorder() {
  const log: string[] = [];
  const port: AudioPort = { play: (id) => void log.push(`play:${id}`) };
  const hook: EventAudioHook & { resets: number } = {
    resets: 0,
    port,
    onEvent: (e) => {
      log.push(`start:${e.type}`);
      return () => void log.push(`end:${e.type}`);
    },
    reset() {
      hook.resets++;
    },
  };
  return { log, hook };
}

describe('withEventAudio', () => {
  it('钩子在 handler 之前开始、之后收尾；handler 抛错也收尾；钩子为 null 时原样运行', async () => {
    const { log, hook } = recorder();
    let current: EventAudioHook | null = hook;
    const handlers = {
      MONEY: async () => void log.push('handler:MONEY'),
      TOLL_PAID: async () => {
        log.push('handler:TOLL_PAID');
        throw new Error('boom');
      },
    } as unknown as HandlerMap;
    const w = withEventAudio(handlers, () => current) as unknown as Record<
      string,
      (e: GameEvent, c: PresentationContext) => Promise<void>
    >;
    const ctx = {} as PresentationContext;
    await w.MONEY!(ev('MONEY'), ctx);
    await expect(w.TOLL_PAID!(ev('TOLL_PAID'), ctx)).rejects.toThrow('boom');
    current = null;
    await w.MONEY!(ev('MONEY'), ctx);
    expect(log).toEqual([
      'start:MONEY',
      'handler:MONEY',
      'end:MONEY',
      'start:TOLL_PAID',
      'handler:TOLL_PAID',
      'end:TOLL_PAID',
      'handler:MONEY',
    ]);
    expect(w.MONEY).toBe(w.MONEY);
  });

  it('钩子抛错不影响演出；Proxy 形式的 handler 表（没有可枚举键）同样被包装', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen: string[] = [];
    const handlers = new Proxy({}, { get: (_t, p) => async () => void seen.push(String(p)) }) as HandlerMap;
    const bad: EventAudioHook = {
      port: { play: () => {} },
      onEvent: () => {
        throw new Error('audio down');
      },
      reset: () => {},
    };
    const w = withEventAudio(handlers, () => bad) as unknown as Record<
      string,
      (e: GameEvent, c: unknown) => Promise<void>
    >;
    await w.DICE_ROLLED!(ev('DICE_ROLLED'), {});
    expect(seen).toEqual(['DICE_ROLLED']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('GameClient.setAudio', () => {
  it('每个事件经钩子：ctx.audio 是钩子的端口、ctx.at 带 {epoch, seq, eventIndex}；快照 reset 与离开房间时 reset', async () => {
    const sp = selfPlay({ seed: 3, steps: 4 });
    const batch = sp.batches.find((b) => b.events.length >= 2)!;
    const seenAt: EventStamp[] = [];
    const ports: AudioPort[] = [];
    const handlers = new Proxy(
      {},
      {
        get: () => async (_e: GameEvent, ctx: PresentationContext) => {
          if (ctx.at) seenAt.push(ctx.at);
          ports.push(ctx.audio);
        },
      },
    ) as HandlerMap;
    const { client, transport } = makeTestClient({ storage: memoryStorage(), handlers });
    const { log, hook } = recorder();
    client.setAudio(hook);
    await client.createRoom();
    transport.push('game:snapshot', {
      ...sp.initial,
      seq: batch.seq - 1,
      view: sp.batches[sp.batches.indexOf(batch) - 1]?.view ?? sp.initial.view,
      serverNow: 0,
    });
    const resetsAfterSnapshot = hook.resets;
    expect(resetsAfterSnapshot).toBeGreaterThanOrEqual(1);
    transport.push('game:batch', batch);
    for (let i = 0; i < 40 && !client.player.idle; i++) {
      client.anim.advance(1000);
      await Promise.resolve();
      await Promise.resolve();
    }
    await client.player.whenIdle();
    const n = batch.events.length;
    expect(log.filter((l) => l.startsWith('start:'))).toEqual(batch.events.map((e) => `start:${e.type}`));
    expect(log.filter((l) => l.startsWith('end:'))).toHaveLength(n);
    expect(seenAt.map((a) => a.eventIndex)).toEqual(batch.events.map((_e, i) => i));
    expect(seenAt.every((a) => a.seq === batch.seq && a.epoch === batch.epoch)).toBe(true);
    expect(ports.every((p) => p === hook.port)).toBe(true);

    await client.leaveRoom();
    expect(hook.resets).toBeGreaterThan(resetsAfterSnapshot);
    const before = hook.resets;
    client.setAudio(null);
    expect(hook.resets).toBe(before + 1);
    client.stop();
  });
});

/** 只记场景栈的导演层引擎 */
function sceneStack(): DirectorEngine & { keys(): string[] } {
  const stack: { token: number; key: string }[] = [];
  let next = 1;
  return {
    keys: () => stack.map((l) => l.key),
    playSfx: () => {},
    speak: () => Promise.resolve('ended' as const),
    stopVoice: () => {},
    pushScene: (key) => {
      stack.push({ token: next, key });
      return next++;
    },
    popScene: (token) => {
      const i = stack.findIndex((l) => l.token === token);
      if (i >= 0) stack.splice(i, 1);
    },
    batchScenes: (fn) => fn(),
    setBoardPlaylist: () => {},
    setBoardActive: () => {},
    preload: () => Promise.resolve(),
  };
}

describe('后台标签页（instant）期间结束的跨事件场景曲', () => {
  it('拍卖在标签页隐藏时结束：AUCTION_ENDED 没有播放也会收起拍卖曲，回到前台不再压在棋盘曲上', async () => {
    const sp = selfPlay({ seed: 3, steps: 0 });
    const engine = sceneStack();
    const director = new AudioDirector(engine);
    director.setMaps(testAudioMaps());
    const handlers = new Proxy({}, { get: () => async () => {} }) as HandlerMap;
    const { client, transport } = makeTestClient({ storage: memoryStorage(), handlers });
    client.setAudio({
      onEvent: (e, ctx) => {
        const a = director.onEvent(e, audioCtxOf(ctx));
        return () => a.end();
      },
      port: { play: () => {} },
      reset: () => director.reset(),
      observe: (e) => director.observe(e),
    });
    await client.createRoom();
    const { epoch, seq, view } = sp.initial;
    transport.push('game:snapshot', { ...sp.initial, serverNow: 0 });
    const batch = (s: number, events: GameEvent[]): GameBatchMsg => ({
      epoch,
      seq: s,
      cause: { kind: 'intent', seat: 0 } as never,
      events,
      animMs: 0,
      view,
      pending: [],
      serverNow: 0,
    });
    const drain = async () => {
      for (let i = 0; i < 20 && !client.player.idle; i++) {
        client.anim.advance(1000);
        await Promise.resolve();
        await Promise.resolve();
      }
      await client.player.whenIdle();
    };
    transport.push(
      'game:batch',
      batch(seq + 1, [
        { type: 'AUCTION_STARTED', lot: 'L1', seller: null, source: 'card', start: 1, bidders: [0, 1] } as GameEvent,
      ]),
    );
    await drain();
    expect(engine.keys()).toEqual(['music.scene-auction']);

    client.player.setHidden(true);
    transport.push(
      'game:batch',
      batch(seq + 2, [
        { type: 'AUCTION_BID', seat: 0, price: 2 } as GameEvent,
        { type: 'AUCTION_ENDED', lot: 'L1', winner: 0, price: 2 } as GameEvent,
      ]),
    );
    await drain();
    client.player.setHidden(false);
    expect(engine.keys()).toEqual([]);
    expect(director.heldScenes).toBe(0);
    client.stop();
  });
});
