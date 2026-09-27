// 原版决策层（client-dom）：注册表合并与冲突、宿主的回退判定（未登记 / 无素材包 / 缺键 / guess / 加载失败 / 超时 / 渲染出错）、
// BUY_LAND 原版场景（数值、提交的 intent、提交锁、现金不足、只读、Esc）、经典布局接入（portal 到舞台、决策层外壳、提交）。
import type { MapIndex } from '@rich4/shared/data';
import { DECISION_KINDS, type DecisionKind, type DecisionOptionsMap, type PlayerIntent } from '@rich4/shared/engine';
import type { YourDecision } from '@rich4/shared/net';
import type { GameView } from '@rich4/shared/view';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MotionGlobalConfig } from 'motion/react';
import { lazy, type ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientProvider } from '../../../app/services';
import type { PackClient } from '../../../skin/pack/PackClient';
import { resetSkinStoreForTest } from '../../../skin/skinStore';
import { useGameStore } from '../../../store/gameStore';
import { useUiStore } from '../../../store/uiStore';
import { makeTestClient } from '../../../test/fakeTransport';
import { ai, human, roomView } from '../../../test/roomFixtures';
import { DecisionClockProvider } from '../../decisions/clock';
import { makeDecision } from '../../decisions/devFixtures';
import { expectSingleIntent, fixture, installResizeObserver } from '../../decisions/testing';
import type { DecisionProps } from '../../decisions/types';
import { resetClassicAssetsForTest, useClassicAssets } from '../assets';
import { ClassicLayout } from '../ClassicLayout';
import {
  atlasPackClient,
  fakePackClient,
  fakeSceneFrames,
  fakeSceneSheets,
  installSceneAssets,
} from '../common/testing';
import { ClassicDecisionHost, type SceneGateState } from './ClassicDecisionHost';
import {
  CLASSIC_REGISTRY_CONFLICTS,
  classicDecisionRegistry,
  getClassicScene,
  mergeClassicRegistries,
  preloadClassicScenes,
} from './registry';
import { type ClassicDecisionRegistry, classicScene, resolveRequiredKeys, sceneLoader } from './scene';

vi.mock('../../screens/BoardCanvas', () => ({
  BoardCanvas: () => <div data-testid="board-host">board</div>,
}));

installResizeObserver();

const BUY_KEYS = ['ui.yesno', 'ui.common', 'portrait.speaker.9'];

beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true;
});
afterAll(() => {
  MotionGlobalConfig.skipAnimations = false;
});

beforeEach(() => {
  installSceneAssets({ sprites: fakeSceneSheets() });
});

afterEach(() => {
  useGameStore.getState().clear();
  useUiStore.getState().clear();
  resetClassicAssetsForTest();
  resetSkinStoreForTest();
});

interface HostOpts<K extends DecisionKind> {
  kind: K;
  options?: Partial<DecisionOptionsMap[K]>;
  isMine?: boolean;
  packId?: string | null;
  client?: PackClient | null;
  registry?: ClassicDecisionRegistry;
  prepareTimeoutMs?: number;
  seat?: 0 | 1 | 2 | 3;
}

function renderHost<K extends DecisionKind>(o: HostOpts<K>) {
  const fx = fixture();
  const submit = vi.fn<(intent: PlayerIntent) => unknown>(() => undefined);
  const now = () => Date.now();
  const decision = makeDecision(
    o.kind,
    { ...fx.options[o.kind], ...(o.options ?? {}) },
    { seat: o.seat ?? 0, now: now() },
  );
  const gates: [SceneGateState, string | null][] = [];
  const user = userEvent.setup();
  const utils = render(
    <ClassicDecisionHost
      decision={decision as DecisionProps['decision']}
      isMine={o.isMine ?? true}
      view={fx.view}
      map={fx.map}
      submit={submit}
      now={now}
      packId={o.packId === undefined ? 'test-pack' : o.packId}
      client={o.client === undefined ? fakePackClient(BUY_KEYS) : o.client}
      registry={o.registry}
      prepareTimeoutMs={o.prepareTimeoutMs}
      onGate={(s, r) => gates.push([s, r])}
    />,
  );
  return { ...utils, submit, user, gates, decision, fx };
}

