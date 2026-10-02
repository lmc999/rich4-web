// 原版标题 / 开局设置 / 选人大厅 / Loading / 片头（client-dom，A14）：合成素材包同尺寸同锚点的假精灵表下渲染与操作——
// 标题三钮（悬停帧、按钮映射）、昵称、加入房间号、设置（系统设置、重播片头）、片头（首次播放、跳过、看过不再播）；
// 开局设置（竖栏 6 个下拉 + 联机设置，提交 room:create 并补电脑；手机横屏两列 56 高的行）；选人大厅（头像格选角、
// 被占用置灰、走动预览按行进方式换精灵、OK = 开始 / 准备、EXIT = 离开、座位操作与房间设置、观战者）；
// 按皮肤切换首页（判定中 / 原版 / 程序化）；工具列在手机横屏收成「更多」。
import type { PackManifestV1 } from '@rich4/shared/assets';
import type { RoomView } from '@rich4/shared/net';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { ClientProvider } from '../../../app/services';
import { setUiLanguage } from '../../../i18n';
import type { PackClient } from '../../../skin/pack/PackClient';
import { resetSkinStoreForTest, useSkinStore } from '../../../skin/skinStore';
import { resetSkinThemeForTest } from '../../../skin/theme';
import type { PackState } from '../../../skin/types';
import { useChatStore } from '../../../store/chatStore';
import { useRoomStore } from '../../../store/roomStore';
import { useSettingsStore } from '../../../store/settingsStore';
import { useUiStore } from '../../../store/uiStore';
import { makeTestClient } from '../../../test/fakeTransport';
import { ai, human, roomView, seat } from '../../../test/roomFixtures';
import { useAccessStore } from '../../access/accessStore';
import { installResizeObserver } from '../../decisions/testing';
import { resetClassicAssetsForTest, type SpriteSheet, useClassicAssets } from '../assets';
import { ClassicStage } from '../ClassicStage';
import { atlasPackClient, type FakeFrame, fakeSheet, installSceneAssets } from '../common/testing';
import { Toolbar } from '../Toolbar';
import ClassicCreate from './ClassicCreate';
import ClassicHome from './ClassicHome';
import ClassicLobby from './ClassicLobby';
import { INTRO_SEEN_KEY } from './IntroVideo';
import { SCREEN_KEYS } from './layout';
import { SkinHome } from './SkinRoutes';
import { playScreenCue } from './uiSound';

// 界面音：只记录播了哪一个 cue（关卡行 = click，下拉框 = move）
vi.mock('./uiSound', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./uiSound')>()),
  playScreenCue: vi.fn(),
}));
const cues = () => vi.mocked(playScreenCue).mock.calls.map((c) => c[0]);

installResizeObserver();
// 画面含懒加载模块与多步交互：机器繁忙时 5 秒缺省超时不够
vi.setConfig({ testTimeout: 20_000 });

const rep = (n: number, f: FakeFrame): FakeFrame[] => Array.from({ length: n }, () => f);

/** 与合成素材包同尺寸同锚点的假精灵表（title.screen、title.setup.ui、头像、若干侧视走动） */
function screenSheets(walkers: readonly string[] = []): Record<string, SpriteSheet> {
  const out: Record<string, SpriteSheet> = {
    'title.screen': fakeSheet('title.screen', [
      [640, 480, 0, 0],
      [108, 105, 55, 53],
      [116, 113, 59, 57],
      [107, 92, 51, 51],
      [114, 99, 55, 54],
      [98, 90, 51, 42],
      [103, 98, 53, 46],
      [53, 18, 27, 9],
      [58, 19, 29, 10],
    ]),
    'title.setup.ui': fakeSheet('title.setup.ui', [
      [440, 155, 0, 0],
      [192, 461, 0, 0],
      [80, 40, 0, 0],
      [80, 40, 0, 0],
      [24, 25, 0, 0],
      [42, 71, 0, 0],
      [67, 140, 0, 0],
      [87, 140, 0, 0],
      [27, 25, 0, 0],
      [50, 52, 25, 26],
      [27, 27, 14, 14],
      ...rep(4, [257, 45, 128, 22]),
      [257, 177, 128, 88],
    ]),
    'portrait.face72': fakeSheet('portrait.face72', rep(12, [72, 72, 0, 0])),
  };
  for (const k of walkers) out[k] = fakeSheet(k, rep(10, [124, 143, 62, 143]));
  return out;
}

function install(walkers: readonly string[] = []): void {
  installSceneAssets({ sprites: screenSheets(walkers) });
  useClassicAssets.setState({
    images: {
      'title.setup.bg': { url: '/pack/bg.png', w: 640, h: 480 },
      'title.loading': { url: '/pack/loading.png', w: 640, h: 480 },
    },
  });
}

function renderWith(ui: ReactElement, path = '/') {
  const loc = memoryLocation({ path, record: true });
  const t = makeTestClient();
  const utils = render(
    <ClientProvider client={t.client}>
      <Router hook={loc.hook}>{ui}</Router>
    </ClientProvider>,
  );
  return { ...utils, loc, ...t };
}

/** GET /api/maps 的替身（缺省 jsdom 下 fetch 失败 → 只列 fixture） */
function stubMapList(body: {
  defaultMap: string;
  maps: { id: string; mapHash: string; playable?: boolean; fixture?: boolean }[];
}): void {
  vi.stubGlobal('fetch', async (u: string) =>
    u === '/api/maps'
      ? new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response('{}', { status: 404 }),
  );
}

function setViewport(w: number, h: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: h });
}

beforeEach(() => {
  setViewport(1280, 960);
  install();
});

afterEach(async () => {
  await act(async () => {
    await setUiLanguage('zh-CN');
  });
  resetClassicAssetsForTest();
  resetSkinStoreForTest();
  resetSkinThemeForTest();
  useRoomStore.getState().clear();
  useUiStore.getState().clear();
  useChatStore.getState().clear();
  useSettingsStore.setState({ skin: 'auto', nickname: '' });
  useAccessStore.setState({ status: null, statusError: false, required: null });
  localStorage.removeItem(INTRO_SEEN_KEY);
  vi.unstubAllGlobals();
  vi.mocked(playScreenCue).mockClear();
});

// ───────────────────────── 标题画面 ─────────────────────────

