// 路线 A 外壳（client-dom，original-skin.md §5 A10）：GameScreen 按皮肤切换布局；ClassicStage 缩放与区域布局；
// 工具列按钮行为；资料栏四页数值；日历节日切换；侧栏抽屉；原版素材帧与回退画法；GO 钮与快捷键；骰子。
// Pixi 不在 jsdom 挂载：BoardCanvas 用替身。

import type { AtlasV1 } from '@rich4/shared/assets';
import { buildMapIndex, buildTestMap, type MapIndex } from '@rich4/shared/data';
import type { YourDecision } from '@rich4/shared/net';
import type { GameView } from '@rich4/shared/view';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientProvider } from '../../app/services';
import type { BoardSurface } from '../../skin/BoardSurface';
import type { PackClient } from '../../skin/pack/PackClient';
import { resetSkinStoreForTest } from '../../skin/skinStore';
import { ORIGINAL_FONT_STACK } from '../../skin/theme';
import { useGameStore } from '../../store/gameStore';
import { useMapStore } from '../../store/mapStore';
import { useUiStore } from '../../store/uiStore';
import { makeTestClient } from '../../test/fakeTransport';
import { ai, human, roomView } from '../../test/roomFixtures';
import { selfPlay } from '../../test/selfPlay';
import { DecisionClockProvider } from '../decisions/clock';
import type { NewsPopupSpec } from '../popups/popupStore';
import { usePopupStore } from '../popups/popupStore';
import GameScreen from '../screens/GameScreen';
import { useSocialStore } from '../social/socialStore';
import { SystemMenu } from '../system/SystemMenu';
import { useTrusteeDialog } from '../system/TrusteeSettings';
import { GO_MASK_KEY, type MaskAsset, resetClassicAssetsForTest, type SpriteFrame, type SpriteSheet } from './assets';
import { MONTH_GRID, MOON_RECT, SUN_RECT } from './CalendarPanel';
import { ClassicLayout } from './ClassicLayout';
import { ClassicStage } from './ClassicStage';
import { diceCountFrame, GO_MASK_REGIONS, onGoFace } from './GoButton';
import { DICE_COUNT_RECT, GO_RECT } from './layout';
import { PROFILE_PAGES, profileNumbers, profileRows } from './profileStats';

vi.mock('../screens/BoardCanvas', () => ({
  BoardCanvas: () => <div data-testid="board-host">board</div>,
}));

// GameScreen 的皮肤判定（素材包发现、地图绑定）另有 skinStore 的测试；这里直接给出判定结果
const skinMock = vi.hoisted(() => ({ skin: 'original' as 'original' | 'procedural' }));
vi.mock('../../skin/useGameSkin', () => ({
  useGameSkin: () => ({
    resolution: {
      pref: 'auto',
      skin: skinMock.skin,
      board: 'procedural',
      reason: skinMock.skin === 'original' ? null : 'pack-absent',
      boardReason: 'renderer-unavailable',
      mismatches: [],
      mapId: 'test',
      packId: null,
    },
    waitForPack: false,
  }),
}));

const room = roomView({
  phase: 'playing',
  epoch: 1,
  seats: [human(0, '我', { isYou: true, host: true }), ai(1), human(2, '小红'), ai(3)],
});
const spectatorRoom = roomView({
  phase: 'playing',
  epoch: 1,
  seats: [human(0, '甲'), ai(1), human(2, '乙'), ai(3)],
  you: { role: 'spectator', id: 's1', isHost: false } as never,
});

const sp = selfPlay({ seed: 21, steps: 60 });
const map: MapIndex = buildMapIndex(buildTestMap());

/** 我的 TURN_MENU（可选骰子数） */
function turnMenu(view: GameView, allowed: (1 | 2 | 3)[] = [1, 2, 3]): YourDecision {
  const b = sp.batches.find((x) => x.yourDecision?.kind === 'TURN_MENU')!;
  const d = structuredClone(b.yourDecision!) as YourDecision & { options: { dice: unknown } };
  d.options.dice = { current: 1, allowed, locked: null };
  void view;
  return d;
}

function load(view: GameView, decision: YourDecision | null = null): void {
  act(() => useGameStore.getState().resetTo({ epoch: 1, seq: 10, view, pending: [], decision }));
}

function fakeSurface(): BoardSurface & { calls: string[] } {
  const calls: string[] = [];
  let zoom = 0.85;
  return {
    calls,
    kind: 'procedural',
    loaded: true,
    rotation: 0,
    rotationStep: 2,
    camera: {
      get zoom() {
        return zoom;
      },
      minZoom: 0.2,
      maxZoom: 2,
      center: { x: 0, y: 0 },
      followPaused: false,
      panTo: async () => {},
      zoomTo: async (z: number) => {
        calls.push(`zoomTo:${z}`);
        zoom = z;
      },
      fitAll: async () => {
        calls.push('fitAll');
        zoom = 0.3;
      },
      screenToWorld: (p: { x: number; y: number }) => p,
      worldToScreen: (p: { x: number; y: number }) => p,
      screenAnchor: () => ({ x: 0, y: 0 }),
      setInsets: () => {},
      onUserGesture: () => calls.push('gesture'),
    },
    rotate: () => 0,
    loadMap: async () => {},
    anchorPos: () => null,
    viewportCorners: () => null,
    tileCanvasPos: () => null,
    viewportSize: () => ({ w: 990, h: 990 }),
    onTap: null,
    onDoubleTap: null,
    board: {
      allActors: () => [],
      actor: () => undefined,
      roads: { counts: () => ({ objects: 0, gods: 0, beggars: 0, villains: 0 }) },
    },
    destroy: () => {},
  } as unknown as BoardSurface & { calls: string[] };
}

interface RenderOpts {
  packId?: string | null;
  view?: GameView;
  room?: typeof room;
  size?: { w: number; h: number };
  surface?: BoardSurface | null;
  onRotate?(d: number): void;
  onFocusMe?(): void;
}