describe('原版决策注册表', () => {
  it('三处合并没有冲突；BUY_LAND 已登记且能取到模块的 requiredKeys', async () => {
    expect(CLASSIC_REGISTRY_CONFLICTS).toEqual([]);
    const C = getClassicScene('BUY_LAND');
    expect(C).toBe(classicDecisionRegistry.BUY_LAND);
    expect(getClassicScene('NOT_A_KIND')).toBeNull();
    const loader = sceneLoader(C!)!;
    const mod = await loader.load();
    expect(loader.loaded).toBe(mod);
    const fx = fixture();
    const props = {
      decision: makeDecision('BUY_LAND', fx.options.BUY_LAND, { seat: 1 }),
      isMine: true,
      view: fx.view,
      map: fx.map,
      submit: () => undefined,
    } as unknown as DecisionProps;
    // 座位 1 的角色是 4
    expect(resolveRequiredKeys(mod, props)).toEqual(['ui.yesno', 'ui.common', 'portrait.speaker.4']);
    await expect(preloadClassicScenes()).resolves.toBeUndefined();
  });

  it('23 种决策全部登记了原版场景（没有回退到程序化对话框的种类）', () => {
    const missing = DECISION_KINDS.filter((k) => getClassicScene(k) === null);
    expect(missing).toEqual([]);
  });

  it('同一 kind 重复登记：记冲突、先登记的生效', () => {
    const A = classicScene(() => import('../dialogs/BuyLand'));
    const B = classicScene(() => import('../dialogs/BuyLand'));
    const r = mergeClassicRegistries([
      { name: 'dialogs', registry: { BUY_LAND: A } },
      { name: 'venues/a', registry: { BUY_LAND: B, BAIL: B } },
    ]);
    expect(r.registry.BUY_LAND).toBe(A);
    expect(r.registry.BAIL).toBe(B);
    expect(r.conflicts).toEqual(['BUY_LAND：dialogs 与 venues/a 重复登记']);
  });
});