describe('标题画面（Data#1）', () => {
  it('底图与三钮：常态不另画（底图已烘焙），悬停换放大帧；START = 开局设置，EXIT 回到标题', async () => {
    useSettingsStore.setState({ nickname: '阿土' });
    renderWith(<ClassicHome />);
    const home = screen.getByTestId('screen-home');
    expect(home).toHaveAttribute('data-screen', 'title');
    expect(within(home).getByTestId('title-bg')).toHaveAttribute('data-sprite', 'title.screen/0');
    const start = screen.getByTestId('home-create');
    expect(start.querySelector('[data-sprite]')).toBeNull();
    fireEvent.pointerEnter(start);
    expect(start.querySelector('[data-sprite]')).toHaveAttribute('data-sprite', 'title.screen/2');
    // 悬停帧按锚点落在画点 (190,380)：热区左上 (131,323)，帧锚点 (59,57) → 相对 (0,0)
    const st = (start.querySelector('[data-sprite]') as HTMLElement).style;
    expect([st.left, st.top]).toEqual(['0px', '0px']);
    fireEvent.pointerDown(start);
    expect(start.querySelector('[data-sprite]')).toHaveAttribute('data-sprite', 'title.screen/1');
    fireEvent.pointerLeave(start);
    expect(start.querySelector('[data-sprite]')).toBeNull();
    expect(screen.getByTestId('home-load-open')).toHaveAccessibleName('读取存档');
    expect(screen.getByTestId('title-option')).toHaveAccessibleName('设置');

    await userEvent.click(start);
    const setup = await screen.findByTestId('screen-setup');
    expect(within(setup).getByTestId('create-form')).toBeInTheDocument();
    expect(within(setup).getByTestId('setup-column')).toHaveAttribute('data-sprite', 'title.setup.ui/1');
    await userEvent.click(within(setup).getByTestId('create-cancel'));
    expect(await screen.findByTestId('screen-home')).toBeInTheDocument();
  });

  it('昵称：空昵称不能建房（提示），填写后失焦保存', async () => {
    renderWith(<ClassicHome />);
    await userEvent.click(screen.getByTestId('home-create'));
    expect(screen.getByTestId('home-error')).toHaveTextContent('昵称');
    expect(screen.queryByTestId('screen-setup')).toBeNull();
    const nick = screen.getByTestId('home-nickname');
    await userEvent.type(nick, '孙小美');
    nick.blur();
    expect(useSettingsStore.getState().nickname).toBe('孙小美');
  });

  it('加入房间：6 位数字校验，加入 / 观战跳到 /r/:code', async () => {
    useSettingsStore.setState({ nickname: 'P1' });
    const { loc } = renderWith(<ClassicHome />);
    await userEvent.click(screen.getByTestId('home-join-open'));
    const panel = screen.getByTestId('title-join');
    await userEvent.type(within(panel).getByTestId('home-join-code'), '12a34');
    await userEvent.click(within(panel).getByTestId('home-join'));
    expect(within(panel).getByTestId('home-error')).toHaveTextContent('6 位数字');
    await userEvent.type(within(panel).getByTestId('home-join-code'), '56');
    await userEvent.click(within(panel).getByTestId('home-watch'));
    expect(loc.history?.at(-1)).toBe('/r/123456?watch=1');
    // EXIT 钮（Data#1 图7）关闭面板
    await userEvent.click(screen.getByTestId('title-panel-close'));
    expect(screen.queryByTestId('title-join')).toBeNull();
  });

  it('设置：系统设置打开设置页；没有片头条目时不给「重播片头」', async () => {
    renderWith(<ClassicHome />);
    await userEvent.click(screen.getByTestId('title-option'));
    const opts = screen.getByTestId('title-options');
    expect(within(opts).queryByTestId('intro-replay')).toBeNull();
    await userEvent.click(within(opts).getByTestId('home-settings'));
    expect(await screen.findByTestId('settings-dialog')).toBeInTheDocument();
  });

  it('被请出房间后回到标题：提示一次', () => {
    act(() => useRoomStore.setState({ closed: { code: '654321', reason: 'kicked' } }));
    renderWith(<ClassicHome />);
    expect(screen.getByTestId('home-closed-note')).toHaveTextContent('654321');
  });
});

describe('片头（video.start）', () => {
  function withVideo(): void {
    const client = {
      usableEntry: (k: string) =>
        k === 'video.start'
          ? {
              type: 'video',
              group: 'video',
              confidence: 'exe',
              src: [],
              files: { mp4: 'video/start.mp4' },
              w: 640,
              h: 480,
              durationMs: 1,
            }
          : null,
      fileUrl: (lp: string) => `/pack/${lp}`,
    };
    resetSkinStoreForTest({ client: client as unknown as PackClient });
  }

  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('首次进入播放、可跳过；看过的不再自动播放；设置里可以重播', async () => {
    withVideo();
    const { unmount } = renderWith(<ClassicHome />);
    const intro = screen.getByTestId('intro');
    expect(within(intro).getByTestId('intro-video')).toHaveAttribute('src', '/pack/video/start.mp4');
    expect(within(intro).getByTestId('intro-skip')).toHaveFocus();
    await userEvent.click(within(intro).getByTestId('intro-skip'));
    expect(screen.queryByTestId('intro')).toBeNull();
    expect(localStorage.getItem(INTRO_SEEN_KEY)).toBe('1');
    unmount();

    renderWith(<ClassicHome />);
    expect(screen.queryByTestId('intro')).toBeNull();
    await userEvent.click(screen.getByTestId('title-option'));
    // 设置面板在满载的全量测试里偶尔晚一拍才渲染：用 findBy 等它出现
    await userEvent.click(await screen.findByTestId('intro-replay'));
    expect(screen.getByTestId('intro')).toBeInTheDocument();
    // Esc 也能跳过；视频播完同样进入标题
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('intro')).toBeNull();
  });

  it('播放结束或出错：直接进入标题画面', () => {
    withVideo();
    renderWith(<ClassicHome />);
    fireEvent.error(screen.getByTestId('intro-video'));
    expect(screen.queryByTestId('intro')).toBeNull();
  });
});

// ───────────────────────── 开局设置 ─────────────────────────