function renderClassic(o: RenderOpts = {}) {
  const t = makeTestClient();
  const view = o.view ?? sp.batches[10]!.view;
  function Host(): ReactNode {
    const [menu, setMenu] = useState(false);
    const v = useGameStore((s) => s.view) ?? view;
    const r = o.room ?? room;
    return (
      <>
        <ClassicLayout
          room={r}
          view={v}
          map={map}
          board={<div data-testid="board-host">board</div>}
          surface={o.surface ?? null}
          rotation={0}
          onRotate={o.onRotate ?? (() => {})}
          onFocusMe={o.onFocusMe ?? (() => {})}
          onPan={() => {}}
          viewport={() => null}
          onOpenMenu={() => setMenu(true)}
          onLeave={() => {}}
          packId={o.packId ?? null}
          size={o.size ?? { w: 1920, h: 1080 }}
        />
        <SystemMenu room={r} open={menu} onOpenChange={setMenu} onLeave={() => {}} />
      </>
    );
  }
  const utils = render(
    <ClientProvider client={t.client}>
      <DecisionClockProvider offsetMs={0}>
        <Host />
      </DecisionClockProvider>
    </ClientProvider>,
  );
  return { ...utils, ...t, view };
}

/** 假精灵表：每帧 10×10，锚点 (2,3)，全在同一张 100×100 的图集页 */
function fakeSheet(key: string, count: number): SpriteSheet {
  const frames: SpriteFrame[] = [];
  for (let i = 0; i < count; i++) {
    frames.push({ url: `/pack/${key}.png`, x: i * 10, y: 0, w: 10, h: 10, ax: 2, ay: 3, sheetW: 100, sheetH: 100 });
  }
  return { key, frames };
}

beforeEach(() => {
  useMapStore.getState().clear();
  resetClassicAssetsForTest();
  skinMock.skin = 'original';
});

afterEach(() => {
  useGameStore.getState().clear();
  useUiStore.getState().clear();
  useTrusteeDialog.getState().setOpen(false);
  resetClassicAssetsForTest();
});

describe('GameScreen 按皮肤切换布局', () => {
  it('原版皮肤：地图载入后用经典布局（舞台、工具列、资料栏、日历、侧栏），棋盘嵌在棋盘视窗里', async () => {
    const t = makeTestClient();
    load(sp.batches[10]!.view);
    render(
      <ClientProvider client={t.client}>
        <GameScreen room={room} onLeave={() => {}} />
      </ClientProvider>,
    );
    const stage = await screen.findByTestId('classic-stage');
    expect(screen.getByTestId('screen-game')).toHaveAttribute('data-layout', 'classic');
    expect(within(stage).getByTestId('classic-toolbar')).toBeInTheDocument();
    expect(within(stage).getByTestId('classic-profile')).toBeInTheDocument();
    expect(within(stage).getByTestId('classic-calendar')).toBeInTheDocument();
    expect(within(screen.getByTestId('classic-board-slot')).getByTestId('board-host')).toBeInTheDocument();
    expect(screen.queryByTestId('top-bar')).toBeNull();
    // 程序化布局的测试钩子沿用：座位数值、地块归属、日期、回合
    const v = sp.batches[10]!.view;
    for (const p of v.players) {
      expect(screen.getByTestId(`p${p.seat}-cash`)).toHaveAttribute('data-value', String(p.cash));
      expect(screen.getByTestId(`chip-${p.seat}`)).toHaveAttribute('data-current');
    }
    expect(within(screen.getByTestId('hud-lots')).getAllByRole('listitem')).toHaveLength(
      v.lands.length + v.facilities.length,
    );
    expect(screen.getByTestId('hud-date')).toHaveAttribute('data-date', String(v.clock.date));
    expect(screen.getByTestId('hud-turn')).toHaveAttribute('data-turn', String(v.clock.turnNo));
  });

  it('程序化皮肤：保持原有布局', async () => {
    skinMock.skin = 'procedural';
    const t = makeTestClient();
    load(sp.batches[10]!.view);
    render(
      <ClientProvider client={t.client}>
        <GameScreen room={room} onLeave={() => {}} />
      </ClientProvider>,
    );
    expect(await screen.findByTestId('top-bar')).toBeInTheDocument();
    expect(screen.getByTestId('screen-game')).not.toHaveAttribute('data-layout');
    expect(screen.queryByTestId('classic-stage')).toBeNull();
  });
});

