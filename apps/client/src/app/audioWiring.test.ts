// 音频接线（原版皮肤 A9 × A5）：UI 状态 → 场景（纯函数）、素材包的选取，以及 wireAudio 把导演层接到 GameClient、
// skinStore（原版皮肤 + 素材包就绪才换来源）与房间 / 对局 store（场景曲）。假 AudioContext，不出声。
import type { PackManifestV1 } from '@rich4/shared/assets';
import type { YourDecision } from '@rich4/shared/net';
import type { GameView, PendingView } from '@rich4/shared/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioSystem, browserAudioEnv } from '../audio';
import { FakeAudioWorld } from '../audio/testing/fakeAudio';
import type { GameClient } from '../net/client';
import type { EventAudioHook } from '../presentation/types';
import { resetSkinStoreForTest, useSkinStore } from '../skin/skinStore';
import type { SkinResolution } from '../skin/types';
import { useGameStore } from '../store/gameStore';
import { useRoomStore } from '../store/roomStore';
import { roomView } from '../test/roomFixtures';
import { selfPlay } from '../test/selfPlay';
import { useAccessStore } from '../ui/access/accessStore';
import { audioUiStateOf, onAudioHttpError, packForAudio, venueOf, wireAudio } from './audioWiring';

const view = (): GameView => selfPlay({ seed: 1, steps: 1 }).initial.view;

const decision = (kind: string, options: unknown = {}): YourDecision =>
  ({
    decisionId: 'd1',
    seat: 0,
    kind,
    timing: 'normal',
    options,
    defaultIntent: { type: 'DECLINE' },
    deadlineAt: null,
  }) as never;

const pending = (seat: number, kind: string): PendingView =>
  ({
    decisionId: `d${seat}`,
    seat,
    kind,
    timing: 'normal',
    deadlineAt: null,
    control: 'human',
    publicInfo: { kind, seat, lot: null, amount: null, labelKey: null },
  }) as never;

const resolution = (skin: 'original' | 'procedural'): SkinResolution => ({
  pref: 'auto',
  skin,
  board: 'procedural',
  reason: skin === 'original' ? null : 'setting',
  boardReason: null,
  mismatches: [],
  mapId: null,
  packId: null,
});

const fakeManifest = { packId: 'pack-test', entries: {}, files: {}, features: {} } as unknown as PackManifestV1;

afterEach(() => {
  useGameStore.getState().clear();
  useRoomStore.getState().clear();
  resetSkinStoreForTest();
});

describe('audioUiStateOf / venueOf', () => {
  it('没有房间 = 标题；大厅 = 开局设定；结束或收到 game:over = 结算', () => {
    const base = { view: null, decision: null, pending: [], over: false, map: null };
    expect(audioUiStateOf({ ...base, room: null })).toEqual({ screen: 'title' });
    // 原版片头播放期间标题画面不放曲子
    expect(audioUiStateOf({ ...base, room: null, intro: true })).toEqual({ screen: 'none' });
    expect(audioUiStateOf({ ...base, room: roomView({ phase: 'lobby' }), intro: true })).toEqual({ screen: 'lobby' });
    expect(audioUiStateOf({ ...base, room: roomView({ phase: 'lobby' }) })).toEqual({ screen: 'lobby' });
    expect(audioUiStateOf({ ...base, room: roomView({ phase: 'ended' }) })).toEqual({ screen: 'gameOver' });
    expect(audioUiStateOf({ ...base, room: roomView({ phase: 'playing' }), over: true }).screen).toBe('gameOver');
    expect(audioUiStateOf({ ...base, room: roomView({ phase: 'paused' }) })).toMatchObject({ screen: 'game' });
  });

  it('场所：本人的决策优先（监狱 / 医院、小游戏种类取 options）；否则取他人公开的场所决策；非场所决策不算', () => {
    expect(venueOf(decision('BAIL', { where: 'hospital' }), [], 0)).toEqual({ kind: 'BAIL', where: 'hospital' });
    expect(venueOf(decision('MINIGAME', { minigameId: 'balloon' }), [], 0)).toEqual({
      kind: 'MINIGAME',
      minigameId: 'balloon',
    });
    expect(venueOf(decision('BANK_ATM'), [], 0)).toEqual({ kind: 'BANK_ATM' });
    // 本人的回合菜单不是场所 → 看别人：他人在银行柜台
    expect(venueOf(decision('TURN_MENU'), [pending(0, 'TURN_MENU'), pending(2, 'BANK_COUNTER')], 0)).toEqual({
      kind: 'BANK_COUNTER',
    });
    // 他人的保释（分不清监狱 / 医院）与买地不算场所；本人的 pending 不重复看
    expect(venueOf(null, [pending(1, 'BAIL'), pending(2, 'BUY_LAND'), pending(0, 'SHOP')], 0)).toBeNull();
    // 观战者（me = null）看所有人的公开场所
    expect(venueOf(null, [pending(3, 'AUCTION_BID')], null)).toEqual({ kind: 'AUCTION_BID' });
  });

  it('对局中：场所 + 节日（没有地图时无节日）', () => {
    const s = audioUiStateOf({
      room: roomView({ phase: 'playing' }),
      view: view(),
      decision: decision('SHOP'),
      pending: [],
      over: false,
      map: null,
    });
    expect(s).toEqual({ screen: 'game', venue: { kind: 'SHOP' }, holiday: null });
  });

  it('packForAudio：原版皮肤且素材包就绪才用素材包', () => {
    const ready = { status: 'ready' as const, manifest: fakeManifest };
    expect(packForAudio({ pack: ready, resolution: resolution('original') })).toBe(fakeManifest);
    expect(packForAudio({ pack: ready, resolution: resolution('procedural') })).toBeNull();
    expect(packForAudio({ pack: { status: 'loading' }, resolution: resolution('original') })).toBeNull();
  });
});