describe('开局设置（jump#0 + jump#4）', () => {
  it('竖栏 6 个下拉 + 联机设置；提交 room:create（设置按草稿）并给 1..N 号座位补电脑', async () => {
    const onCreated = vi.fn();
    const { transport } = renderWith(<ClassicCreate onCancel={() => {}} onCreated={onCreated} />);
    const form = screen.getByTestId('create-form');
    // 地图目录取不到时只列 fixture，缺省 test
    await waitFor(() => expect(screen.getByTestId('set-map')).toHaveValue('test'));
    for (const id of ['set-ai-count', 'set-fund', 'set-vehicle', 'set-tenure', 'set-time', 'set-win']) {
      expect(within(form).getByTestId(id).className).toMatch(/boxSelect/);
    }
    await userEvent.selectOptions(screen.getByTestId('set-fund'), '50000');
    await userEvent.selectOptions(screen.getByTestId('set-vehicle'), 'car');
    await userEvent.selectOptions(screen.getByTestId('set-ai-count'), '2');
    await userEvent.selectOptions(screen.getByTestId('set-timer'), 'off');
    expect(within(form).getByTestId('set-timer-hint')).toHaveTextContent('只有一名真人时不计时');
    await userEvent.selectOptions(screen.getByTestId('set-pacing'), 'compact');
    await userEvent.click(screen.getByTestId('set-spectators'));
    await userEvent.selectOptions(screen.getByTestId('set-ai-preset'), 'cunning');
    await userEvent.click(screen.getByTestId('create-submit'));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('123456'));
    const [patch] = transport.payloads('room:create');
    expect(patch).toMatchObject({
      settings: {
        timerPreset: 'off',
        pacing: 'compact',
        allowSpectators: false,
        game: { mapId: 'test', initialFund: 50000, vehicle: 'car' },
      },
    });
    expect(transport.payloads('room:setSeatAi')).toEqual([
      { seat: 1, ai: { preset: 'cunning' } },
      { seat: 2, ai: { preset: 'cunning' } },
    ]);
  });

  it('快速局：1 年 / 10 倍；地图目录取不到时只有 fixture，四个关卡都变暗、不能点', async () => {
    renderWith(<ClassicCreate onCancel={() => {}} onCreated={() => {}} />);
    await userEvent.click(screen.getByTestId('create-quick'));
    expect(screen.getByTestId('set-time')).toHaveValue('365');
    expect(screen.getByTestId('set-win')).toHaveValue('10');
    await waitFor(() => expect(screen.getByTestId('set-map')).toHaveValue('test'));
    for (let k = 0; k < 4; k++) {
      expect(screen.getByTestId(`setup-stage-${k}`)).toHaveAttribute('data-available', 'false');
      expect(screen.getByTestId(`setup-stage-${k}`)).toBeDisabled();
      expect(screen.getByTestId(`setup-stage-${k}`)).toHaveAttribute('data-selected', 'false');
    }
  });

  it('关卡行选图：缺省为服务器的 defaultMap；点关卡写入草稿的地图（与地图下拉同步）、打勾、背景换 jump#gm；不可开局的变暗', async () => {
    stubMapList({
      defaultMap: 'china',
      maps: [
        { id: 'taiwan', mapHash: 'a', playable: true },
        { id: 'china', mapHash: 'b', playable: true },
        { id: 'japan', mapHash: 'c', playable: true },
        { id: 'usa', mapHash: 'd', playable: false },
        { id: 'test', mapHash: 'e', playable: true, fixture: true },
      ],
    });
    useClassicAssets.setState((st) => ({
      images: {
        ...st.images,
        'title.setup.bg.china': { url: '/pack/bg1.png', w: 640, h: 480 },
        'title.setup.bg.japan': { url: '/pack/bg2.png', w: 640, h: 480 },
      },
    }));
    const { transport } = renderWith(<ClassicCreate onCancel={() => {}} onCreated={() => {}} />);
    // 缺省地图 = 服务器的 defaultMap（不是写死的台湾）
    await waitFor(() => expect(screen.getByTestId('set-map')).toHaveValue('china'));
    const stage = (k: number) => screen.getByTestId(`setup-stage-${k}`);
    expect(stage(1)).toHaveAttribute('data-selected', 'true');
    expect(stage(1)).toHaveAttribute('aria-pressed', 'true');
    expect(stage(1)).toHaveAccessibleName('关卡：中国大陆');
    expect(stage(1).querySelector('[data-sprite]')).toHaveAttribute('data-sprite', 'title.setup.ui/8');
    expect(screen.getByTestId('setup-bg')).toHaveAttribute('data-image', 'title.setup.bg.china');
    // 美国不可开局：变暗、不能点
    expect(stage(3)).toHaveAttribute('data-available', 'false');
    expect(stage(3)).toBeDisabled();
    expect(stage(3)).toHaveAccessibleName('关卡：美国（本服务器没有这张地图）');
    // 点关卡三（日本）：草稿、地图下拉、打勾、背景一起变；播 click（exe 0x405439 = 全局 UI 音效第 1 项），不是下拉的 move
    vi.mocked(playScreenCue).mockClear();
    await userEvent.click(stage(2));
    expect(cues()).toEqual(['click']);
    expect(screen.getByTestId('set-map')).toHaveValue('japan');
    expect(stage(2)).toHaveAttribute('data-selected', 'true');
    expect(stage(1)).toHaveAttribute('data-selected', 'false');
    expect(stage(1).querySelector('[data-sprite]')).toBeNull();
    expect(screen.getByTestId('setup-bg')).toHaveAttribute('data-image', 'title.setup.bg.japan');
    // 地图下拉改回台湾：关卡一打勾、背景 jump#0；fixture 地图：不打勾、背景 jump#0
    vi.mocked(playScreenCue).mockClear();
    await userEvent.selectOptions(screen.getByTestId('set-map'), 'taiwan');
    expect(cues()).toEqual(['move']);
    expect(stage(0)).toHaveAttribute('data-selected', 'true');
    expect(screen.getByTestId('setup-bg')).toHaveAttribute('data-image', 'title.setup.bg');
    await userEvent.selectOptions(screen.getByTestId('set-map'), 'test');
    expect(screen.queryAllByRole('button', { pressed: true }).filter((b) => b.dataset.map)).toEqual([]);
    expect(screen.getByTestId('setup-bg')).toHaveAttribute('data-image', 'title.setup.bg');
    await userEvent.click(stage(2));
    await userEvent.click(screen.getByTestId('create-submit'));
    await waitFor(() => expect(transport.payloads('room:create')).toHaveLength(1));
    expect(transport.payloads('room:create')[0]).toMatchObject({ settings: { game: { mapId: 'japan' } } });
  });

  it('背景条目不可用（旧素材包没有 jump#1–3）：回退台湾的 jump#0', async () => {
    stubMapList({ defaultMap: 'usa', maps: [{ id: 'usa', mapHash: 'd', playable: true }] });
    renderWith(<ClassicCreate onCancel={() => {}} onCreated={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('set-map')).toHaveValue('usa'));
    expect(screen.getByTestId('setup-stage-3')).toHaveAttribute('data-selected', 'true');
    await waitFor(() => expect(screen.getByTestId('setup-bg')).toHaveAttribute('data-image', 'title.setup.bg'));
    // 只画 jump#0 一层（没有空着的上层）
    expect(document.querySelectorAll('img[data-image^="title.setup.bg"]')).toHaveLength(1);
  });

  it('手机横屏 844×390：竖栏白框只显示数值，全部设置排进两列 56 高的行', async () => {
    setViewport(844, 390);
    renderWith(<ClassicCreate onCancel={() => {}} onCreated={() => {}} />);
    const panel = screen.getByTestId('set-map').closest('fieldset')!;
    expect(panel).toHaveAttribute('data-wide', 'true');
    for (const id of ['set-ai-count', 'set-fund', 'set-vehicle', 'set-tenure', 'set-time', 'set-win', 'set-pacing']) {
      expect(within(panel).getByTestId(id)).toBeInTheDocument();
      expect(screen.getAllByTestId(id)).toHaveLength(1);
    }
    expect(within(panel).getByTestId('set-timer-hint')).toHaveTextContent('只有一名真人时不计时');
    expect(within(panel).getByTestId('set-timer-hint')).toHaveAttribute('data-active', 'false');
    // 计时档位这一行占满整行、落在左列：前面有偶数个字段行
    const rows = [...panel.querySelectorAll(':scope > label')];
    const timerRow = screen.getByTestId('set-timer').closest('label')!;
    expect(rows.indexOf(timerRow) % 2).toBe(0);
    // 电脑补满其余三个座位：开局只有房主一名真人，说明换成「现在只有一名真人：开局后不计时」
    await userEvent.selectOptions(screen.getByTestId('set-ai-count'), '3');
    expect(within(panel).getByTestId('set-timer-hint')).toHaveTextContent('现在只有一名真人：开局后不计时');
    expect(within(panel).getByTestId('set-timer-hint')).toHaveAttribute('data-active', 'true');
    expect(screen.getByTestId('setup-value-vehicle')).toHaveTextContent('步行');
    await userEvent.selectOptions(screen.getByTestId('set-vehicle'), 'moto');
    expect(screen.getByTestId('setup-value-vehicle')).toHaveTextContent('机车');
    expect(screen.getByTestId('classic-stage')).toHaveAttribute('data-hit', 'wide');
  });

  it('手机横屏：关卡行只读（32 高、四行紧挨，缩放后不到 44 CSS 像素），选图走两列面板里的地图下拉', async () => {
    stubMapList({
      defaultMap: 'taiwan',
      maps: ['taiwan', 'china', 'japan', 'usa'].map((id) => ({ id, mapHash: id, playable: true })),
    });
    setViewport(844, 390);
    renderWith(<ClassicCreate onCancel={() => {}} onCreated={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('setup-stage-0')).toHaveAttribute('data-selected', 'true'));
    expect(screen.getByTestId('classic-stage')).toHaveAttribute('data-hit', 'wide');
    for (let k = 0; k < 4; k++) {
      expect(screen.getByTestId(`setup-stage-${k}`).tagName).toBe('DIV');
      expect(screen.getByTestId(`setup-stage-${k}`)).toHaveAttribute('data-available', 'true');
    }
    expect(screen.queryAllByRole('button').filter((b) => b.dataset.map)).toEqual([]);
    const panel = screen.getByTestId('set-map').closest('fieldset')!;
    expect(panel).toHaveAttribute('data-wide', 'true');
    await userEvent.selectOptions(within(panel).getByTestId('set-map'), 'usa');
    expect(screen.getByTestId('setup-stage-3')).toHaveAttribute('data-selected', 'true');
    expect(screen.getByTestId('setup-stage-0')).toHaveAttribute('data-selected', 'false');
  });
});