describe('ClassicStage：缩放与区域布局', () => {
  const rails = {
    leftLabel: '左',
    rightLabel: '右',
    left: () => <p data-testid="left-content">L</p>,
    right: () => <p data-testid="right-content">R</p>,
  };

  it('1920×1080：scale 2.25、平滑；舞台 transform 与棋盘视窗真实像素；两侧整栏', () => {
    render(
      <ClassicStage size={{ w: 1920, h: 1080 }} board={<i data-testid="b" />} {...rails}>
        <span data-testid="inside" />
      </ClassicStage>,
    );
    const root = screen.getByTestId('classic-stage');
    expect(root).toHaveAttribute('data-scale', '2.2500');
    expect(root).toHaveAttribute('data-pixelated', 'false');
    expect(root).toHaveAttribute('data-rails', 'full');
    const inner = screen.getByTestId('classic-stage-inner');
    expect(inner.style.transform).toBe('translate(240px, 0px) scale(2.25)');
    expect(inner).toHaveAttribute('data-pixelated', 'false');
    expect(within(inner).getByTestId('inside')).toBeInTheDocument();
    const slot = screen.getByTestId('classic-board-slot');
    expect([slot.style.left, slot.style.top, slot.style.width, slot.style.height]).toEqual([
      '240px',
      '90px',
      '990px',
      '990px',
    ]);
    const left = screen.getByTestId('classic-rail-left');
    expect(left).toHaveAttribute('data-mode', 'full');
    expect([left.style.left, left.style.width]).toEqual(['0px', '240px']);
    expect(screen.getByTestId('classic-rail-right').style.left).toBe('1680px');
    expect(screen.queryByTestId('classic-drawer-left-btn')).toBeNull();
  });

  it('2560×1440：整数倍 3 → 最近邻', () => {
    render(
      <ClassicStage size={{ w: 2560, h: 1440 }} {...rails}>
        <span />
      </ClassicStage>,
    );
    expect(screen.getByTestId('classic-stage')).toHaveAttribute('data-pixelated', 'true');
    expect(screen.getByTestId('classic-stage-inner')).toHaveAttribute('data-pixelated', 'true');
    expect(screen.getByTestId('classic-stage-inner').style.transform).toBe('translate(320px, 0px) scale(3)');
  });

  it('经典布局的区域坐标：工具列 (0,0) 440×40、资料栏 (440,0) 200×280、日历 (440,280) 200×200、GO 钮在棋盘视窗右下', () => {
    load(sp.batches[10]!.view, turnMenu(sp.batches[10]!.view));
    renderClassic();
    const box = (id: string) => {
      const s = screen.getByTestId(id).style;
      return [s.left, s.top, s.width, s.height];
    };
    expect(box('classic-toolbar')).toEqual(['0px', '0px', '440px', '40px']);
    expect(box('classic-profile')).toEqual(['440px', '0px', '200px', '280px']);
    expect(box('classic-calendar')).toEqual(['440px', '280px', '200px', '200px']);
    expect(box('action-roll')).toEqual(['360px', '400px', '72px', '67px']);
    const toolbar = screen.getByTestId('classic-toolbar');
    const buttons = within(toolbar).getAllByRole('button');
    expect(buttons).toHaveLength(11);
    expect(buttons.map((b) => b.style.left)).toEqual(Array.from({ length: 11 }, (_, i) => `${i * 40}px`));
    expect(buttons.map((b) => b.dataset.tool)).toEqual([
      'help',
      'settings',
      'autopilot',
      'load',
      'save',
      'bigMap',
      'info',
      'items',
      'cards',
      'board',
      'stock',
    ]);
  });
});

describe('工具列', () => {
  it('查询 → 玩家资产面板；非本人回合的道具 / 卡片 / 股市 / 公布栏 → 查看面板（再点一次收起）', async () => {
    const view = sp.batches[10]!.view;
    load(view);
    renderClassic();
    await userEvent.click(screen.getByTestId('action-info'));
    expect(useUiStore.getState().panel).toBe('info');
    expect(await screen.findByTestId('panel-info')).toBeInTheDocument();
    act(() => useUiStore.getState().openPanel(null));
    await userEvent.click(screen.getByTestId('action-stock'));
    expect(useUiStore.getState().panel).toBe('stock');
    act(() => useUiStore.getState().openPanel(null));
    await userEvent.click(screen.getByTestId('action-items'));
    expect(useUiStore.getState().panel).toBe('items');
    expect(screen.getByTestId('action-items')).toHaveAttribute('aria-label');
  });

  it('本人 TURN_MENU：道具 / 卡片 / 股市 / 公布栏直接展开回合菜单的对应子页', async () => {
    const view = sp.batches[10]!.view;
    load(view, turnMenu(view));
    renderClassic();
    for (const [id, sheet] of [
      ['action-cards', 'cards'],
      ['action-items', 'items'],
      ['action-stock', 'stock'],
      ['action-board', 'board'],
    ] as const) {
      act(() => useUiStore.getState().openPanel(null));
      fireEvent.click(screen.getByTestId(id));
      expect(useUiStore.getState().panel).toBe('menu');
      expect(useUiStore.getState().menuSheet).toBe(sheet);
    }
  });

  it('系统设定 → 系统菜单；说明 → 说明窗；LOAD / SAVE → 存读档', async () => {
    load(sp.batches[10]!.view);
    renderClassic();
    await userEvent.click(screen.getByTestId('top-menu'));
    expect(await screen.findByTestId('system-menu')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('system-menu')).toBeNull());
    await userEvent.click(screen.getByTestId('tool-help'));
    expect(await screen.findByTestId('classic-help')).toHaveTextContent('D');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('classic-help')).toBeNull());
    await userEvent.click(screen.getByTestId('tool-load'));
    expect(await screen.findByTestId('classic-saves')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('classic-saves')).toBeNull());
    await userEvent.click(screen.getByTestId('tool-save'));
    expect(await screen.findByTestId('classic-saves')).toBeInTheDocument();
  });

  it('托管：点按切换（game:autopilot），右键打开托管设置', async () => {
    load(sp.batches[10]!.view);
    const { transport } = renderClassic();
    const btn = screen.getByTestId('action-autopilot');
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(btn);
    expect(transport.payloads('game:autopilot')[0]).toEqual({ on: true });
    fireEvent.contextMenu(btn);
    expect(useTrusteeDialog.getState().open).toBe(true);
  });

  it('大地图：第一次俯瞰全图，第二次回到原来的缩放并回到当前玩家', async () => {
    load(sp.batches[10]!.view);
    const surface = fakeSurface();
    const focus = vi.fn();
    renderClassic({ surface, onFocusMe: focus });
    const btn = screen.getByTestId('tool-bigmap');
    await userEvent.click(btn);
    expect(surface.calls).toEqual(['gesture', 'fitAll']);
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(btn);
    expect(surface.calls.at(-1)).toBe('zoomTo:0.85');
    expect(focus).toHaveBeenCalledTimes(1);
    expect(btn).toHaveAttribute('aria-pressed', 'false');
  });

  it('观战者：托管、道具、卡片、股市、公布栏、存读档不可用；没有 GO 钮', () => {
    load(sp.batches[10]!.view);
    renderClassic({ room: spectatorRoom });
    for (const id of [
      'action-autopilot',
      'action-items',
      'action-cards',
      'action-stock',
      'action-board',
      'tool-save',
    ]) {
      expect(screen.getByTestId(id)).toBeDisabled();
    }
    for (const id of ['tool-help', 'top-menu', 'tool-bigmap', 'action-info'])
      expect(screen.getByTestId(id)).toBeEnabled();
    expect(screen.queryByTestId('action-roll')).toBeNull();
  });

  it('经 PackClient 绑定：图集加载中先不画回退字（避免闪一下），就绪后画原版帧；条目缺失的区域画回退', async () => {
    load(sp.batches[10]!.view);
    let release!: (a: AtlasV1) => void;
    const pending = new Promise<AtlasV1>((r) => {
      release = r;
    });
    const client = {
      usableEntry: (k: string) =>
        k === 'ui.toolbar'
          ? {
              type: 'sprite',
              atlas: ['sprites/panel/1.json'],
              frames: { base: 'Panel#1', start: 0, count: 23 },
              anchor: 'frame',
            }
          : null,
      loadAtlas: () => pending,
      atlasImageUrl: () => '/pack/sprites/panel/1.h8.png',
    } as unknown as PackClient;
    resetSkinStoreForTest({ client });
    try {
      renderClassic({ packId: 'p1' });
      const help = screen.getByTestId('tool-help');
      expect(help).toBeEmptyDOMElement();
      await waitFor(() => expect(screen.getByTestId('classic-profile')).toHaveAttribute('data-art', 'false'));
      const frames: Record<string, unknown> = {};
      const anchorsPx: Record<string, [number, number]> = {};
      for (let i = 0; i < 23; i++) {
        frames[`Panel#1/${i}`] = {
          frame: { x: i * 10, y: 0, w: 10, h: 10 },
          rotated: false,
          trimmed: false,
          spriteSourceSize: { x: 0, y: 0, w: 10, h: 10 },
          sourceSize: { w: 10, h: 10 },
          anchor: { x: 0.5, y: 0.5 },
        };
        anchorsPx[`Panel#1/${i}`] = [5, 5];
      }
      await act(async () => {
        release({
          schema: 'rich4.atlas/1',
          frames,
          meta: {
            app: 't',
            version: '1',
            image: 'x.png',
            format: 'RGBA8888',
            size: { w: 256, h: 16 },
            scale: '1',
            r4: { anchorsPx },
          },
        } as unknown as AtlasV1);
      });
      await waitFor(() => expect(help.querySelector('[data-sprite]')).toHaveAttribute('data-sprite', 'ui.toolbar/1'));
      expect(screen.getByTestId('classic-toolbar')).toHaveAttribute('data-art', 'true');
    } finally {
      resetSkinStoreForTest();
    }
  });

  it('素材就绪时画原版帧（常态 1–11 / 悬停 12–22），否则画回退字', () => {
    load(sp.batches[10]!.view);
    resetClassicAssetsForTest({ sprites: { 'ui.toolbar': fakeSheet('ui.toolbar', 23) } });
    renderClassic();
    const tb = screen.getByTestId('classic-toolbar');
    expect(tb).toHaveAttribute('data-art', 'true');
    const help = screen.getByTestId('tool-help');
    const sprites = [...help.querySelectorAll('[data-sprite]')].map((e) => e.getAttribute('data-sprite'));
    expect(sprites).toEqual(['ui.toolbar/1', 'ui.toolbar/12']);
    // 落点 = 画点 − 锚点：第 0 钮画点 (20,20)，假锚点 (2,3)
    const s0 = help.querySelector<HTMLElement>('[data-sprite="ui.toolbar/1"]')!.style;
    expect([s0.left, s0.top, s0.backgroundPosition]).toEqual(['18px', '17px', '-10px 0px']);
    expect(within(tb).getAllByRole('button')[10]!.querySelector('[data-sprite]')).toHaveAttribute(
      'data-sprite',
      'ui.toolbar/11',
    );
  });
});

