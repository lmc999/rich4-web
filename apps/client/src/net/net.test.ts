// 网络层：身份与 token、时钟校准、路由穷举、GameClient 的房间 / 对局操作（假传输）
import { S2C_EVENTS, TOKEN_RE } from '@rich4/shared/net';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n, setUiLanguage } from '../i18n';
import { NULL_BOARD } from '../presentation/types';
import { useChatStore } from '../store/chatStore';
import { useGameStore } from '../store/gameStore';
import { useRoomStore } from '../store/roomStore';
import { useSettingsStore } from '../store/settingsStore';
import { useUiStore } from '../store/uiStore';
import { makeTestClient } from '../test/fakeTransport';
import { roomView } from '../test/roomFixtures';
import { selfPlay } from '../test/selfPlay';
import { ClockSync, median } from './clock';
import {
  base64url,
  defaultNickname,
  generateToken,
  LAST_ROOM_KEY,
  loadLastRoom,
  loadToken,
  memoryStorage,
  saveLastRoom,
  TOKEN_KEY,
} from './identity';
import { attachRouter } from './router';

beforeAll(() => {
  initI18n('original');
});

afterEach(() => {
  useGameStore.getState().clear();
  useRoomStore.getState().clear();
  useChatStore.getState().clear();
  useUiStore.getState().clear();
});

describe('identity', () => {
  it('base64url 与 token（16 字节 → 22 字符，满足 TOKEN_RE）', () => {
    expect(base64url(new Uint8Array([0xff, 0xee, 0xdd]))).toBe('_-7d');
    expect(base64url(new Uint8Array([1]))).toBe('AQ');
    expect(base64url(new Uint8Array([1, 2]))).toBe('AQI');
    const t = generateToken((b) => b.fill(7));
    expect(t).toHaveLength(22);
    expect(TOKEN_RE.test(t)).toBe(true);
  });

  it('loadToken 持久化并复用；非法值重新生成', () => {
    const st = memoryStorage();
    const a = loadToken(st);
    expect(st.getItem(TOKEN_KEY)).toBe(a);
    expect(loadToken(st)).toBe(a);
    st.setItem(TOKEN_KEY, 'bad token!');
    expect(loadToken(st)).not.toBe('bad token!');
  });

  it('lastRoom 读写与容错', () => {
    const st = memoryStorage();
    expect(loadLastRoom(st)).toBeNull();
    saveLastRoom({ code: '123456', epoch: 2, lastSeq: 9 }, st);
    expect(loadLastRoom(st)).toEqual({ code: '123456', epoch: 2, lastSeq: 9 });
    st.setItem(LAST_ROOM_KEY, '{oops');
    expect(loadLastRoom(st)).toBeNull();
  });

  it('默认昵称', () => {
    expect(defaultNickname((b) => b.fill(0))).toBe('玩家0000');
  });
});

describe('ClockSync', () => {
  it('offset = serverNow + rtt/2 − now，取最近 5 次中位数；无样本时用粗校准', async () => {
    let now = 1000;
    const c = new ClockSync(
      async (t0) => ({ t0, serverNow: 5000 }),
      () => now,
    );
    c.coarse(1500);
    expect(c.offsetMs).toBe(500);
    now = 1100;
    c.addSample(1000, 5000, 1100); // rtt 100 → offset 5000+50-1100 = 3950
    expect(c.offsetMs).toBe(3950);
    c.coarse(99999); // 有样本后忽略粗校准
    expect(c.offsetMs).toBe(3950);
    for (const off of [10, 20, 30, 40, 50]) c.addSample(0, off, 0);
    expect(c.sampleCount).toBe(5);
    expect(c.offsetMs).toBe(30);
    expect(c.remainingMs(null)).toBeNull();
    expect(c.remainingMs(now + 30 + 500)).toBe(500);
    expect(median([3, 1, 2, 4])).toBe(2.5);
  });
});