// ───────────────────────── 选人大厅 ─────────────────────────

describe('选人大厅', () => {
  const hostRoom = (over: Partial<RoomView> = {}): RoomView =>
    roomView({
      seats: [human(0, '房主', { host: true, isYou: true }), human(1, '小明', { character: 9 }), ai(2), seat(3)],
      ...over,
    });

  it('头像格：单击没被选走的即发 room:selectCharacter；被占用的置灰标座位、单击只移动光标；走动预览按行进方式换精灵', async () => {
    install(['title.sidewalk.0.walk', 'title.sidewalk.3.walk', 'title.sidewalk.3.car', 'title.sidewalk.9.walk']);
    const room = hostRoom();
    const { transport, rerender, client } = renderWith(<ClassicLobby room={room} onLeave={() => {}} />);
    expect(screen.getByTestId('screen-room')).toHaveAttribute('data-screen', 'select');
    expect(screen.getByTestId('setup-grid')).toHaveAttribute('data-sprite', 'title.setup.ui/0');
    const c9 = screen.getByTestId('char-9');
    expect(c9).toHaveAttribute('data-taken', 'true');
    expect(c9).toHaveAttribute('aria-disabled', 'true');
    expect(within(c9).getByText('2P')).toBeInTheDocument();
    // 格 c = 角色 c：名字与 portrait.face72 的帧 c（不混用格子序号与角色号）
    const names = ['约翰乔', '沙隆巴斯', '忍太郎', '钱夫人', '阿土伯', '莎拉公主'];
    for (let c = 0; c < 12; c++) {
      const cell = screen.getByTestId(`char-${c}`);
      expect(cell.querySelector('[data-sprite]')).toHaveAttribute('data-sprite', `portrait.face72/${c}`);
      if (c < names.length) expect(cell).toHaveAccessibleName(names[c]!);
    }
    expect(screen.getByTestId('char-11')).toHaveAccessibleName('金贝贝');
    expect(screen.getByTestId('char-walker')).toHaveAttribute('data-sheet', 'title.sidewalk.0.walk');
    // 被选走的孙小美：单击只移动光标（预览置灰），不发选择
    await userEvent.click(c9);
    expect(c9).toHaveAttribute('data-cursor', 'true');
    expect(screen.getByTestId('char-walker')).toHaveAttribute('data-sheet', 'title.sidewalk.9.walk');
    expect(screen.getByTestId('char-select')).toHaveTextContent('已被 2P 选走');
    expect(transport.payloads('room:selectCharacter')).toEqual([]);
    // 钱夫人：单击即选定
    await userEvent.click(screen.getByTestId('char-3'));
    expect(screen.getByTestId('char-3')).toHaveAttribute('data-cursor', 'true');
    expect(screen.getByTestId('char-preview-name')).toHaveTextContent('钱夫人');
    expect(screen.getByTestId('char-walker')).toHaveAttribute('data-sheet', 'title.sidewalk.3.walk');
    expect(transport.payloads('room:selectCharacter')).toEqual([{ characterId: 3 }]);
    // 悬停显示名字
    fireEvent.pointerEnter(screen.getByTestId('char-5'));
    expect(screen.getByTestId('char-tip')).toBeInTheDocument();
    // 选中之后：描金边、按钮显示「已选择」；行进方式改成汽车时走动换汽车侧视
    const mine = hostRoom({
      seats: [
        human(0, '房主', { host: true, isYou: true, character: 3 }),
        human(1, '小明', { character: 9 }),
        ai(2),
        seat(3),
      ],
    });
    mine.settings = { ...mine.settings, game: { ...mine.settings.game, vehicle: 'car' } };
    rerender(
      <ClientProvider client={client}>
        <Router hook={memoryLocation({ path: '/r/123456' }).hook}>
          <ClassicLobby room={mine} onLeave={() => {}} />
        </Router>
      </ClientProvider>,
    );
    expect(screen.getByTestId('char-3')).toHaveAttribute('data-mine', 'true');
    expect(screen.getByTestId('char-3')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('char-select')).toHaveTextContent('已选择');
    expect(screen.getByTestId('char-select')).toBeDisabled();
    await waitFor(() =>
      expect(screen.getByTestId('char-walker')).toHaveAttribute('data-sheet', 'title.sidewalk.3.car'),
    );
    expect(screen.getByTestId('setup-value-vehicle')).toHaveTextContent('汽车');
    // 翻到被占用的孙小美：按钮禁用并提示被 2P 选走
    for (let i = 0; i < 6; i++) await userEvent.click(screen.getByTestId('char-next'));
    expect(screen.getByTestId('char-preview-name')).toHaveTextContent('孙小美');
    expect(screen.getByTestId('char-select')).toHaveTextContent('已被 2P 选走');
    expect(screen.getByTestId('char-select')).toBeDisabled();
  });

  it('关卡行：背景跟随房间地图；房主点关卡即改房间地图（room:updateSettings），其他人与读档后只读', async () => {
    stubMapList({
      defaultMap: 'taiwan',
      maps: ['taiwan', 'china', 'japan', 'usa'].map((id) => ({ id, mapHash: id, playable: true })),
    });
    useClassicAssets.setState((st) => ({
      images: { ...st.images, 'title.setup.bg.usa': { url: '/pack/bg3.png', w: 640, h: 480 } },
    }));
    const onUsa = (over: Partial<RoomView> = {}): RoomView => {
      const r = hostRoom(over);
      r.settings = { ...r.settings, game: { ...r.settings.game, mapId: 'usa' } };
      return r;
    };
    const { transport, unmount } = renderWith(<ClassicLobby room={onUsa()} onLeave={() => {}} />);
    expect(screen.getByTestId('setup-bg')).toHaveAttribute('data-image', 'title.setup.bg.usa');
    expect(screen.getByTestId('setup-stage-3')).toHaveAttribute('data-selected', 'true');
    // 目录到了才能点；点关卡行播 click（exe 0x405439）
    await waitFor(() => expect(screen.getByTestId('setup-stage-1').tagName).toBe('BUTTON'));
    vi.mocked(playScreenCue).mockClear();
    await userEvent.click(screen.getByTestId('setup-stage-1'));
    expect(cues()).toEqual(['click']);
    expect(transport.payloads('room:updateSettings')).toEqual([{ patch: { game: { mapId: 'china' } } }]);
    // 已选中的关卡再点：不发
    await userEvent.click(screen.getByTestId('setup-stage-3'));
    expect(transport.payloads('room:updateSettings')).toHaveLength(1);
    unmount();

    // 非房主：只读（不是按钮）
    const guest = onUsa({
      seats: [human(0, '房主', { host: true }), human(1, '我', { isYou: true }), ai(2), seat(3)],
      you: { role: 'player', seat: 1, isHost: false },
    });
    const g = renderWith(<ClassicLobby room={guest} onLeave={() => {}} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.getByTestId('setup-stage-1').tagName).toBe('DIV');
    expect(screen.getByTestId('setup-stage-3')).toHaveAttribute('data-selected', 'true');
    g.unmount();

    // 读档后：地图由存档决定
    const loaded = onUsa({ loadedSave: { saveId: 's', name: '存档', gameDay: 3, date: 19980103, verified: true } });
    const l = renderWith(<ClassicLobby room={loaded} onLeave={() => {}} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.getByTestId('setup-stage-0').tagName).toBe('DIV');
    l.unmount();

    // 手机横屏的房主：关卡行只读（热区不到 44 CSS 像素），改地图走左抽屉「房间设置」的地图下拉
    setViewport(844, 390);
    renderWith(<ClassicLobby room={onUsa()} onLeave={() => {}} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.getByTestId('classic-stage')).toHaveAttribute('data-hit', 'wide');
    for (let k = 0; k < 4; k++) expect(screen.getByTestId(`setup-stage-${k}`).tagName).toBe('DIV');
    expect(screen.getByTestId('setup-stage-3')).toHaveAttribute('data-selected', 'true');
  });

  it('房主：OK = 开始（有人没准备时禁用）、EXIT = 离开；座位补电脑 / 踢人；房间设置直接修改', async () => {
    const onLeave = vi.fn();
    const { transport, rerender, client } = renderWith(<ClassicLobby room={hostRoom()} onLeave={onLeave} />);
    expect(screen.getByTestId('room-start')).toBeDisabled();
    expect(screen.getByTestId('start-hint')).toBeInTheDocument();
    expect(screen.queryByTestId('room-ready')).toBeNull();
    await userEvent.click(screen.getByTestId('seat-3-add-ai'));
    expect(transport.payloads('room:setSeatAi')).toEqual([{ seat: 3, ai: { preset: 'character' } }]);
    await userEvent.click(screen.getByTestId('seat-1-kick'));
    expect(transport.payloads('room:kick')).toEqual([{ target: { seat: 1 } }]);
    await userEvent.selectOptions(screen.getByTestId('set-timer'), 'fast');
    expect(transport.payloads('room:updateSettings')[0]).toMatchObject({ patch: { timerPreset: 'fast' } });
    expect(screen.getByTestId('set-timer-hint')).toHaveTextContent('只有一名真人时不计时');
    expect(screen.getByTestId('set-timer-hint')).toHaveAttribute('data-active', 'false');
    await userEvent.click(screen.getByTestId('room-leave'));
    expect(onLeave).toHaveBeenCalled();
    // 小明准备后可以开始
    const ok = hostRoom({
      seats: [human(0, '房主', { host: true, isYou: true }), human(1, '小明', { ready: true }), ai(2), seat(3)],
    });
    rerender(
      <ClientProvider client={client}>
        <Router hook={memoryLocation({ path: '/r/123456' }).hook}>
          <ClassicLobby room={ok} onLeave={onLeave} />
        </Router>
      </ClientProvider>,
    );
    expect(screen.getByTestId('room-start')).toBeEnabled();
    await userEvent.click(screen.getByTestId('room-start'));
    // 房主没选过角色：先提交光标上的角色（缺省第一个没被选走的：约翰乔），再开始
    await waitFor(() => expect(transport.payloads('room:start')).toHaveLength(1));
    expect(transport.payloads('room:selectCharacter')).toEqual([{ characterId: 0 }]);
    // 座位牌（只显示）
    expect(screen.getByTestId('classic-seat-1')).toHaveTextContent('小明');
    expect(screen.getByTestId('setup-value-aiCount')).toHaveTextContent('1');
  });

  it('只有房主一名真人 + 电脑（有效档位 off）：计时说明高亮，设置下拉仍是房间设置', () => {
    renderWith(
      <ClassicLobby
        room={hostRoom({
          seats: [human(0, '房主', { host: true, isYou: true }), ai(1), ai(2), seat(3)],
          effectiveTimerPreset: 'off',
        })}
        onLeave={() => {}}
      />,
    );
    expect(screen.getByTestId('set-timer')).toHaveValue('normal');
    expect(screen.getByTestId('set-timer-hint')).toHaveAttribute('data-active', 'true');
    // 文字本身也换了（不只靠颜色）
    expect(screen.getByTestId('set-timer-hint')).toHaveTextContent('现在只有一名真人：开局后不计时');
  });

  it('手牌说明：两名真人时「他人无法查看自己手牌及道具」高亮；只有一名真人时说明适用条件', () => {
    const r = renderWith(
      <ClassicLobby
        room={hostRoom({ seats: [human(0, '房主', { host: true, isYou: true }), human(1, '小明'), seat(2), seat(3)] })}
        onLeave={() => {}}
      />,
    );
    expect(screen.getByTestId('room-hand-hint')).toHaveAttribute('data-active', 'true');
    expect(screen.getByTestId('room-hand-hint')).toHaveTextContent('他人无法查看自己手牌及道具');
    r.unmount();
    renderWith(
      <ClassicLobby
        room={hostRoom({ seats: [human(0, '房主', { host: true, isYou: true }), ai(1), seat(2), seat(3)] })}
        onLeave={() => {}}
      />,
    );
    expect(screen.getByTestId('room-hand-hint')).toHaveAttribute('data-active', 'false');
    expect(screen.getByTestId('room-hand-hint')).toHaveTextContent('两名以上真人时');
  });

  it('非房主：OK = 准备 / 取消准备（aria-pressed，打勾）；房间设置只读', async () => {
    const room = roomView({
      seats: [human(0, 'A', { host: true }), human(1, '我', { isYou: true }), seat(2), seat(3)],
      you: { role: 'player', seat: 1, isHost: false },
    });
    const { transport, rerender, client } = renderWith(<ClassicLobby room={room} onLeave={() => {}} />);
    expect(screen.queryByTestId('room-start')).toBeNull();
    expect(screen.getByTestId('set-timer')).toBeDisabled();
    await userEvent.click(screen.getByTestId('room-ready'));
    await waitFor(() => expect(transport.payloads('room:setReady')).toEqual([{ ready: true }]));
    const ready = {
      ...room,
      seats: [room.seats[0], human(1, '我', { isYou: true, ready: true }), room.seats[2], room.seats[3]],
    } as RoomView;
    rerender(
      <ClientProvider client={client}>
        <Router hook={memoryLocation({ path: '/r/123456' }).hook}>
          <ClassicLobby room={ready} onLeave={() => {}} />
        </Router>
      </ClientProvider>,
    );
    expect(screen.getByTestId('room-ready')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('room-ready')).toHaveAccessibleName('取消准备');
    expect(screen.getByTestId('room-ready-mark')).toBeInTheDocument();
    expect(screen.getByTestId('seat-1-ready')).toBeInTheDocument();
  });

  // 回归（线上反馈「选的是忍太郎，头像却是金贝贝」）：光标上的角色（预览、名字、走动）没提交就按 OK / 准备时，
  // 旧实现照样开局，服务器给没选角色的座位随机分配。现在先提交光标上的角色，再开始 / 准备。
  it('房主：◀ ▶ 翻到忍太郎、不点「选这个」直接 OK → 先发 selectCharacter(2) 再发 room:start', async () => {
    install(['title.sidewalk.0.walk', 'title.sidewalk.2.walk']);
    const room = hostRoom({
      seats: [human(0, '房主', { host: true, isYou: true }), human(1, '小明', { ready: true }), ai(2), seat(3)],
    });
    const { transport } = renderWith(<ClassicLobby room={room} onLeave={() => {}} />);
    await userEvent.click(screen.getByTestId('char-next'));
    await userEvent.click(screen.getByTestId('char-next'));
    expect(screen.getByTestId('char-preview-name')).toHaveTextContent('忍太郎');
    expect(screen.getByTestId('char-walker')).toHaveAttribute('data-sheet', 'title.sidewalk.2.walk');
    expect(transport.payloads('room:selectCharacter')).toEqual([]);
    await userEvent.click(screen.getByTestId('room-start'));
    await waitFor(() => expect(transport.payloads('room:start')).toHaveLength(1));
    expect(
      transport.sent.map((r) => r.event).filter((e) => e === 'room:selectCharacter' || e === 'room:start'),
    ).toEqual(['room:selectCharacter', 'room:start']);
    expect(transport.payloads('room:selectCharacter')).toEqual([{ characterId: 2 }]);
  });

  it('房主：光标就是已选的角色、或停在被别人选走的角色上时，OK 不再提交，直接开始', async () => {
    const chosen = hostRoom({
      seats: [
        human(0, '房主', { host: true, isYou: true, character: 11 }),
        human(1, '小明', { ready: true, character: 9 }),
        ai(2),
        seat(3),
      ],
    });
    const a = renderWith(<ClassicLobby room={chosen} onLeave={() => {}} />);
    expect(screen.getByTestId('char-preview-name')).toHaveTextContent('金贝贝');
    await userEvent.click(screen.getByTestId('room-start'));
    await waitFor(() => expect(a.transport.payloads('room:start')).toHaveLength(1));
    expect(a.transport.payloads('room:selectCharacter')).toEqual([]);
    a.unmount();

    // 没选过、光标翻到被 2P 选走的孙小美（预览置灰）：保持原样（开局由服务器随机分配）
    const b = renderWith(
      <ClassicLobby
        room={hostRoom({
          seats: chosen.seats.map((x, i) =>
            i === 0 ? human(0, '房主', { host: true, isYou: true }) : x,
          ) as RoomView['seats'],
        })}
        onLeave={() => {}}
      />,
    );
    await userEvent.click(screen.getByTestId('char-9'));
    expect(screen.getByTestId('char-select')).toHaveTextContent('已被 2P 选走');
    await userEvent.click(screen.getByTestId('room-start'));
    await waitFor(() => expect(b.transport.payloads('room:start')).toHaveLength(1));
    expect(b.transport.payloads('room:selectCharacter')).toEqual([]);
  });

  it('非房主：准备前先提交光标上的角色；提交失败（刚被别人选走）就不准备；取消准备不提交', async () => {
    const room = roomView({
      seats: [human(0, 'A', { host: true, character: 0 }), human(1, '我', { isYou: true }), seat(2), seat(3)],
      you: { role: 'player', seat: 1, isHost: false },
    });
    // 缺省光标：第一个没被选走的角色（0 号被房主选走 → 沙隆巴斯）
    const { transport } = renderWith(<ClassicLobby room={room} onLeave={() => {}} />);
    expect(screen.getByTestId('char-preview-name')).toHaveTextContent('沙隆巴斯');
    transport.respond('room:selectCharacter', () => ({
      ok: false,
      error: { code: 'CHARACTER_TAKEN', message: '角色已被其他人选择' },
    }));
    await userEvent.click(screen.getByTestId('room-ready'));
    await waitFor(() => expect(transport.payloads('room:selectCharacter')).toEqual([{ characterId: 1 }]));
    await waitFor(() => expect(useUiStore.getState().toasts.length).toBeGreaterThan(0));
    expect(transport.payloads('room:setReady')).toEqual([]);
    transport.respond('room:selectCharacter', () => ({ ok: true, data: undefined }));
    await userEvent.click(screen.getByTestId('room-ready'));
    await waitFor(() => expect(transport.payloads('room:setReady')).toEqual([{ ready: true }]));
    expect(transport.payloads('room:selectCharacter')).toEqual([{ characterId: 1 }, { characterId: 1 }]);
  });

  // 「◀ ▶ 翻看后点選這個」仍是保留的交互（单击头像即选之外的另一条路）：点它要发 selectCharacter，选中后按钮变「已选择」
  it('◀ ▶ 翻到没被选走的角色后点「选这个」：发 selectCharacter(c)，服务器确认后按钮变「已选择」', async () => {
    install(['title.sidewalk.0.walk', 'title.sidewalk.11.walk']);
    const room = hostRoom();
    const { transport, rerender, client } = renderWith(<ClassicLobby room={room} onLeave={() => {}} />);
    await userEvent.click(screen.getByTestId('char-prev'));
    expect(screen.getByTestId('char-preview-name')).toHaveTextContent('金贝贝');
    expect(screen.getByTestId('char-select')).toHaveTextContent('选这个');
    expect(screen.getByTestId('char-select')).toBeEnabled();
    expect(transport.payloads('room:selectCharacter')).toEqual([]);
    await userEvent.click(screen.getByTestId('char-select'));
    expect(transport.payloads('room:selectCharacter')).toEqual([{ characterId: 11 }]);
    rerender(
      <ClientProvider client={client}>
        <Router hook={memoryLocation({ path: '/r/123456' }).hook}>
          <ClassicLobby
            room={hostRoom({
              seats: [
                human(0, '房主', { host: true, isYou: true, character: 11 }),
                human(1, '小明', { character: 9 }),
                ai(2),
                seat(3),
              ],
            })}
            onLeave={() => {}}
          />
        </Router>
      </ClientProvider>,
    );
    expect(screen.getByTestId('char-select')).toHaveTextContent('已选择');
    expect(screen.getByTestId('char-select')).toBeDisabled();
    expect(screen.getByTestId('char-11')).toHaveAttribute('data-mine', 'true');
  });

  // 回归（复审）：已准备的非房主再 ◀ ▶ 翻看（只移动光标），预览换成新角色，但开局由房主发起、不会替他提交——
  // 进局仍是旧角色。现在移开已提交的角色就先取消准备；单击没被选走的头像是「移动 + 提交」，保持准备。
  it('非房主已准备：▶ 翻看先取消准备，再按准备提交新角色；单击没被选走的头像直接改选、保持准备', async () => {
    const guestYou = { role: 'player', seat: 1, isHost: false } as const;
    const readyRoom = roomView({
      seats: [
        human(0, 'A', { host: true, character: 0 }),
        human(1, '我', { isYou: true, ready: true, character: 11 }),
        seat(2),
        seat(3),
      ],
      you: guestYou,
    });
    const { transport, rerender, client } = renderWith(<ClassicLobby room={readyRoom} onLeave={() => {}} />);
    expect(screen.getByTestId('char-preview-name')).toHaveTextContent('金贝贝');
    // 单击没被选走的忍太郎：移动 + 提交，不取消准备（光标 = 进局的角色）
    await userEvent.click(screen.getByTestId('char-2'));
    expect(transport.payloads('room:selectCharacter')).toEqual([{ characterId: 2 }]);
    expect(transport.payloads('room:setReady')).toEqual([]);
    const picked2 = roomView({
      ...readyRoom,
      seats: [readyRoom.seats[0]!, human(1, '我', { isYou: true, ready: true, character: 2 }), seat(2), seat(3)],
    });
    const show = (r: RoomView): void =>
      rerender(
        <ClientProvider client={client}>
          <Router hook={memoryLocation({ path: '/r/123456' }).hook}>
            <ClassicLobby room={r} onLeave={() => {}} />
          </Router>
        </ClientProvider>,
      );
    show(picked2);
    expect(screen.getByTestId('char-2')).toHaveAttribute('data-mine', 'true');
    // ▶ 翻到钱夫人（只移动光标）：先取消准备，不提交
    await userEvent.click(screen.getByTestId('char-next'));
    expect(screen.getByTestId('char-preview-name')).toHaveTextContent('钱夫人');
    await waitFor(() => expect(transport.payloads('room:setReady')).toEqual([{ ready: false }]));
    expect(transport.payloads('room:selectCharacter')).toEqual([{ characterId: 2 }]);
    show(
      roomView({
        ...readyRoom,
        seats: [readyRoom.seats[0]!, human(1, '我', { isYou: true, character: 2 }), seat(2), seat(3)],
      }),
    );
    expect(screen.getByTestId('room-ready')).toHaveAccessibleName('准备');
    // 再按准备：先提交光标上的钱夫人，再准备
    await userEvent.click(screen.getByTestId('room-ready'));
    await waitFor(() => expect(transport.payloads('room:setReady')).toEqual([{ ready: false }, { ready: true }]));
    expect(transport.payloads('room:selectCharacter')).toEqual([{ characterId: 2 }, { characterId: 3 }]);
  });

  it('观战者：没有选角控件与 OK，只能离开；侧栏标「观战中」', () => {
    const room = roomView({
      seats: [human(0, 'A', { host: true }), human(1, 'B'), seat(2), seat(3)],
      you: { role: 'spectator', isHost: false },
      spectators: [{ id: 'w1', nickname: '观众' }],
    } as Partial<RoomView>);
    renderWith(<ClassicLobby room={room} onLeave={() => {}} />);
    expect(screen.queryByTestId('character-picker')).toBeNull();
    expect(screen.queryByTestId('char-0')).toBeNull();
    expect(screen.queryByTestId('room-ready')).toBeNull();
    expect(screen.getByTestId('room-leave')).toBeEnabled();
    expect(screen.getAllByText(/观战中/).length).toBeGreaterThan(0);
  });
});