describe('资料栏四页', () => {
  it('资金 / 地产 / 股票 / 其他 四页数值与 view 一致；点左栏座位切换查看对象', async () => {
    const view = sp.batches.at(-1)!.view;
    load(view);
    renderClassic({ view });
    const profile = screen.getByTestId('classic-profile');
    const seat = Number(profile.getAttribute('data-seat'));
    expect(profile).toHaveAttribute('data-page', 'funds');
    const check = (s: number): void => {
      const n = profileNumbers(view, map, s as never)!;
      for (const page of PROFILE_PAGES) {
        fireEvent.click(screen.getByTestId(`classic-tab-${page}`));
        expect(profile).toHaveAttribute('data-page', page);
        expect(screen.getByTestId(`classic-tab-${page}`)).toHaveAttribute('aria-selected', 'true');
        for (const r of profileRows(page, n)) {
          expect(screen.getByTestId(`classic-val-${page}-${r.field}`)).toHaveAttribute('data-value', String(r.value));
        }
      }
    };
    check(seat);
    expect(screen.getByTestId('classic-val-other-points')).toHaveTextContent(
      String(view.players.find((p) => p.seat === seat)!.points),
    );
    expect(screen.getByTestId('classic-price-index')).toHaveAttribute('data-value', String(view.econ.priceIndex));
    const other = view.players.find((p) => p.seat !== seat)!;
    await userEvent.click(screen.getByTestId(`chip-${other.seat}`));
    expect(profile).toHaveAttribute('data-seat', String(other.seat));
    expect(screen.getByTestId('classic-avatar')).toHaveAttribute('data-character', String(other.character));
    check(other.seat);
    fireEvent.click(screen.getByTestId('classic-tab-funds'));
    expect(screen.getByTestId('classic-val-funds-cash')).toHaveTextContent(other.cash.toLocaleString('en-US'));
  });

  it('页图就绪时贴 Panel#0 对应页（帧 = 页号）与头像帧（帧 = 角色号）', () => {
    const view = sp.batches[10]!.view;
    load(view);
    resetClassicAssetsForTest({
      sprites: { 'ui.sidebar': fakeSheet('ui.sidebar', 6), 'portrait.face72': fakeSheet('portrait.face72', 12) },
    });
    renderClassic({ view });
    const profile = screen.getByTestId('classic-profile');
    expect(profile).toHaveAttribute('data-art', 'true');
    expect(profile.querySelector('[data-sprite^="ui.sidebar/"]')).toHaveAttribute('data-sprite', 'ui.sidebar/0');
    fireEvent.click(screen.getByTestId('classic-tab-stocks'));
    expect(profile.querySelector('[data-sprite^="ui.sidebar/"]')).toHaveAttribute('data-sprite', 'ui.sidebar/2');
    const seat = Number(profile.getAttribute('data-seat'));
    const ch = view.players.find((p) => p.seat === seat)!.character;
    expect(screen.getByTestId('classic-avatar').querySelector('[data-sprite]')).toHaveAttribute(
      'data-sprite',
      `portrait.face72/${ch}`,
    );
  });
});