describe('ClassicDecisionHost：回退判定', () => {
  it('未登记的 kind → 程序化对话框', async () => {
    // 23 种决策现在都有原版场景：用空注册表模拟「未登记」
    const r = renderHost({ kind: 'BAIL', registry: {} });
    const dlg = await screen.findByTestId('decision-BAIL');
    expect(dlg).not.toHaveAttribute('data-scene');
    expect(r.gates.at(-1)).toEqual(['fallback', 'unregistered']);
  });

  it('没有素材包（packId 或客户端为空）→ 程序化 BUY_LAND', async () => {
    const r = renderHost({ kind: 'BUY_LAND', packId: null });
    expect(await screen.findByTestId('buy-confirm')).toBeInTheDocument();
    expect(screen.getByTestId('decision-BUY_LAND')).not.toHaveAttribute('data-scene');
    expect(r.gates.at(-1)).toEqual(['fallback', 'no-pack']);
    r.unmount();
    const r2 = renderHost({ kind: 'BUY_LAND', client: null });
    expect(await screen.findByTestId('decision-BUY_LAND')).not.toHaveAttribute('data-scene');
    expect(r2.gates.at(-1)).toEqual(['fallback', 'no-pack']);
  });

  it('依赖的逻辑键有一个不可用（缺失、组缺失或置信度 guess 时 usableEntry 为 null）→ 整体回退', async () => {
    await sceneLoader(classicDecisionRegistry.BUY_LAND!)!.load();
    const client = fakePackClient(['ui.yesno', 'ui.common']);
    const r = renderHost({ kind: 'BUY_LAND', client });
    expect(await screen.findByTestId('decision-BUY_LAND')).not.toHaveAttribute('data-scene');
    expect(r.gates.at(-1)).toEqual(['fallback', 'keys']);
    expect(client.asked).toContain('portrait.speaker.9');
  });

  it('精灵加载失败（仓库里记为 null）→ 整体回退', async () => {
    installSceneAssets({ sprites: { ...fakeSceneSheets(), 'ui.yesno': null } });
    const r = renderHost({ kind: 'BUY_LAND' });
    expect(await screen.findByTestId('decision-BUY_LAND')).not.toHaveAttribute('data-scene');
    expect(r.gates.at(-1)).toEqual(['fallback', 'keys']);
  });

  it('全部可用 → 原版场景（模块已加载、精灵已在仓库时同步判定，不闪加载态）', async () => {
    await sceneLoader(classicDecisionRegistry.BUY_LAND!)!.load();
    const r = renderHost({ kind: 'BUY_LAND' });
    expect(screen.queryByTestId('classic-scene-pending')).toBeNull();
    const scene = screen.getByTestId('decision-BUY_LAND');
    expect(scene).toHaveAttribute('data-scene', 'classic');
    expect(r.gates.at(-1)).toEqual(['classic', null]);
  });

  it('精灵不在仓库：先显示准备中，按需载入图集后换成原版场景', async () => {
    installSceneAssets({ sprites: {} });
    let open!: () => void;
    const gate = new Promise<void>((res) => {
      open = res;
    });
    const client = atlasPackClient(fakeSceneFrames(), { gate });
    const r = renderHost({ kind: 'BUY_LAND', client });
    expect(screen.getByTestId('classic-scene-pending')).toBeInTheDocument();
    await act(async () => open());
    expect(await screen.findByTestId('decision-BUY_LAND')).toHaveAttribute('data-scene', 'classic');
    expect(client.loads.sort()).toEqual(['portrait.speaker.9.json', 'ui.common.json', 'ui.yesno.json']);
    expect(useClassicAssets.getState().sprites['ui.yesno']?.frames).toHaveLength(3);
    expect(r.gates.at(-1)).toEqual(['classic', null]);
  });

  it('准备超时 → 整体回退（之后素材到了也不在同一个决策里切换）', async () => {
    installSceneAssets({ sprites: {} });
    const client = atlasPackClient(fakeSceneFrames(), { gate: new Promise<void>(() => {}) });
    const r = renderHost({ kind: 'BUY_LAND', client, prepareTimeoutMs: 30 });
    expect(await screen.findByTestId('buy-confirm')).toBeInTheDocument();
    expect(screen.getByTestId('decision-BUY_LAND')).not.toHaveAttribute('data-scene');
    expect(r.gates.at(-1)).toEqual(['fallback', 'timeout']);
    act(() => useClassicAssets.setState({ sprites: fakeSceneSheets() }));
    expect(screen.getByTestId('decision-BUY_LAND')).not.toHaveAttribute('data-scene');
  });

  it('原版场景渲染出错 → 回退程序化对话框', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const Broken = classicScene(async () => ({
      default: (): ReactNode => {
        throw new Error('boom');
      },
      requiredKeys: ['ui.yesno'],
    }));
    await sceneLoader(Broken)!.load();
    renderHost({ kind: 'BUY_LAND', registry: { BUY_LAND: Broken } });
    expect(await screen.findByTestId('buy-confirm')).toBeInTheDocument();
    expect(screen.getByTestId('decision-BUY_LAND')).not.toHaveAttribute('data-scene');
    spy.mockRestore();
  });

  it('直接用 lazy() 登记的组件：不查素材键，只要求有素材包', async () => {
    const Plain = lazy(async () => ({
      default: (p: DecisionProps): ReactNode => <p data-testid="plain-scene">{p.decision.kind}</p>,
    }));
    renderHost({ kind: 'BAIL', registry: { BAIL: Plain as never } });
    expect(await screen.findByTestId('plain-scene')).toHaveTextContent('BAIL');
  });
});

