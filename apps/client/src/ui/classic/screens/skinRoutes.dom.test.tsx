// 房间页 / 单机页按皮肤选画面（client-dom，A14）：大厅随判定切换、对局中固定画面选择（在设置页改皮肤不重建对局页）、
// 对局之外自带门禁页宿主（素材包 401 时门禁页只出现一份）；原版房间页进入对局时叠原版 Loading，棋盘建好后淡出；
// 原版单机页：建房时显示 Loading，然后进入 /r/<code>。
import type { PackManifestV1 } from '@rich4/shared/assets';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { ClientProvider } from '../../../app/services';
import { setUiLanguage } from '../../../i18n';
import type { PackClient } from '../../../skin/pack/PackClient';
import { resetSkinStoreForTest, useSkinStore } from '../../../skin/skinStore';
import { resetSkinThemeForTest } from '../../../skin/theme';
import { useRoomStore } from '../../../store/roomStore';
import { useSettingsStore } from '../../../store/settingsStore';
import { useUiStore } from '../../../store/uiStore';
import { makeTestClient } from '../../../test/fakeTransport';
import { roomView } from '../../../test/roomFixtures';
import { useAccessStore } from '../../access/accessStore';
import { installResizeObserver } from '../../decisions/testing';
import { resetClassicAssetsForTest } from '../assets';
import { installSceneAssets } from '../common/testing';
import ClassicRoomScreen from './ClassicRoomScreen';
import ClassicSolo from './ClassicSolo';
import { SCREEN_KEYS } from './layout';
import { SkinHome, SkinRoom, SkinSolo } from './SkinRoutes';
import { PENDING_MAX_MS, resetScreensPendingForTest } from './useClassicScreens';

vi.mock('../../screens/GameScreen', () => ({
  default: () => <div data-testid="screen-game">game</div>,
}));
vi.mock('../../screens/RoomScreen', () => ({
  default: ({ code }: { code: string }) => <div data-testid="mock-room-procedural">{code}</div>,
}));
vi.mock('../../screens/SoloScreen', () => ({
  default: () => <div data-testid="mock-solo-procedural">solo</div>,
}));
vi.mock('../../screens/HomeScreen', () => ({
  HomeScreen: () => <input data-testid="mock-home-procedural" aria-label="昵称" />,
}));

installResizeObserver();
// 画面含懒加载模块与多步交互：机器繁忙时 5 秒缺省超时不够
vi.setConfig({ testTimeout: 20_000 });

const ACCESS = { mode: 'passcode', granted: true, kind: 'p', expiresAt: 0, grants: false, canGrant: false };

function packReady(): void {
  const keys = new Set(SCREEN_KEYS);
  const client = {
    usableEntry: (k: string) =>
      keys.has(k) ? { type: 'sprite', atlas: [], frames: { base: k, start: 0, count: 1 } } : null,
    fileUrl: (lp: string) => `/pack/${lp}`,
    loadAtlas: () => new Promise(() => {}),
    atlasImageUrl: () => null,
  };
  resetSkinStoreForTest({ client: client as unknown as PackClient });
  useAccessStore.setState({ status: ACCESS } as never);
  useSkinStore.setState({
    pack: { status: 'ready', manifest: { packId: 'feedfacefeedface' } as PackManifestV1 },
    resolution: {
      pref: 'auto',
      skin: 'original',
      board: 'procedural',
      reason: null,
      boardReason: null,
      mismatches: [],
      mapId: null,
      packId: 'feedfacefeedface',
    },
    ensurePack: vi.fn(() => Promise.resolve(useSkinStore.getState().pack)),
  });
}

/** 进房请求数（room:join 或凭上次的 token room:resume） */
function entered(t: ReturnType<typeof makeTestClient>['transport']): number {
  return t.payloads('room:join').length + t.payloads('room:resume').length;
}