describe('日历', () => {
  function withClock(view: GameView, clock: Partial<GameView['clock']>, mapId?: string): GameView {
    return {
      ...view,
      clock: { ...view.clock, ...clock },
      ...(mapId ? { dataRef: { ...view.dataRef, mapId } } : {}),
    };
  }

  it('缺省月历（今天加框）；太阳 → 日历；节日当天切到节日插画，节日过去回到月历', async () => {
    const base = sp.batches[10]!.view;
    load(withClock(base, { date: 19980105, weekday: 1, holiday: null }));
    renderClassic({ view: base });
    const cal = screen.getByTestId('classic-calendar');
    expect(cal).toHaveAttribute('data-mode', 'month');
    expect(screen.getByTestId('classic-month-title')).toHaveTextContent('1998 年 1 月');
    const today = within(screen.getByTestId('classic-month')).getByText('5');
    expect(today).toHaveAttribute('aria-current', 'date');
    expect(screen.getByTestId('classic-cal-bg')).toHaveAttribute('data-bg', 'fallback-month-3');

    // 节日（fixture 地图没有插画 → 回退画法写节日名）
    load(withClock(base, { date: 19981225, weekday: 5, holiday: 'h1' }));
    await waitFor(() => expect(cal).toHaveAttribute('data-mode', 'day'));
    expect(cal).toHaveAttribute('data-holiday', 'h1');
    expect(screen.getByTestId('classic-cal-bg')).toHaveAttribute('data-bg', 'holiday-fallback');
    expect(screen.getByTestId('classic-cal-bg')).toHaveTextContent('圣诞节');

    // 节日过去 → 回到之前的月历
    load(withClock(base, { date: 19981226, weekday: 6, holiday: null }));
    await waitFor(() => expect(cal).toHaveAttribute('data-mode', 'month'));

    // 太阳 / 月亮手动切换
    await userEvent.click(screen.getByTestId('classic-cal-sun'));
    expect(cal).toHaveAttribute('data-mode', 'day');
    expect(screen.getByTestId('classic-day')).toHaveTextContent('12 月 26 日');
    await userEvent.click(screen.getByTestId('classic-cal-moon'));
    expect(cal).toHaveAttribute('data-mode', 'month');
  });

  it('台湾图节日：换成 illustration.holiday.<slot> 插画；日历页图就绪时贴 Panel#2 季节帧', async () => {
    const base = sp.batches[10]!.view;
    resetClassicAssetsForTest({
      sprites: { 'ui.calendar': fakeSheet('ui.calendar', 12) },
      images: { 'illustration.holiday.0': { url: '/pack/images/data/4.png', w: 200, h: 200 } },
    });
    load(withClock(base, { date: 19980701, weekday: 3, holiday: null }, 'taiwan'));
    renderClassic({ view: base });
    const cal = screen.getByTestId('classic-calendar');
    expect(screen.getByTestId('classic-cal-bg')).toHaveAttribute('data-bg', 'ui.calendar/5');
    await userEvent.click(screen.getByTestId('classic-cal-sun'));
    expect(screen.getByTestId('classic-cal-bg')).toHaveAttribute('data-bg', 'ui.calendar/1');
    load(withClock(base, { date: 19990101, weekday: 5, holiday: 'h0' }, 'taiwan'));
    await waitFor(() =>
      expect(screen.getByTestId('classic-cal-bg')).toHaveAttribute('data-bg', 'illustration.holiday.0'),
    );
    expect(screen.getByTestId('classic-cal-bg').style.backgroundImage).toContain('/pack/images/data/4.png');
    expect(cal).toHaveAttribute('data-mode', 'day');
  });

  it('右上角切到缩小地图（带旋转钮），再切回日历', async () => {
    // jsdom 没有 2D 画布：画家不创建（真实浏览器里由 E2E 覆盖）
    const gc = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    load(sp.batches[10]!.view);
    const rot = vi.fn();
    renderClassic({ onRotate: rot });
    await userEvent.click(screen.getByTestId('classic-cal-toggle'));
    expect(screen.getByTestId('classic-calendar')).toHaveAttribute('data-mode', 'map');
    expect(screen.getByTestId('classic-minimap')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('rotate-right'));
    await userEvent.click(screen.getByTestId('rotate-left'));
    expect(rot.mock.calls).toEqual([[1], [-1]]);
    await userEvent.click(screen.getByTestId('classic-cal-toggle'));
    expect(screen.getByTestId('classic-calendar')).toHaveAttribute('data-mode', 'month');
    gc.mockRestore();
  });
});