// ───────────────────────── 按皮肤切换首页 ─────────────────────────

describe('首页按皮肤切换', () => {
  function packReady(usable: boolean): void {
    // 走真实的按需加载路径（atlasPackClient：条目 + 图集）；usable = false 时少了标题条目
    const frames: Record<string, FakeFrame[]> = {};
    for (const [k, sheet] of Object.entries(screenSheets()))
      frames[k] = sheet.frames.map((f) => [f!.w, f!.h, f!.ax, f!.ay]);
    for (const k of SCREEN_KEYS) frames[k] ??= rep(8, [124, 143, 62, 143]);
    if (!usable) delete frames['title.screen'];
    const client = atlasPackClient(frames);
    resetSkinStoreForTest({ client: client as unknown as PackClient });
    useAccessStore.setState({
      status: { mode: 'passcode', granted: true, kind: 'p', expiresAt: 0, grants: false, canGrant: false },
    } as never);
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

  it('素材包就绪、条目齐全：原版标题画面（素材仓库绑定到这个包）', async () => {
    packReady(true);
    renderWith(<SkinHome />);
    const home = await screen.findByTestId('screen-home');
    expect(home).toHaveAttribute('data-screen', 'title');
    expect(useClassicAssets.getState().packId).toBe('feedfacefeedface');
  });

  it('条目缺失：整体回退程序化首页', () => {
    packReady(false);
    renderWith(<SkinHome />);
    expect(screen.getByTestId('screen-home')).not.toHaveAttribute('data-screen');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('大富翁4 联机版');
  });

  it('设置为程序化：不等素材包；素材包发现中：载入画面', () => {
    useSettingsStore.setState({ skin: 'procedural' });
    const { unmount } = renderWith(<SkinHome />);
    expect(screen.getByTestId('home-nickname')).toBeInTheDocument();
    unmount();
    useSettingsStore.setState({ skin: 'auto' });
    useAccessStore.setState({
      status: { mode: 'passcode', granted: true, kind: 'p', expiresAt: 0, grants: false, canGrant: false },
    } as never);
    useSkinStore.setState({ pack: { status: 'loading' }, ensurePack: vi.fn(() => new Promise<PackState>(() => {})) });
    renderWith(<SkinHome />);
    expect(screen.getByTestId('screen-home-pending')).toBeInTheDocument();
    expect(screen.queryByTestId('home-nickname')).toBeNull();
  });

  it('门禁开启而未通过：程序化首页，不从首页触发素材包发现', () => {
    const ensure = vi.fn(() => Promise.resolve(useSkinStore.getState().pack));
    useSkinStore.setState({ ensurePack: ensure });
    useAccessStore.setState({
      status: { mode: 'passcode', granted: false, kind: null, expiresAt: null, grants: false, canGrant: false },
    } as never);
    renderWith(<SkinHome />);
    expect(screen.getByTestId('home-nickname')).toBeInTheDocument();
    expect(ensure).not.toHaveBeenCalled();
  });
});

// ───────────────────────── 工具列（手机横屏触控目标） ─────────────────────────

describe('工具列：手机横屏收成「更多」', () => {
  function renderBar(w: number, h: number, onTool = vi.fn()) {
    render(
      <ClassicStage
        size={{ w, h }}
        leftLabel="L"
        rightLabel="R"
        front={<Toolbar onTool={onTool} onAutopilotSettings={() => {}} />}
      >
        <span />
      </ClassicStage>,
    );
    return onTool;
  }

  it('844×390：7 个常用钮 + 更多（每格 55 宽）；其余 4 钮在菜单里（行高 56），点了照常触发并收起菜单', async () => {
    const onTool = renderBar(844, 390);
    const bar = screen.getByTestId('classic-toolbar');
    expect(bar).toHaveAttribute('data-compact', 'true');
    expect(within(bar).getAllByRole('button')).toHaveLength(8);
    expect(screen.getByTestId('tool-help').style.width).toBe('55px');
    expect(screen.queryByTestId('top-menu')).toBeNull();
    const more = screen.getByTestId('tool-more');
    await userEvent.click(more);
    expect(more).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByTestId('tool-more-menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((b) => b.dataset.testid),
    ).toEqual(['top-menu', 'tool-load', 'tool-save', 'action-board']);
    expect(within(menu).getByTestId('tool-save').style.height).toBe('56px');
    await userEvent.click(within(menu).getByTestId('tool-save'));
    expect(onTool).toHaveBeenCalledWith('save');
    expect(screen.queryByTestId('tool-more-menu')).toBeNull();
    await userEvent.click(more);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('tool-more-menu')).toBeNull();
    await userEvent.click(screen.getByTestId('tool-bigmap'));
    expect(onTool).toHaveBeenLastCalledWith('bigMap');
  });

  it('桌面 1920×1080：11 钮完整排法，没有「更多」', () => {
    renderBar(1920, 1080);
    const bar = screen.getByTestId('classic-toolbar');
    expect(bar).toHaveAttribute('data-compact', 'false');
    expect(within(bar).getAllByRole('button')).toHaveLength(11);
    expect(screen.queryByTestId('tool-more')).toBeNull();
  });
});
