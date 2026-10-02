// 开局飞行动画（client-dom）：原版房间页亲眼看到大厅 → 对局（或单机页刚开局）时播该图的 Fly 视频，同一局只播一次；
// 读档开局、刷新 / 重连（进页时已在对局中）、观战、?anim=instant、缺条目时不播；可跳过（按钮、Esc）；播放期间暂缓
// 事件回放、音频导演层不放棋盘曲；轮到本人决策时跳过钮醒目。
import type { RoomView } from '@rich4/shared/net';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { ClientProvider } from '../../../app/services';
import type { PackClient } from '../../../skin/pack/PackClient';
import { resetSkinStoreForTest } from '../../../skin/skinStore';
import { useGameStore } from '../../../store/gameStore';
import { useRoomStore } from '../../../store/roomStore';
import { useUiStore } from '../../../store/uiStore';
import { makeTestClient } from '../../../test/fakeTransport';
import { roomView } from '../../../test/roomFixtures';
import { installResizeObserver } from '../../decisions/testing';
import { resetClassicAssetsForTest } from '../assets';
import { installSceneAssets } from '../common/testing';
import ClassicRoomScreen from './ClassicRoomScreen';
import { FLY_FRESH_KEY, FLY_SEEN_KEY, markSoloFresh } from './FlyVideo';

vi.mock('../../screens/GameScreen', () => ({
  default: () => <div data-testid="screen-game">game</div>,
}));

const flags = { animInstant: false, audioOff: true, test: false };
vi.mock('../../../app/flags', async (orig) => ({
  ...(await orig<typeof import('../../../app/flags')>()),
  appFlags: () => flags,
}));

installResizeObserver();
vi.setConfig({ testTimeout: 20_000 });

/** 素材包：四段飞行动画（缺省全有；without 里的键不可用） */
function packWithFly(without: readonly string[] = []): void {
  const video = (lp: string) => ({
    type: 'video',
    group: 'video',
    confidence: 'exe',
    src: [],
    files: { mp4: lp },
    w: 640,
    h: 480,
    durationMs: 6688,
  });
  const entries: Record<string, unknown> = {
    'video.flytw': video('video/flytw.mp4'),
    'video.flychina': video('video/flychina.mp4'),
    'video.flyjp': video('video/flyjp.mp4'),
    'video.flyus': video('video/flyus.mp4'),
  };
  const client = {
    usableEntry: (k: string) => (without.includes(k) ? null : (entries[k] ?? null)),
    fileUrl: (lp: string) => `/pack/${lp}`,
  };
  resetSkinStoreForTest({ client: client as unknown as PackClient });
}

function onMap(mapId: string, over: Partial<RoomView> = {}): RoomView {
  const base = roomView();
  return roomView({ ...over, settings: { ...base.settings, game: { ...base.settings.game, mapId } } });
}

function renderRoom(ui: ReactElement = <ClassicRoomScreen code="123456" />) {
  const loc = memoryLocation({ path: '/r/123456', record: true });
  const t = makeTestClient();
  const utils = render(
    <ClientProvider client={t.client}>
      <Router hook={loc.hook}>{ui}</Router>
    </ClientProvider>,
  );
  return { ...utils, ...t };
}

async function entered(r: ReturnType<typeof renderRoom>): Promise<void> {
  await waitFor(() =>
    expect(r.transport.payloads('room:join').length + r.transport.payloads('room:resume').length).toBe(1),
  );
}

/** 大厅（epoch 0）→ 开局（epoch 1） */
async function startFromLobby(r: ReturnType<typeof renderRoom>, mapId: string, lobby: Partial<RoomView> = {}) {
  await entered(r);
  act(() => r.transport.push('room:state', onMap(mapId, { phase: 'lobby', epoch: 0, ...lobby })));
  await screen.findByTestId('classic-select');
  const { loadedSave: _drop, ...rest } = lobby;
  act(() => r.transport.push('room:state', onMap(mapId, { phase: 'playing', epoch: 1, ...rest })));
  await screen.findByTestId('screen-game');
}

beforeEach(() => {
  installSceneAssets({ sprites: {} });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
  flags.animInstant = false;
  packWithFly();
});

afterEach(() => {
  // 先卸载（视频层卸载时调 pause），再还原 play / pause 的替身
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetClassicAssetsForTest();
  resetSkinStoreForTest();
  useRoomStore.getState().clear();
  useGameStore.getState().clear();
  useUiStore.getState().clear();
  sessionStorage.clear();
});