describe('联机侧栏', () => {
  it('整栏：左栏房间号、回合、座位与在线 / 托管 / 电脑；右栏聊天与日志页签', async () => {
    const view = sp.batches[10]!.view;
    load(view);
    renderClassic();
    const left = screen.getByTestId('classic-rail-left');
    expect(within(left).getByTestId('classic-room-code')).toHaveTextContent('123456');
    expect(within(left).getByTestId('chip-1')).toHaveTextContent('电脑');
    expect(within(left).getByTestId('chip-0')).toHaveTextContent('在线');
    const right = screen.getByTestId('classic-rail-right');
    expect(within(right).getByTestId('top-chat')).toHaveAttribute('aria-pressed', 'true');
    expect(within(right).getByTestId('chat-panel')).toBeInTheDocument();
    await userEvent.click(within(right).getByTestId('top-log'));
    expect(within(right).getByTestId('event-log')).toBeInTheDocument();
    expect(within(right).queryByTestId('chat-panel')).toBeNull();
  });

  it('手机横屏 844×390：两侧收成抽屉按钮；抽屉内容常驻 DOM（数值可读），打开 / Esc 关闭 / × 关闭', async () => {
    const view = sp.batches[10]!.view;
    load(view);
    renderClassic({ size: { w: 844, h: 390 } });
    expect(screen.getByTestId('classic-stage')).toHaveAttribute('data-rails', 'drawer');
    expect(screen.getByTestId('classic-stage-inner').style.transform).toBe('translate(162px, 0px) scale(0.8125)');
    const left = screen.getByTestId('classic-rail-left');
    expect(left).toHaveAttribute('data-mode', 'drawer');
    expect(left).not.toBeVisible();
    // 隐藏时数值仍在（E2E hudSnapshot 读 data-value）
    const p0 = view.players[0]!;
    expect(screen.getByTestId(`p${p0.seat}-cash`)).toHaveAttribute('data-value', String(p0.cash));
    const btn = screen.getByTestId('classic-drawer-left-btn');
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(btn);
    expect(left).toBeVisible();
    expect(left).toHaveAttribute('data-open', 'true');
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('classic-drawer-left-close')).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(left).not.toBeVisible();
    expect(btn).toHaveFocus();
    // 右抽屉：聊天
    await userEvent.click(screen.getByTestId('classic-drawer-right-btn'));
    const right = screen.getByTestId('classic-rail-right');
    expect(right).toBeVisible();
    expect(within(right).getByTestId('chat-panel')).toBeVisible();
    await userEvent.click(screen.getByTestId('classic-drawer-right-close'));
    expect(right).not.toBeVisible();
    // 另开一侧时先收起这一侧
    await userEvent.click(screen.getByTestId('classic-drawer-left-btn'));
    await userEvent.click(screen.getByTestId('classic-drawer-right-btn'));
    expect(left).not.toBeVisible();
    expect(right).toBeVisible();
  });
});

describe('演出弹窗', () => {
  afterEach(() => {
    act(() => usePopupStore.getState().clear());
  });

  const news: NewsPopupSpec = {
    kind: 'news',
    id: 8,
    category: 1,
    categoryLabel: '政府公告',
    headline: '地产大亨受表扬',
    body: '孙小美 名下地产最多，获颁奖金 10,000 元。',
    affected: [],
  };

  it('放在棋盘视窗叠层的下部（棋盘中央留给原版 FLIC）；桌面不缩小，手机横屏按叠层缩小', () => {
    const { unmount } = renderClassic();
    act(() => {
      usePopupStore.getState().open(news, 3000);
    });
    const overlay = screen.getByTestId('classic-board-overlay');
    const layer = within(overlay).getByTestId('popup-layer');
    expect(layer).toHaveAttribute('data-placement', 'board');
    expect(layer.style.getPropertyValue('--popup-scale')).toBe('1');
    expect(within(layer).getByTestId('news-popup')).toBeInTheDocument();
    unmount();
    renderClassic({ size: { w: 844, h: 390 } });
    const small = within(screen.getByTestId('classic-board-overlay')).getByTestId('popup-layer');
    const k = Number(small.style.getPropertyValue('--popup-scale'));
    expect(k).toBeGreaterThanOrEqual(0.5);
    expect(k).toBeLessThan(1);
  });
});

describe('GO 钮、骰子数与快捷键', () => {
  it('我的 TURN_MENU：GO 可按，带骰子数；D 键与小骰子切换颗数；空格前进；< > 旋转', async () => {
    const view = sp.batches[10]!.view;
    const decision = turnMenu(view);
    load(view, decision);
    const rot = vi.fn();
    const { transport } = renderClassic({ onRotate: rot });
    const go = screen.getByTestId('action-roll');
    expect(go).toBeEnabled();
    expect(go).toHaveAttribute('data-state', 'normal');
    expect(go).toHaveTextContent('掷骰（1 颗）');
    const dc = screen.getByTestId('action-dice-count');
    await userEvent.click(dc);
    expect(dc).toHaveAttribute('data-value', '2');
    fireEvent.keyDown(window, { key: 'd' });
    expect(dc).toHaveAttribute('data-value', '3');
    fireEvent.keyDown(window, { key: '<' });
    fireEvent.keyDown(window, { key: '>' });
    expect(rot.mock.calls).toEqual([[-1], [1]]);
    fireEvent.keyDown(window, { key: ' ' });
    const sent = transport.payloads('game:act')[0]!;
    expect(sent.decisionId).toBe(decision.decisionId);
    expect(sent.intent).toEqual({ type: 'ROLL', dice: 3 });
  });

  it('不是我的决策：GO 禁止态；输入框里的空格不触发前进', async () => {
    const view = sp.batches[10]!.view;
    load(view);
    const { transport } = renderClassic();
    const go = screen.getByTestId('action-roll');
    expect(go).toBeDisabled();
    expect(go).toHaveAttribute('data-state', 'disabled');
    expect(go).toHaveAttribute('data-frame', '2');
    act(() => useGameStore.getState().resetTo({ epoch: 1, seq: 11, view, pending: [], decision: turnMenu(view) }));
    const input = screen.getByTestId('chat-input');
    input.focus();
    fireEvent.keyDown(input, { key: ' ' });
    expect(transport.payloads('game:act')).toHaveLength(0);
  });

  it('乌龟：GO 换乌龟帧，按下发不带骰子数的 ROLL', async () => {
    const view = sp.batches[10]!.view;
    const d = turnMenu(view) as YourDecision & { options: { dice: unknown } };
    d.options.dice = { current: 1, allowed: [1], locked: 'tortoise' };
    load(view, d);
    const { transport } = renderClassic();
    const go = screen.getByTestId('action-roll');
    expect(go).toHaveAttribute('data-state', 'tortoise');
    expect(go).toHaveAttribute('data-frame', '4');
    await userEvent.click(go);
    expect(transport.payloads('game:act')[0]!.intent).toEqual({ type: 'ROLL' });
    expect(screen.getByTestId('action-dice-count')).toBeDisabled();
  });

  it('骰子：滚动中 → 落定显示点数与合计（素材缺失时画 CSS 骰子）', () => {
    load(sp.batches[10]!.view);
    renderClassic();
    act(() => {
      useUiStore.getState().setDice({ seat: 0, faces: [3, 4], rolling: true });
    });
    const dice = screen.getByTestId('dice-overlay');
    expect(dice).toHaveAttribute('data-rolling', 'true');
    act(() => {
      useUiStore.getState().setDice({ seat: 0, faces: [3, 4], rolling: false });
    });
    expect(screen.getByTestId('dice-overlay')).toHaveAttribute('data-sum', '7');
    expect(screen.getByTestId('dice-overlay')).toHaveTextContent('3');
    expect(screen.getByTestId('dice-overlay')).toHaveTextContent('4');
  });
});