function renderWith(ui: ReactElement, path = '/r/123456') {
  const loc = memoryLocation({ path, record: true });
  const t = makeTestClient();
  const utils = render(
    <ClientProvider client={t.client}>
      <Router hook={loc.hook}>{ui}</Router>
    </ClientProvider>,
  );
  return { ...utils, loc, ...t };
}

beforeEach(() => {
  installSceneAssets({ sprites: {} });
});

afterEach(async () => {
  await act(async () => {
    await setUiLanguage('zh-CN');
  });
  resetScreensPendingForTest();
  useSettingsStore.getState().setSkin('auto');
  resetClassicAssetsForTest();
  resetSkinStoreForTest();
  resetSkinThemeForTest();
  useRoomStore.getState().clear();
  useUiStore.getState().clear();
  useAccessStore.setState({ status: null, statusError: false, required: null });
});

describe('房间页按皮肤选画面', () => {
  it('大厅里随判定切换；进入对局后固定（设置页改皮肤不重建对局页）', async () => {
    packReady();
    const { transport } = renderWith(<SkinRoom code="123456" />);
    // 原版：进房中的原版画面；进房（room:join）后服务器推送房间状态
    expect(await screen.findByTestId('screen-room-loading')).toBeInTheDocument();
    await waitFor(() => expect(entered(transport)).toBe(1));
    act(() => transport.push('room:state', roomView({ phase: 'playing' })));
    expect(await screen.findByTestId('screen-game')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-room-procedural')).toBeNull();
    // 对局中把设置改成程序化：判定变了，但画面不换
    act(() =>
      useSkinStore.setState({
        resolution: { ...useSkinStore.getState().resolution, skin: 'procedural', reason: 'setting' },
      }),
    );
    expect(screen.getByTestId('screen-game')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-room-procedural')).toBeNull();
    // 回到大厅：照判定换成程序化
    act(() => transport.push('room:state', roomView({ phase: 'lobby' })));
    expect(await screen.findByTestId('mock-room-procedural')).toBeInTheDocument();
  });

  it('对局之外自带门禁页宿主：需要门禁时只出现一份门禁页；进入对局后交给对局页', async () => {
    packReady();
    const { transport } = renderWith(<SkinRoom code="123456" />);
    await screen.findByTestId('screen-room-loading');
    act(() => useAccessStore.getState().require('pack'));
    expect(await screen.findAllByTestId('access-gate')).toHaveLength(1);
    await waitFor(() => expect(entered(transport)).toBe(1));
    act(() => transport.push('room:state', roomView({ phase: 'playing' })));
    await screen.findByTestId('screen-game');
    // 对局页（这里是替身）自己挂宿主；房间页不再挂
    expect(screen.queryByTestId('access-gate')).toBeNull();
  });
});

/** 素材包还在发现中（永不完成；门禁已通过） */
function packLoading(): void {
  resetSkinStoreForTest();
  useAccessStore.setState({ status: ACCESS } as never);
  useSkinStore.setState({
    pack: { status: 'loading' },
    ensurePack: vi.fn(() => new Promise(() => {})),
  } as never);
}

describe('回归：判定超时后素材包才就绪——路由实例内不换画面', () => {
  it('单机页：超时判成程序化后素材包就绪，仍是程序化单机页（不挂原版单机页、不二次建房）', async () => {
    packLoading();
    resetScreensPendingForTest(Date.now() - PENDING_MAX_MS - 1);
    const { transport } = renderWith(<SkinSolo />, '/solo');
    // 起点是全局的：前一个路由已经等满 6 秒，这里不再重新等待
    expect(await screen.findByTestId('mock-solo-procedural')).toBeInTheDocument();
    expect(screen.queryByTestId('screen-solo-pending')).toBeNull();
    act(() => packReady());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.getByTestId('mock-solo-procedural')).toBeInTheDocument();
    expect(screen.queryByTestId('classic-solo-loading')).toBeNull();
    expect(transport.payloads('room:create')).toHaveLength(0);
  });

  it('首页：超时判成程序化后素材包就绪，已输入的内容不丢（不换成原版标题）；改皮肤设置后才重新判定', async () => {
    packLoading();
    resetScreensPendingForTest(Date.now() - PENDING_MAX_MS - 1);
    renderWith(<SkinHome />, '/');
    const input = (await screen.findByTestId('mock-home-procedural')) as HTMLInputElement;
    act(() => {
      input.value = '小美';
    });
    act(() => packReady());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.getByTestId('mock-home-procedural')).toBe(input);
    expect(input.value).toBe('小美');
    expect(screen.queryByTestId('screen-home')).toBeNull();
    // 设置改为「原版」：重新判定，换成原版标题
    act(() => useSettingsStore.getState().setSkin('original'));
    await waitFor(() => expect(screen.queryByTestId('mock-home-procedural')).toBeNull());
  });

  it('房间页：判定中先进房；房间已在对局中 → 不等判定立即挂对局页的外壳', async () => {
    packLoading();
    resetScreensPendingForTest(Date.now());
    const { transport } = renderWith(<SkinRoom code="123456" />);
    expect(screen.getByTestId('screen-room-loading')).toBeInTheDocument();
    await waitFor(() => expect(entered(transport)).toBe(1));
    act(() => transport.push('room:state', roomView({ phase: 'playing' })));
    expect(await screen.findByTestId('mock-room-procedural')).toBeInTheDocument();
    expect(screen.queryByTestId('screen-room-loading')).toBeNull();
    // 画面挂上后再进房直接返回（不重复 join / resume）
    expect(entered(transport)).toBe(1);
  });
});