describe('wireAudio', () => {
  it('接上 GameClient、按皮肤切换素材包、按房间与对局状态切场景；撤销后全部解除', async () => {
    const world = new FakeAudioWorld();
    const system = new AudioSystem({ env: world.env(), unlockOnGesture: false });
    const applied: (string | null)[] = [];
    const apply = vi.spyOn(system, 'applyPack').mockImplementation(async (m) => {
      applied.push(m?.packId ?? null);
    });
    const setUi = vi.spyOn(system.director, 'setUi');
    let hook: EventAudioHook | null = null;
    const client = {
      currentMap: null,
      setAudio: (h: EventAudioHook | null) => {
        hook = h;
      },
    } as unknown as GameClient;

    const off = wireAudio(client, { system });
    expect(hook).not.toBeNull();
    expect(hook!.port).toBeTruthy();
    // 首次：素材包未就绪 → 不换来源；没有房间 → 标题
    expect(apply).not.toHaveBeenCalled();
    expect(setUi).toHaveBeenLastCalledWith({ screen: 'title' });

    // 原版皮肤 + 素材包就绪 → 换成素材包；判定变回程序化 → 退回 ZzFX（null）
    useSkinStore.setState({ pack: { status: 'ready', manifest: fakeManifest }, resolution: resolution('original') });
    useSkinStore.setState({ resolution: resolution('procedural') });
    useSkinStore.setState({ resolution: resolution('procedural') });
    expect(applied).toEqual(['pack-test', null]);

    // 房间 → 大厅；开局 → 对局；本人进银行 → 场所；同一状态不重复 setUi
    useRoomStore.getState().setRoom(roomView({ phase: 'lobby' }));
    expect(setUi).toHaveBeenLastCalledWith({ screen: 'lobby' });
    useRoomStore.getState().setRoom(roomView({ phase: 'playing' }));
    const v = view();
    useGameStore.getState().resetTo({ epoch: 1, seq: 1, view: v, pending: [], decision: decision('BANK_ATM') });
    expect(setUi).toHaveBeenLastCalledWith({ screen: 'game', venue: { kind: 'BANK_ATM' }, holiday: null });
    const calls = setUi.mock.calls.length;
    useGameStore.getState().setAnim({ playing: true, backlogMs: 0, speed: 1, instant: false });
    expect(setUi.mock.calls.length).toBe(calls);

    // 事件钩子：reset 转给导演层；没播放就提交的事件经 observe 转给导演层（收起拍卖曲之类的跨事件场景曲）
    const reset = vi.spyOn(system.director, 'reset');
    hook!.reset();
    expect(reset).toHaveBeenCalledTimes(1);
    const observe = vi.spyOn(system.director, 'observe');
    const ended = { type: 'AUCTION_ENDED', lot: 'L1', winner: 0, price: 2 } as never;
    hook!.observe?.(ended);
    expect(observe).toHaveBeenCalledWith(ended);

    // 已接好时再次调用直接返回现有的撤销
    expect(wireAudio(client, { system })).toBe(off);
    off();
    expect(hook).toBeNull();
    useRoomStore.getState().setRoom(roomView({ phase: 'lobby' }));
    expect(setUi.mock.calls.length).toBe(calls);
    system.dispose();
  });
});

describe('素材包音频被门禁拒绝（401）', () => {
  it('browserAudioEnv 的 fetchArrayBuffer 把失败的状态码交给 onHttpError；401 → 门禁页（reason pack）', async () => {
    const seen: number[] = [];
    const fetchStub = vi.fn(async () => new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', fetchStub);
    try {
      const env = browserAudioEnv({ onHttpError: (st) => seen.push(st) });
      await expect(env.fetchArrayBuffer('/pack/audio/sfx/090.x.opus')).rejects.toThrow(/HTTP 401/);
      expect(seen).toEqual([401]);
    } finally {
      vi.unstubAllGlobals();
    }
    useAccessStore.setState({ required: null });
    onAudioHttpError(404);
    expect(useAccessStore.getState().required).toBeNull();
    onAudioHttpError(401);
    expect(useAccessStore.getState().required).toBe('pack');
    useAccessStore.setState({ required: null });
  });
});