describe('BUY_LAND 原版场景', () => {
  beforeEach(async () => {
    await sceneLoader(classicDecisionRegistry.BUY_LAND!)!.load();
  });

  it('讲话头像（本人角色）+ 云形气泡 + 消息框数值；YES → CONFIRM，连点只提交一次并锁定', async () => {
    const r = renderHost({ kind: 'BUY_LAND' });
    const scene = screen.getByTestId('decision-BUY_LAND');
    expect(scene).toHaveAttribute('data-kind', 'BUY_LAND');
    expect(scene).toHaveAttribute('data-character', '9');
    expect(scene.querySelector('[data-sprite="portrait.speaker.9/0"]')).not.toBeNull();
    expect(scene.querySelector('[data-sprite="ui.common/6"]')).not.toBeNull();
    expect(scene.querySelector('[data-sprite="ui.yesno/0"]')).not.toBeNull();
    expect(screen.getByTestId('buy-price')).toHaveAttribute('data-value', '2000');
    expect(screen.getByTestId('buy-price')).toHaveTextContent('2,000');
    expect(screen.getByTestId('buy-cash-after')).toHaveAttribute('data-value', '46800');
    expect(screen.getByTestId('buy-toll-after')).toHaveAttribute('data-value', '400');
    expect(within(screen.getByTestId('buy-street')).getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByTestId('classic-buy-speaker-text')).toHaveTextContent('购买土地');
    expect(within(scene).getByRole('timer')).toBeInTheDocument();
    // 倒计时圆环在棋盘视窗右上角（场景只占棋盘视窗时不压资料栏）
    const ring = screen.getByTestId('decision-BUY_LAND-ring');
    expect([ring.style.left, ring.style.top]).toEqual(['402px', '46px']);
    const yes = screen.getByRole('button', { name: '购买' });
    expect(yes).toBe(screen.getByTestId('buy-confirm'));
    await r.user.dblClick(yes);
    await r.user.click(yes);
    expectSingleIntent(r.submit, { type: 'CONFIRM' });
    expect(scene).toHaveAttribute('data-locked', 'true');
    expect(screen.getByTestId('decision-BUY_LAND-status')).toHaveTextContent('已提交');
    expect(screen.getByTestId('buy-decline')).toBeDisabled();
  });

  it('NO → DECLINE；Esc 同样是 DECLINE', async () => {
    const r = renderHost({ kind: 'BUY_LAND' });
    await r.user.click(screen.getByTestId('buy-decline'));
    expectSingleIntent(r.submit, { type: 'DECLINE' });
    r.unmount();
    const r2 = renderHost({ kind: 'BUY_LAND' });
    expect(document.activeElement).toBe(screen.getByTestId('decision-BUY_LAND'));
    await r2.user.keyboard('{Escape}');
    expectSingleIntent(r2.submit, { type: 'DECLINE' });
  });

  it('Y / N 键', async () => {
    const r = renderHost({ kind: 'BUY_LAND' });
    await r.user.keyboard('n');
    expectSingleIntent(r.submit, { type: 'DECLINE' });
  });

  it('回归：场景弹出时焦点在聊天框里——不抢焦点，接着打的 y / n / Esc 进聊天框，不提交决定', async () => {
    const chat = render(<input aria-label="聊天" data-testid="chat-input" />);
    const input = chat.getByTestId('chat-input') as HTMLInputElement;
    const user = userEvent.setup();
    await user.click(input);
    await user.keyboard('hello ');
    const r = renderHost({ kind: 'BUY_LAND' });
    const scene = await screen.findByTestId('decision-BUY_LAND');
    expect(scene).toHaveAttribute('data-state', 'open');
    expect(document.activeElement).toBe(input);
    await user.keyboard('you{Escape}n');
    expect(r.submit).not.toHaveBeenCalled();
    expect(input.value).toBe('hello youn');
    // 焦点离开输入框落到 body 上：Y / N 仍不认（只认场景里的按键）；点进场景后照常可用
    act(() => input.blur());
    fireEvent.keyDown(document.body, { key: 'y' });
    expect(r.submit).not.toHaveBeenCalled();
    act(() => scene.focus());
    await user.keyboard('y');
    expectSingleIntent(r.submit, { type: 'CONFIRM' });
  });

  it('现金不足：YES 禁用（灰罩、Y 键无效），提示现金不足，只能 NO', async () => {
    const r = renderHost({ kind: 'BUY_LAND', options: { price: 90000 } });
    expect(screen.getByTestId('buy-confirm')).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('现金不足');
    await r.user.keyboard('y');
    expect(r.submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('buy-confirm'));
    expect(r.submit).not.toHaveBeenCalled();
    await r.user.click(screen.getByTestId('buy-decline'));
    expectSingleIntent(r.submit, { type: 'DECLINE' });
  });

  it('只读（托管中）：显示「等待 X 做决定…」，控件禁用，不抢焦点', async () => {
    const r = renderHost({ kind: 'BUY_LAND', isMine: false });
    const scene = screen.getByTestId('decision-BUY_LAND');
    expect(scene).toHaveAttribute('data-readonly', 'true');
    expect(screen.getByTestId('decision-BUY_LAND-status')).toHaveTextContent(/^等待 .+ 做决定…$/);
    expect(screen.getByTestId('buy-confirm')).toBeDisabled();
    expect(document.activeElement).not.toBe(scene);
    await r.user.keyboard('{Escape}');
    expect(r.submit).not.toHaveBeenCalled();
  });
});