describe('原版房间页：进入对局的 Loading', () => {
  it('对局阶段叠 Loading（不挡操作），棋盘建好后淡出', async () => {
    useClassicImages();
    const { transport } = renderWith(<ClassicRoomScreen code="123456" />);
    await waitFor(() => expect(entered(transport)).toBe(1));
    act(() => transport.push('room:state', roomView({ phase: 'playing' })));
    expect(await screen.findByTestId('screen-game')).toBeInTheDocument();
    const loading = screen.getByTestId('classic-loading');
    expect(loading).toHaveAttribute('data-state', 'loading');
    expect(loading).toHaveAttribute('data-art', 'true');
    expect(loading.querySelector('img')).toHaveAttribute('src', '/pack/loading.png');
    act(() => useSkinStore.getState().reportBoard('original'));
    expect(screen.getByTestId('classic-loading')).toHaveAttribute('data-state', 'done');
    await waitFor(() => expect(screen.queryByTestId('classic-loading')).toBeNull());
  });

  it('大厅阶段：原版选人画面', async () => {
    const { transport } = renderWith(<ClassicRoomScreen code="123456" />);
    await waitFor(() => expect(entered(transport)).toBe(1));
    act(() => transport.push('room:state', roomView({ phase: 'lobby' })));
    expect(await screen.findByTestId('screen-room')).toHaveAttribute('data-screen', 'select');
  });

  it('房间号非法：原版背景上的错误提示', () => {
    renderWith(<ClassicRoomScreen code="abc" />, '/r/abc');
    expect(screen.getByTestId('room-error')).toHaveTextContent('房间号无效');
  });
});

describe('原版单机页', () => {
  it('建房时显示 Loading，然后进入 /r/<code>', async () => {
    const { loc, transport } = renderWith(<ClassicSolo />, '/solo');
    expect(screen.getByTestId('classic-solo-loading')).toBeInTheDocument();
    await waitFor(() => expect(loc.history?.at(-1)).toBe('/r/123456'));
    expect(transport.payloads('room:setSeatAi')).toHaveLength(3);
  });
});

function useClassicImages(): void {
  installSceneAssets({ sprites: {} });
  resetClassicAssetsForTest({
    packId: 'test-pack',
    images: { 'title.loading': { url: '/pack/loading.png', w: 640, h: 480 } },
  });
}