describe('审查修正', () => {
  afterEach(() => {
    act(() => useSocialStore.getState().reset());
  });

  /** 与原版掩膜同语义的 72×67 区域图：四角 4、左侧竖槽 1（x7..22、y9..56）、钮面 3、其余边框 2 */
  function goMask(): MaskAsset {
    const w = 72;
    const h = 67;
    const data = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 2;
        if ((x < 6 || x > 65) && (y < 6 || y > 60)) r = 4;
        if (x >= 30 && x <= 64 && y >= 14 && y <= 54) r = 3;
        if (x >= 7 && x <= 22 && y >= 9 && y <= 56) r = 1;
        data[y * w + x] = r;
      }
    }
    return { w, h, data };
  }

  it('骰子数小图：图6–11 两两成对（1/2/3 点，灰 / 白底红点）；可切换时画白底红点，不能切换时画灰', async () => {
    expect([1, 2, 3].map((n) => diceCountFrame(n, false))).toEqual([6, 8, 10]);
    expect([1, 2, 3].map((n) => diceCountFrame(n, true))).toEqual([7, 9, 11]);
    const view = sp.batches[10]!.view;
    load(view, turnMenu(view));
    resetClassicAssetsForTest({ sprites: { 'ui.goButton': fakeSheet('ui.goButton', 12) } });
    renderClassic();
    const dc = screen.getByTestId('action-dice-count');
    const sprite = () => within(dc).getByTestId('dice-count-sprite');
    expect(sprite()).toHaveAttribute('data-sprite', 'ui.goButton/7');
    await userEvent.click(dc);
    expect(sprite()).toHaveAttribute('data-sprite', 'ui.goButton/9');
    await userEvent.click(dc);
    expect(sprite()).toHaveAttribute('data-sprite', 'ui.goButton/11');
    // 不是我的回合：灰图（当前颗数）
    act(() => useGameStore.getState().resetTo({ epoch: 1, seq: 11, view, pending: [], decision: null }));
    expect(dc).toBeDisabled();
    expect(sprite()).toHaveAttribute('data-sprite', 'ui.goButton/6');
  });

  it('骰子数竖槽在 GO 钮掩膜的区 1 里（不再压在棋盘上）；GO 只认区 2、3：点透明四角与竖槽不掷骰', async () => {
    expect([
      DICE_COUNT_RECT.x - GO_RECT.x,
      DICE_COUNT_RECT.y - GO_RECT.y,
      DICE_COUNT_RECT.w,
      DICE_COUNT_RECT.h,
    ]).toEqual([7, 9, 16, 48]);
    const m = goMask();
    expect(onGoFace(m, { x: 1, y: 1 })).toBe(false);
    expect(onGoFace(m, { x: 10, y: 30 })).toBe(false);
    expect(onGoFace(m, { x: 45, y: 30 })).toBe(true);
    expect(onGoFace(m, { x: 26, y: 5 })).toBe(true);
    expect(onGoFace(null, { x: 1, y: 1 })).toBe(true);
    expect(GO_MASK_REGIONS).toEqual({ slot: 1, rim: 2, face: 3, outside: 4 });

    const view = sp.batches[10]!.view;
    load(view, turnMenu(view));
    resetClassicAssetsForTest({ masks: { [GO_MASK_KEY]: m } });
    const { transport } = renderClassic();
    const box = screen.getByTestId('action-dice-count').style;
    expect([box.left, box.top, box.width, box.height]).toEqual(['367px', '409px', '16px', '48px']);
    const go = screen.getByTestId('action-roll');
    vi.spyOn(go, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 72,
      height: 67,
      right: 72,
      bottom: 67,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    fireEvent.click(go, { detail: 1, clientX: 1, clientY: 1 });
    fireEvent.click(go, { detail: 1, clientX: 12, clientY: 30 });
    expect(transport.payloads('game:act')).toHaveLength(0);
    fireEvent.click(go, { detail: 1, clientX: 45, clientY: 30 });
    expect(transport.payloads('game:act')).toHaveLength(1);
  });

  it('太阳 / 月亮钮与月历页图烘焙的图标重合（(10,9) 24×23、(42,11) 20×20）；月历列中心对齐页图上的星期圆圈', () => {
    load(sp.batches[10]!.view);
    resetClassicAssetsForTest({ sprites: { 'ui.calendar': fakeSheet('ui.calendar', 12) } });
    renderClassic();
    const box = (id: string) => {
      const st = screen.getByTestId(id).style;
      return [st.left, st.top, st.width, st.height];
    };
    expect(box('classic-cal-sun')).toEqual(['10px', '9px', '24px', '23px']);
    expect(box('classic-cal-moon')).toEqual(['42px', '11px', '20px', '20px']);
    expect(SUN_RECT).toEqual({ x: 10, y: 9, w: 24, h: 23 });
    expect(MOON_RECT).toEqual({ x: 42, y: 11, w: 20, h: 20 });
    // 月历模式：太阳为未选中帧（图9）、月亮为选中帧（图10），与页图上烘焙的相同
    expect(screen.getByTestId('classic-cal-sun').querySelector('[data-sprite]')).toHaveAttribute(
      'data-sprite',
      'ui.calendar/9',
    );
    expect(screen.getByTestId('classic-cal-moon').querySelector('[data-sprite]')).toHaveAttribute(
      'data-sprite',
      'ui.calendar/10',
    );
    const measured = [30.5, 53.5, 76.5, 98.5, 121.5, 144.5, 166.5];
    measured.forEach((cx, i) => {
      expect(Math.abs(MONTH_GRID.left + MONTH_GRID.colW * (i + 0.5) - cx)).toBeLessThan(0.7);
    });
    const table = screen.getByTestId('classic-month');
    expect(Number.parseFloat(table.style.left)).toBeCloseTo(MONTH_GRID.left, 3);
    expect(Number.parseFloat(table.style.width)).toBeCloseTo(MONTH_GRID.colW * 7, 3);
  });

  it('查询 / 道具 / 卡片 / 公佈欄 / 股市：对应面板打开时工具钮带 aria-pressed="true"', async () => {
    const view = sp.batches[10]!.view;
    load(view);
    renderClassic();
    const ids = ['action-info', 'action-items', 'action-cards', 'action-board', 'action-stock'] as const;
    for (const id of ids) expect(screen.getByTestId(id)).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(screen.getByTestId('action-info'));
    expect(screen.getByTestId('action-info')).toHaveAttribute('aria-pressed', 'true');
    for (const [id, panel] of [
      ['action-items', 'items'],
      ['action-cards', 'cards'],
      ['action-board', 'board'],
      ['action-stock', 'stock'],
    ] as const) {
      act(() => useUiStore.getState().openPanel(panel));
      expect(screen.getByTestId(id)).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByTestId('action-info')).toHaveAttribute('aria-pressed', 'false');
    }
    expect(screen.getByTestId('tool-help')).not.toHaveAttribute('aria-pressed');
  });

  it('座位条：紧凑状态徽章（chip-status-<seat>）与头顶气泡副本（bubble-<seat>）', () => {
    const base = sp.batches[10]!.view;
    const view: GameView = {
      ...base,
      players: base.players.map((p, i) => (i === 1 ? { ...p, st: { ...p.st, jail: 2 } } : p)),
    };
    load(view);
    renderClassic({ view });
    const seat = view.players[1]!.seat;
    expect(screen.getByTestId(`chip-status-${seat}`)).toBeInTheDocument();
    expect(screen.getByTestId(`chip-status-${seat}`).textContent).toContain('3');
    act(() =>
      useSocialStore.getState().showBubble({
        id: 'b1',
        seat: 2,
        kind: 'emote',
        glyph: '😄',
        durationMs: 2000,
        at: Date.now(),
      }),
    );
    expect(screen.getByTestId('bubble-2')).toHaveTextContent('😄');
  });

  it('抽屉模式：本人倒计时与等待条叠在棋盘视窗左上角（不重复出现在抽屉里）；整栏模式在左栏', () => {
    const view = sp.batches[10]!.view;
    load(view, turnMenu(view));
    const { unmount } = renderClassic({ size: { w: 1440, h: 900 } });
    expect(screen.getByTestId('classic-stage')).toHaveAttribute('data-rails', 'drawer');
    const status = screen.getByTestId('classic-stage-status');
    expect(within(status).getByTestId('classic-my-countdown')).toHaveAttribute('role', 'timer');
    expect(screen.getAllByTestId('classic-my-countdown')).toHaveLength(1);
    expect(within(screen.getByTestId('classic-rail-left')).queryByTestId('classic-my-countdown')).toBeNull();
    unmount();
    renderClassic({ size: { w: 1920, h: 1080 } });
    expect(screen.queryByTestId('classic-stage-status')).toBeNull();
    expect(within(screen.getByTestId('classic-rail-left')).getByTestId('classic-my-countdown')).toBeInTheDocument();
  });

  it('鼠标点过舞台钮后不留焦点：空格仍是「前进」；键盘触发的保留焦点', async () => {
    const view = sp.batches[10]!.view;
    load(view, turnMenu(view));
    const { transport } = renderClassic();
    const help = screen.getByTestId('tool-bigmap');
    help.focus();
    fireEvent.click(help, { detail: 1 });
    expect(document.activeElement).not.toBe(help);
    const tab = screen.getByTestId('classic-tab-stocks');
    tab.focus();
    fireEvent.click(tab, { detail: 1 });
    expect(document.activeElement).not.toBe(tab);
    fireEvent.keyDown(document.activeElement ?? window, { key: ' ' });
    expect(transport.payloads('game:act')).toHaveLength(1);
    // 键盘触发（detail 0）：焦点留在钮上
    tab.focus();
    fireEvent.click(tab, { detail: 0 });
    expect(document.activeElement).toBe(tab);
  });

  it('LOAD：对局中只列出存档并说明读档要在大厅进行（不放存档表单）；SAVE 照常可存', async () => {
    load(sp.batches[10]!.view);
    renderClassic();
    expect(screen.getByTestId('tool-load').getAttribute('title')).toContain('大厅');
    await userEvent.click(screen.getByTestId('tool-load'));
    expect(await screen.findByTestId('classic-load-note')).toBeInTheDocument();
    expect(screen.queryByTestId('save-name')).toBeNull();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('classic-saves')).toBeNull());
    await userEvent.click(screen.getByTestId('tool-save'));
    expect(await screen.findByTestId('save-name')).toBeInTheDocument();
    expect(screen.queryByTestId('classic-load-note')).toBeNull();
  });

  it('字体栈与原版主题同一份；舞台缩小时标记补触控热区；工具列画在棋盘之上的舞台层', () => {
    load(sp.batches[10]!.view);
    const { unmount } = renderClassic({ size: { w: 844, h: 390 } });
    expect(screen.getByTestId('screen-game').style.getPropertyValue('--classic-font')).toBe(ORIGINAL_FONT_STACK);
    const stage = screen.getByTestId('classic-stage');
    expect(stage).toHaveAttribute('data-hit', 'wide');
    expect(stage.style.getPropertyValue('--classic-scale')).toBe('0.8125');
    expect(within(screen.getByTestId('classic-stage-front')).getByTestId('classic-toolbar')).toBeInTheDocument();
    unmount();
    renderClassic({ size: { w: 1920, h: 1080 } });
    expect(screen.getByTestId('classic-stage')).toHaveAttribute('data-hit', 'normal');
  });
});