describe('开局飞行动画（Fly*.avi）', () => {
  it('大厅 → 对局：播该图的飞行动画（日本 = video.flyjp）；期间暂缓事件回放、不放棋盘曲；跳过后解除，同一局不再播', async () => {
    const r = renderRoom();
    await startFromLobby(r, 'japan');
    const fly = await screen.findByTestId('fly');
    expect(within(fly).getByTestId('fly-video')).toHaveAttribute('src', '/pack/video/flyjp.mp4');
    expect(within(fly).getByTestId('fly-skip')).toHaveFocus();
    expect(within(fly).getByTestId('fly-skip')).toHaveAttribute('data-urgent', 'false');
    expect(r.client.player.held).toBe(true);
    expect(useUiStore.getState().introPlaying).toBe(true);
    // 叠在 Loading 之上
    expect(screen.getByTestId('classic-loading')).toBeInTheDocument();
    expect(sessionStorage.getItem(FLY_SEEN_KEY)).toBe('123456:1');

    await userEvent.click(within(fly).getByTestId('fly-skip'));
    expect(screen.queryByTestId('fly')).toBeNull();
    expect(r.client.player.held).toBe(false);
    expect(useUiStore.getState().introPlaying).toBe(false);

    // 同一局的房间状态再来（托管、观战者变化）：不再播
    act(() => r.transport.push('room:state', onMap('japan', { phase: 'playing', epoch: 1, spectators: [] })));
    expect(screen.queryByTestId('fly')).toBeNull();
  });

  it('播完（ended）、出错都直接结束；Esc 跳过（捕获阶段接管，不再往下传）', async () => {
    const r = renderRoom();
    await startFromLobby(r, 'usa');
    const video = within(await screen.findByTestId('fly')).getByTestId('fly-video');
    expect(video).toHaveAttribute('src', '/pack/video/flyus.mp4');
    fireEvent.ended(video);
    expect(screen.queryByTestId('fly')).toBeNull();
    r.unmount();
    useRoomStore.getState().clear();
    sessionStorage.clear();

    const r2 = renderRoom();
    await startFromLobby(r2, 'china');
    await screen.findByTestId('fly');
    const below = vi.fn();
    window.addEventListener('keydown', below);
    fireEvent.keyDown(window, { key: 'Escape' });
    window.removeEventListener('keydown', below);
    expect(screen.queryByTestId('fly')).toBeNull();
    expect(below).not.toHaveBeenCalled();
    expect(r2.client.player.held).toBe(false);
  });

  it('轮到本人决策（首位玩家、服务器计时照走）：跳过钮醒目', async () => {
    const r = renderRoom();
    await startFromLobby(r, 'taiwan');
    await screen.findByTestId('fly');
    act(() => useGameStore.setState({ decision: { decisionId: 'd1', kind: 'TURN_MENU' } as never }));
    const skip = screen.getByTestId('fly-skip');
    expect(skip).toHaveAttribute('data-urgent', 'true');
    expect(skip).toHaveTextContent('轮到你了');
    expect(within(screen.getByTestId('fly')).getByTestId('fly-video')).toHaveAttribute('src', '/pack/video/flytw.mp4');
  });

  it('读档开局（开局前大厅里有 loadedSave）：不播', async () => {
    const r = renderRoom();
    const save = { saveId: 's1', name: '存档', gameDay: 30, date: 19980131, verified: true };
    await startFromLobby(r, 'japan', { loadedSave: save });
    expect(screen.queryByTestId('fly')).toBeNull();
    expect(r.client.player.held).toBe(false);
  });

  it('刷新 / 重连 / 中途进房（进页时对局已在进行）：不播；观战：不播', async () => {
    const r = renderRoom();
    await entered(r);
    act(() => r.transport.push('room:state', onMap('japan', { phase: 'playing', epoch: 1 })));
    await screen.findByTestId('screen-game');
    expect(screen.queryByTestId('fly')).toBeNull();
    r.unmount();
    useRoomStore.getState().clear();

    const r2 = renderRoom();
    await startFromLobby(r2, 'japan', {
      epoch: 4,
      you: { role: 'spectator', id: 'sp1', isHost: false },
    });
    expect(screen.queryByTestId('fly')).toBeNull();
  });

  it('?anim=instant、素材包没有该图的条目、不是原版四张图：不播', async () => {
    flags.animInstant = true;
    const r = renderRoom();
    await startFromLobby(r, 'japan');
    expect(screen.queryByTestId('fly')).toBeNull();
    r.unmount();
    useRoomStore.getState().clear();
    flags.animInstant = false;

    packWithFly(['video.flychina']);
    const r2 = renderRoom();
    await startFromLobby(r2, 'china');
    expect(screen.queryByTestId('fly')).toBeNull();
    r2.unmount();
    useRoomStore.getState().clear();

    const r3 = renderRoom();
    await startFromLobby(r3, 'test');
    expect(screen.queryByTestId('fly')).toBeNull();
  });

  it('单机页刚开局（房间页挂上时已在对局中）：凭单机页留下的记号播一次，记号读后清除', async () => {
    markSoloFresh('123456');
    const r = renderRoom();
    await entered(r);
    act(() => r.transport.push('room:state', onMap('usa', { phase: 'playing', epoch: 1 })));
    expect(await screen.findByTestId('fly')).toBeInTheDocument();
    expect(sessionStorage.getItem(FLY_FRESH_KEY)).toBeNull();
    await userEvent.click(screen.getByTestId('fly-skip'));
    r.unmount();
    // 刷新：已播过，也没有记号
    const r2 = renderRoom();
    await entered(r2);
    act(() => r2.transport.push('room:state', onMap('usa', { phase: 'playing', epoch: 1 })));
    await screen.findByTestId('screen-game');
    expect(screen.queryByTestId('fly')).toBeNull();
  });
});