describe('router', () => {
  it('attachRouter 注册全部 S2C 事件并可注销', () => {
    const { transport } = makeTestClient();
    const hit: string[] = [];
    const routes = Object.fromEntries(S2C_EVENTS.map((e) => [e, () => hit.push(e)])) as never;
    const off = attachRouter(transport, routes);
    transport.push('server:notice', { kind: 'info', message: 'x' });
    expect(hit).toEqual(['server:notice']);
    off();
    transport.push('server:notice', { kind: 'info', message: 'x' });
    expect(hit).toHaveLength(1);
  });
});

describe('GameClient', () => {
  it('建房、room:state 入库、记住 lastRoom', async () => {
    const storage = memoryStorage();
    const { client, transport } = makeTestClient({ storage });
    const r = await client.createRoom({ visibility: 'public' });
    expect(r.ok).toBe(true);
    expect(transport.payloads('room:create')[0]).toEqual({ settings: { visibility: 'public' } });
    transport.push('room:state', roomView({ code: '123456' }));
    expect(useRoomStore.getState().room?.code).toBe('123456');
    expect(loadLastRoom(storage)?.code).toBe('123456');
    client.stop();
  });

  it('小游戏模块安装前到达的观战票据与帧先缓存，安装时交出；交出之后不再缓存（刷新、中途加入）', () => {
    const { client, transport } = makeTestClient({ storage: memoryStorage() });
    client.start();
    const ticket = { sessionId: 's1' } as never;
    transport.push('game:minigameFrames', { sessionId: 's1', seq: 0, events: [] });
    transport.push('game:minigameWatch', { ticket, mode: 'live', log: null });
    expect(client.takeMinigameBacklog().map((m) => m.event)).toEqual(['game:minigameFrames', 'game:minigameWatch']);
    transport.push('game:minigameFrames', { sessionId: 's1', seq: 1, events: [] });
    expect(client.takeMinigameBacklog()).toEqual([]);
    client.stop();
  });

  it('enterRoom：本机记着房间先 resume；满员时自动改为观战', async () => {
    const storage = memoryStorage();
    saveLastRoom({ code: '222222', epoch: 1, lastSeq: 3 }, storage);
    const { client, transport } = makeTestClient({ storage });
    const a = await client.enterRoom('222222', 'player');
    expect(a.ok).toBe(true);
    expect(transport.sent.map((s) => s.event)).toContain('room:resume');
    client.stop();

    const t2 = makeTestClient({ storage: memoryStorage() });
    t2.transport.respond('room:join', (p) =>
      p.role === 'player'
        ? { ok: false as const, error: { code: 'ROOM_FULL' as const, message: '房间已满' } }
        : { ok: true, data: { you: { role: 'spectator' as const, id: 'sp1', isHost: false as const } } },
    );
    const b = await t2.client.enterRoom('333333', 'player');
    expect(b).toEqual({ ok: true, data: { role: 'spectator', fellBack: true } });
    expect(t2.transport.payloads('room:join').map((p) => p.role)).toEqual(['player', 'spectator']);
    t2.client.stop();
  });

  it('并发 enterRoom 合并为一次 join', async () => {
    const { client, transport } = makeTestClient({ storage: memoryStorage() });
    await Promise.all([client.enterRoom('444444', 'player'), client.enterRoom('444444', 'player')]);
    expect(transport.payloads('room:join')).toHaveLength(1);
    client.stop();
  });

  it('startSolo：私密房、不限时、不许观战，补 3 个电脑，开局', async () => {
    const { client, transport } = makeTestClient({ storage: memoryStorage() });
    const r = await client.startSolo();
    expect(r.ok).toBe(true);
    expect(transport.payloads('room:create')[0]).toEqual({
      settings: { visibility: 'private', allowSpectators: false, timerPreset: 'off' },
    });
    expect(transport.payloads('room:setSeatAi').map((p) => p.seat)).toEqual([1, 2, 3]);
    // 连上后的时钟补采（time:ping）与房间请求交错，不计
    expect(transport.sent.filter((x) => x.event !== 'time:ping').at(-1)?.event).toBe('room:start');
    client.stop();
  });

  it('快照 → 显示态；batch 播放后提交决策；act 发 game:act 并锁定，失败解锁并提示', async () => {
    const sp = selfPlay({ seed: 2, steps: 30 });
    const { client, transport } = makeTestClient({ storage: memoryStorage(), instant: true });
    client.start();
    transport.push('game:snapshot', { ...sp.initial, serverNow: 0 });
    expect(useGameStore.getState().view).toEqual(sp.initial.view);
    const i = sp.batches.findIndex((b) => b.yourDecision);
    for (let k = 0; k <= i; k++) transport.push('game:batch', sp.batches[k]!);
    await client.player.whenIdle();
    const d = useGameStore.getState().decision;
    expect(d?.decisionId).toBe(sp.batches[i]!.yourDecision!.decisionId);

    transport.respond('game:act', () => ({ ok: false, error: { code: 'STALE_DECISION', message: 'x' } }));
    const r = await client.act({ type: 'ROLL' });
    expect(r.ok).toBe(false);
    expect(transport.payloads('game:act')[0]).toMatchObject({ decisionId: d!.decisionId, intent: { type: 'ROLL' } });
    expect(useGameStore.getState().submitting).toBeNull();
    expect(useUiStore.getState().toasts.at(-1)?.text).toBe('已超时，电脑代为决定');

    transport.respond('game:act', () => ({ ok: true, data: { seq: 99 } }));
    await client.act({ type: 'ROLL', dice: 1 });
    expect(useGameStore.getState().submitting).toBe(d!.decisionId);
    client.stop();
  });

  it('界面语言切换（原版皮肤判定完成、zh-TW 就绪）之前生成的日志行按新语言重排；stop 之后不再跟随', async () => {
    const sp = selfPlay({ seed: 2, steps: 30 });
    const { client, transport } = makeTestClient({ storage: memoryStorage(), instant: true });
    client.start();
    transport.push('game:snapshot', { ...sp.initial, serverNow: 0 });
    for (const b of sp.batches.slice(0, 12)) transport.push('game:batch', b);
    await client.player.whenIdle();
    const before = useGameStore.getState().log.map((l) => l.text);
    expect(before.length).toBeGreaterThan(3);
    try {
      expect(await setUiLanguage('zh-TW')).toBe(true);
      const after = useGameStore.getState().log.map((l) => l.text);
      expect(after).toHaveLength(before.length);
      expect(after).not.toEqual(before);
      expect(after.filter((t, i) => t !== before[i]).length).toBeGreaterThan(0);
      // 切回简体：与最初一致（重排是纯函数，不累积）
      await setUiLanguage('zh-CN');
      expect(useGameStore.getState().log.map((l) => l.text)).toEqual(before);
      client.stop();
      await setUiLanguage('zh-TW');
      expect(useGameStore.getState().log.map((l) => l.text)).toEqual(before);
    } finally {
      await setUiLanguage('zh-CN');
    }
  });

  it('断档的 batch 触发 game:resync；room:closed 清空并记录原因', async () => {
    const sp = selfPlay({ seed: 4, steps: 5 });
    const { client, transport } = makeTestClient({ storage: memoryStorage(), instant: true });
    client.start();
    transport.push('game:snapshot', { ...sp.initial, serverNow: 0 });
    transport.push('game:batch', sp.batches[1]!);
    expect(transport.payloads('game:resync')).toHaveLength(1);
    await client.createRoom();
    transport.push('room:closed', { reason: 'kicked' });
    expect(useRoomStore.getState().closed).toEqual({ code: '123456', reason: 'kicked' });
    expect(useGameStore.getState().view).toBeNull();
    client.stop();
  });

  it('聊天与表情进入 chatStore；app:error 与 server:notice 变成 toast', () => {
    const { client, transport } = makeTestClient({ storage: memoryStorage() });
    client.start();
    transport.push('chat:history', {
      messages: [
        { id: 'm1', ts: 1, from: { kind: 'system' }, system: { key: 'internalError', params: {} }, audience: 'all' },
      ],
    });
    transport.push('chat:message', {
      id: 'm2',
      ts: 2,
      from: { kind: 'seat', seat: 1, nickname: 'B' },
      text: 'hi',
      audience: 'all',
    });
    transport.push('chat:emote', { id: 'e1', ts: 3, from: { kind: 'seat', seat: 1, nickname: 'B' }, emoteId: 'laugh' });
    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(useChatStore.getState().bubbles[1]?.emoteId).toBe('laugh');
    transport.push('app:error', { code: 'RATE_LIMITED', message: 'x' });
    expect(useUiStore.getState().toasts.at(-1)?.text).toBe('操作太频繁，请稍后再试');
    client.stop();
  });

  it('断线重连：已在房间里时自动 room:resume（带 lastSeq / epoch）', async () => {
    const sp = selfPlay({ seed: 5, steps: 3 });
    const { client, transport } = makeTestClient({ storage: memoryStorage(), instant: true });
    await client.createRoom();
    transport.push('game:snapshot', { ...sp.initial, serverNow: 0 });
    transport.push('game:batch', sp.batches[0]!);
    await client.player.whenIdle();
    transport.clearSent();
    transport.setStatus('reconnecting', 1);
    transport.setStatus('open');
    await Promise.resolve();
    expect(transport.payloads('room:resume')[0]).toEqual({ code: '123456', lastSeq: 1, epoch: 1 });
    client.stop();
  });

  it('act：同一决策已在提交中（或已提交、等下一批）时不再发 game:act，也不弹「已超时」', async () => {
    const { client, transport } = makeTestClient({ storage: memoryStorage() });
    useGameStore.getState().setSubmitting('d7');
    const r = await client.act({ type: 'ROLL' }, 'd7');
    expect(r).toMatchObject({ ok: false, error: { code: 'STALE_DECISION', details: { reason: 'alreadySubmitted' } } });
    expect(transport.payloads('game:act')).toEqual([]);
    expect(useUiStore.getState().toasts).toEqual([]);
    expect(useGameStore.getState().submitting).toBe('d7');
    client.stop();
  });

  it('errorText：传输层的本地错误按 reason 给出具体文案', () => {
    const { client } = makeTestClient({ storage: memoryStorage() });
    expect(client.errorText({ code: 'INTERNAL', message: 'x', details: { reason: 'timeout' } })).toBe(
      '请求超时，请检查网络',
    );
    expect(client.errorText({ code: 'INTERNAL', message: 'x', details: { reason: 'replaced' } })).toContain('其他页面');
    expect(client.errorText({ code: 'INTERNAL', message: 'x', details: { reason: 'createGameFailed' } })).toBe(
      '服务器内部错误',
    );
    expect(client.errorText({ code: 'ROOM_FULL', message: 'x' })).toBe('房间已满');
  });

  it('棋盘卸载时中止正在播放的演出；handler 之后拿到的是空棋盘', async () => {
    const sp = selfPlay({ seed: 5, steps: 3 });
    const { client, transport } = makeTestClient({ storage: memoryStorage() });
    await client.createRoom();
    transport.push('game:snapshot', { ...sp.initial, serverNow: 0 });
    const calls: string[] = [];
    const board = new Proxy(NULL_BOARD, {
      get(t, k) {
        const v = (t as unknown as Record<string | symbol, unknown>)[k];
        if (typeof v !== 'function') return v;
        return (...a: unknown[]) => {
          calls.push(String(k));
          return (v as (...x: unknown[]) => unknown).apply(t, a);
        };
      },
    });
    client.attachBoard(board);
    const skip = vi.spyOn(client.player, 'skipAll');
    transport.push('game:batch', sp.batches[0]!);
    expect(client.player.idle).toBe(false);
    client.attachBoard(null);
    expect(skip).toHaveBeenCalledTimes(1);
    const before = calls.length;
    await client.player.whenIdle();
    // 卸载之后不再调用旧棋盘（批尾 syncBoard、后续事件都落到 NULL_BOARD）
    expect(calls.slice(before)).toEqual([]);
    // 空棋盘时再卸载不重复 skip
    client.attachBoard(null);
    expect(skip).toHaveBeenCalledTimes(1);
    client.stop();
  });

  it('reset 之后，被中止的 handler 收尾拿到的是空棋盘与空界面：不会用旧时间线覆盖刚同步好的棋盘', async () => {
    const sp = selfPlay({ seed: 5, steps: 3 });
    const log: string[] = [];
    let entered = 0;
    const handlers = new Proxy(
      {},
      {
        get:
          () =>
          async (
            _e: unknown,
            ctx: {
              wait(ms: number): Promise<void>;
              board: { placeActor(s: number, n: number): void };
              ui: { toast(t: string): void };
            },
          ) => {
            entered++;
            await ctx.wait(5000);
            ctx.board.placeActor(0, 99);
            ctx.ui.toast('旧时间线的提示');
          },
      },
    ) as never;
    const { client, transport } = makeTestClient({ storage: memoryStorage(), handlers });
    await client.createRoom();
    transport.push('game:snapshot', { ...sp.initial, serverNow: 0 });
    const board = {
      ...NULL_BOARD,
      ready: true,
      syncView: () => void log.push('syncView'),
      placeActor: (_s: number, n: number) => void log.push(`placeActor:${n}`),
    };
    client.attachBoard(board);
    log.length = 0;
    transport.push('game:batch', sp.batches[0]!);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(entered).toBe(1);
    transport.push('game:snapshot', { ...sp.initial, serverNow: 0 });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(log).toEqual(['syncView']);
    expect(useUiStore.getState().toasts.map((x) => x.text)).not.toContain('旧时间线的提示');
    client.stop();
  });

  it('昵称变化：已连接且不在对局中时断开重连（握手重新带上昵称）；对局中不重连', async () => {
    const { client, transport } = makeTestClient({ storage: memoryStorage() });
    await client.listPublicRooms();
    expect(transport.status).toBe('open');
    const statuses: string[] = [];
    transport.onStatus((st) => statuses.push(st));
    const prev = useSettingsStore.getState().nickname;
    try {
      useSettingsStore.getState().setNickname('新昵称');
      expect(statuses).toEqual(['closed', 'open']);
      statuses.length = 0;
      transport.push('room:state', roomView({ code: '123456', phase: 'playing' }));
      useSettingsStore.getState().setNickname('对局中改名');
      expect(statuses).toEqual([]);
    } finally {
      useSettingsStore.getState().setNickname(prev);
      client.stop();
    }
  });

  it('动画时钟驱动：帧推进抛错也不会打断 rAF 链', () => {
    const queue: ((t: number) => void)[] = [];
    const g = globalThis as unknown as { requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown };
    const saved = { raf: g.requestAnimationFrame, caf: g.cancelAnimationFrame };
    g.requestAnimationFrame = (cb: (t: number) => void) => queue.push(cb);
    g.cancelAnimationFrame = () => {};
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { client } = makeTestClient({ storage: memoryStorage(), driveClock: true });
      client.start();
      client.anim.advance = () => {
        throw new TypeError('boom');
      };
      for (let i = 0; i < 3; i++) {
        const cb = queue.shift();
        expect(cb).toBeDefined();
        const t0 = performance.now();
        while (performance.now() - t0 < 2) {
          // 等真实时间走一点，保证本帧 dt > 0
        }
        cb!(performance.now());
      }
      expect(queue).toHaveLength(1);
      expect(err).toHaveBeenCalled();
      client.stop();
    } finally {
      err.mockRestore();
      g.requestAnimationFrame = saved.raf;
      g.cancelAnimationFrame = saved.caf;
    }
  });
});

describe('ClockSync：只在连接打开时采样', () => {
  it('未连接时跳过（握手时间不算进 RTT）；burst 连续补采', async () => {
    let open = false;
    let pings = 0;
    const c = new ClockSync(
      async (t0) => {
        pings++;
        return { t0, serverNow: 1000 };
      },
      () => 0,
      15_000,
      () => open,
    );
    expect(await c.sampleOnce()).toBe(false);
    expect(pings).toBe(0);
    open = true;
    await c.burst(3);
    expect(pings).toBe(3);
    expect(c.sampleCount).toBe(3);
    expect(c.offsetMs).toBe(1000);
  });
});