describe('经典布局接入', () => {
  // 这一组走真实的进出场动画（AnimatePresence 退场后移除）
  beforeEach(() => {
    MotionGlobalConfig.skipAnimations = false;
  });
  afterEach(() => {
    MotionGlobalConfig.skipAnimations = true;
  });

  const room = roomView({
    phase: 'playing',
    epoch: 1,
    seats: [human(0, '我', { isYou: true, host: true }), ai(1), human(2, '小红'), ai(3)],
  });

  function renderLayout(view: GameView, map: MapIndex, packId: string | null) {
    const t = makeTestClient();
    const utils = render(
      <ClientProvider client={t.client}>
        <DecisionClockProvider offsetMs={0}>
          <ClassicLayout
            room={room}
            view={view}
            map={map}
            board={<div data-testid="board-host">board</div>}
            surface={null}
            rotation={0}
            onRotate={() => {}}
            onFocusMe={() => {}}
            onPan={() => {}}
            viewport={() => null}
            onOpenMenu={() => {}}
            onLeave={() => {}}
            packId={packId}
            size={{ w: 1920, h: 1080 }}
          />
        </DecisionClockProvider>
      </ClientProvider>,
    );
    return { ...utils, ...t };
  }

  function buyDecision(): YourDecision {
    const fx = fixture();
    return {
      ...makeDecision('BUY_LAND', fx.options.BUY_LAND, { seat: 0, id: 'd-buy-1' }),
      deadlineAt: null,
    } as unknown as YourDecision;
  }

  it('有素材包：BUY_LAND 原版场景经 portal 挂在舞台上（与舞台同倍率），决策层外壳留在棋盘叠层；点 YES 发 CONFIRM', async () => {
    const fx = fixture();
    resetSkinStoreForTest({ client: atlasPackClient(fakeSceneFrames()) });
    act(() =>
      useGameStore.getState().resetTo({ epoch: 1, seq: 5, view: fx.view, pending: [], decision: buyDecision() }),
    );
    const { transport } = renderLayout(fx.view, fx.map, 'test-pack');
    const layer = screen.getByTestId('decision-layer');
    expect(layer).toHaveAttribute('data-kind', 'BUY_LAND');
    expect(within(screen.getByTestId('classic-board-overlay')).getByTestId('decision-layer')).toBe(layer);
    const scene = await screen.findByTestId('decision-BUY_LAND');
    expect(scene).toHaveAttribute('data-scene', 'classic');
    expect(scene.parentElement).toBe(screen.getByTestId('classic-stage'));
    expect(scene.style.transform).toBe('scale(2.25)');
    await userEvent.click(screen.getByTestId('buy-confirm'));
    expect(transport.payloads('game:act')[0]).toMatchObject({ decisionId: 'd-buy-1', intent: { type: 'CONFIRM' } });
    // 决策换掉（下一批开始）：外壳立即不再算决策层（退场中改名、不可操作），场景播完退场后移除
    act(() => useGameStore.getState().beginBatch());
    expect(screen.queryByTestId('decision-layer')).toBeNull();
    await waitFor(() => expect(screen.queryByTestId('decision-BUY_LAND-exit')).toBeNull());
    expect(screen.queryByTestId('decision-BUY_LAND')).toBeNull();
    expect(screen.queryByTestId('decision-layer-exit')).toBeNull();
  });

  it('没有素材包：同一决策用程序化对话框（叠在棋盘视窗上）', async () => {
    const fx = fixture();
    act(() =>
      useGameStore.getState().resetTo({ epoch: 1, seq: 5, view: fx.view, pending: [], decision: buyDecision() }),
    );
    renderLayout(fx.view, fx.map, null);
    const dlg = await screen.findByTestId('decision-BUY_LAND');
    expect(dlg).not.toHaveAttribute('data-scene');
    expect(within(screen.getByTestId('decision-layer')).getByTestId('decision-BUY_LAND')).toBe(dlg);
  });
});
