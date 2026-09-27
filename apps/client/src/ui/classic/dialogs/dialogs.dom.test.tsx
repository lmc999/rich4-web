// 原版通用对话框 × 真实引擎（client-dom，original-skin.md §5 A11「每种决策在原版皮肤下 dom 测试」）：用引擎场景 DSL 走到真实的
// 决策，按座位视角投影出 view，经 ClassicDecisionHost（原版注册表、假素材包、同尺寸同锚点的假精灵）渲染原版场景，
// 断言确实是原版场景（data-scene="classic"），按界面操作得到 intent，再交给引擎执行，断言被接受且效果正确。
// 覆盖 BUY_FACILITY / BUILD_FACILITY / UPGRADE_FACILITY / UPGRADE_LAND / FACILITY_TYPE / RESEARCH / SUBSCRIBE_SHARES /
// CONSTRUCTION_PICK / USE_FREE_CARD / SCAPEGOAT / DEATH_GOD_TARGET / DISCARD_CARD / BIRTHDAY_PICK / MINIGAME，
// 以及 TURN_MENU 的卡片欄（26 张可用卡、12 种道具经 TargetPanel 选第一个候选）、投降、股市子页。
import {
  buildFixtureMaps,
  createRegistry,
  type DataRegistry,
  fixtureRegistry,
  type MapIndex,
  TABLES,
} from '@rich4/shared/data';
import {
  CARD_KEYS,
  type CardId,
  type DecisionKind,
  type GameEvent,
  ITEM_IDS,
  type ItemId,
  type PlayerIntent,
  type SeatIndex,
} from '@rich4/shared/engine';
import { decisionForSeat, type Scenario, scenario } from '@rich4/shared/engine-testing';
import { type DecisionForYou, projectState } from '@rich4/shared/view';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MotionGlobalConfig } from 'motion/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSkinStoreForTest } from '../../../skin/skinStore';
import { useGameStore } from '../../../store/gameStore';
import { makeDecision } from '../../decisions/devFixtures';
import { fixture, installResizeObserver, intents } from '../../decisions/testing';
import { TurnMenuSheetContext, type TurnMenuSheetControl } from '../../decisions/turnMenuSheet';
import type { DecisionProps } from '../../decisions/types';
import { resetClassicAssetsForTest } from '../assets';
import { installSceneAssets } from '../common/testing';
import { ClassicDecisionHost, type SceneGateState } from '../decisions/ClassicDecisionHost';
import { wheelFrameAt } from '../popups/Roulette';
import { classicDialogs } from '.';
import { a11FakeSheets, a11PackClient } from './testing';

installResizeObserver();

beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true;
});
afterAll(() => {
  MotionGlobalConfig.skipAnimations = false;
});
beforeEach(() => {
  installSceneAssets({ sprites: a11FakeSheets() });
});
afterEach(() => {
  cleanup();
  useGameStore.getState().clear();
  resetClassicAssetsForTest();
  resetSkinStoreForTest();
});

const MAP = 'test';

function youOf(sc: Scenario, seat: SeatIndex): DecisionForYou {
  return { ...decisionForSeat(sc.pending(seat)), deadlineAt: null } as DecisionForYou;
}

interface Mounted {
  submit: ReturnType<typeof vi.fn<(intent: PlayerIntent) => unknown>>;
  user: ReturnType<typeof userEvent.setup>;
  root: HTMLElement;
  gates: [SceneGateState, string | null][];
}

/** 渲染 seat 当前的真实决策（原版宿主），等原版场景出现 */
async function mount(
  sc: Scenario,
  seat: SeatIndex,
  kind: DecisionKind,
  o: { registry?: DataRegistry; sheet?: TurnMenuSheetControl | null } = {},
): Promise<Mounted> {
  sc.expectAsk(seat, kind);
  const submit = vi.fn<(intent: PlayerIntent) => unknown>(() => undefined);
  const user = userEvent.setup();
  const gates: [SceneGateState, string | null][] = [];
  const map: MapIndex = (o.registry ?? fixtureRegistry).getMap(sc.state.dataRef.mapId);
  const host = (
    <ClassicDecisionHost
      decision={youOf(sc, seat)}
      isMine
      view={projectState(sc.state, { kind: 'seat', seat }, { handVisibility: 'public' })}
      map={map}
      submit={submit}
      packId="test-pack"
      client={a11PackClient()}
      onGate={(s, r) => gates.push([s, r])}
    />
  );
  render(
    o.sheet === undefined ? (
      host
    ) : (
      <TurnMenuSheetContext.Provider value={o.sheet}>{host}</TurnMenuSheetContext.Provider>
    ),
  );
  const root = await screen.findByTestId(`decision-${kind}`, undefined, { timeout: 8000 });
  expect(root, `${kind} 应为原版场景（判定：${JSON.stringify(gates)}）`).toHaveAttribute('data-scene', 'classic');
  return { submit, user, root, gates };
}

function lastIntent(m: Mounted): PlayerIntent {
  const last = intents(m.submit).at(-1);
  if (!last) throw new Error('scene submitted nothing');
  return last;
}

function commit(sc: Scenario, seat: SeatIndex, m: Mounted): PlayerIntent {
  const intent = lastIntent(m);
  sc.act(seat, intent);
  return intent;
}

describe('原版通用对话框：注册表', { timeout: 30_000 }, () => {
  it('A11 负责的 16 种决策都已登记', () => {
    expect(Object.keys(classicDialogs).sort()).toEqual(
      [
        'TURN_MENU',
        'BUY_LAND',
        'BUY_FACILITY',
        'UPGRADE_LAND',
        'UPGRADE_FACILITY',
        'BUILD_FACILITY',
        'FACILITY_TYPE',
        'RESEARCH',
        'USE_FREE_CARD',
        'SCAPEGOAT',
        'DEATH_GOD_TARGET',
        'DISCARD_CARD',
        'BIRTHDAY_PICK',
        'SUBSCRIBE_SHARES',
        'CONSTRUCTION_PICK',
        'MINIGAME',
      ].sort(),
    );
  });

  it('缺一个素材键（道具欄）整体回退程序化回合菜单', async () => {
    const sc = scenario({ players: ['human', 'human'], map: MAP }).untilMenu(0);
    const keys = Object.keys(a11FakeSheets()).filter((k) => k !== 'ui.itemBar');
    const submit = vi.fn(() => undefined);
    render(
      <ClassicDecisionHost
        decision={youOf(sc, 0)}
        isMine
        view={projectState(sc.state, { kind: 'seat', seat: 0 }, { handVisibility: 'public' })}
        map={fixtureRegistry.getMap(MAP)}
        submit={submit}
        packId="test-pack"
        client={a11PackClient(keys)}
      />,
    );
    const root = await screen.findByTestId('decision-TURN_MENU', undefined, { timeout: 8000 });
    expect(root).not.toHaveAttribute('data-scene');
    expect(screen.getByTestId('turn-roll')).toBeInTheDocument();
  });
});

describe('原版 YES/NO 类场景 × 真实引擎', { timeout: 30_000 }, () => {
  it('BUY_FACILITY → BUILD_FACILITY（旅馆）→ UPGRADE_FACILITY：三次停在 F1', async () => {
    const sc = scenario({ players: ['human', 'human'], map: MAP }).untilMenu(0);
    sc.teleport(0, 16, 15).force('dice', 1).roll(0);
    const buy = await mount(sc, 0, 'BUY_FACILITY');
    expect(within(buy.root).getByTestId('buy-price')).toHaveAttribute('data-value', '4000');
    expect(within(buy.root).getByTestId('classic-buy-speaker')).toBeInTheDocument();
    await buy.user.click(within(buy.root).getByTestId('buy-confirm'));
    expect(commit(sc, 0, buy)).toEqual({ type: 'CONFIRM' });
    cleanup();

    sc.untilMenu(0).teleport(0, 16, 15).force('dice', 1).roll(0);
    const build = await mount(sc, 0, 'BUILD_FACILITY');
    expect(within(build.root).getByTestId('facility-cost')).toHaveAttribute('data-value', '4000');
    expect(within(build.root).getByTestId('facility-confirm')).toBeDisabled();
    await build.user.click(within(build.root).getByTestId('facility-type-hotel'));
    expect(build.root).toHaveAttribute('data-pick', 'hotel');
    await build.user.click(within(build.root).getByTestId('facility-confirm'));
    expect(commit(sc, 0, build)).toEqual({ type: 'BUILD_FACILITY', facility: 'hotel' });
    expect(sc.state.facilities[0]).toMatchObject({ level: 1, type: 'hotel', owner: 0 });
    cleanup();

    sc.untilMenu(0).teleport(0, 16, 15).force('dice', 1).roll(0);
    const up = await mount(sc, 0, 'UPGRADE_FACILITY');
    expect(within(up.root).getByTestId('upgrade-cost')).toHaveAttribute('data-value', '800');
    expect(within(up.root).getByTestId('upgrade-levels')).toHaveAttribute('data-to', '2');
    await up.user.click(within(up.root).getByTestId('upgrade-confirm'));
    expect(commit(sc, 0, up)).toEqual({ type: 'CONFIRM' });
    expect(sc.state.facilities[0]!.level).toBe(2);
  });

  it('UPGRADE_LAND：两次停在 L1，第二次加盖（过路费前后）；NO / Esc → DECLINE', async () => {
    const sc = scenario({ players: ['human', 'human'], map: MAP }).untilMenu(0);
    sc.teleport(0, 4, 3).force('dice', 1).roll(0).expectAsk(0, 'BUY_LAND').confirm(0);
    sc.untilMenu(0).teleport(0, 4, 3).force('dice', 1).roll(0);
    const up = await mount(sc, 0, 'UPGRADE_LAND');
    expect(within(up.root).getByTestId('upgrade-toll')).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(lastIntent(up)).toEqual({ type: 'DECLINE' });
    cleanup();
    // 再来一次：YES
    const again = await mount(sc, 0, 'UPGRADE_LAND');
    const to = (sc.pending(0).options as { toLevel: number }).toLevel;
    await again.user.click(within(again.root).getByTestId('upgrade-confirm'));
    expect(commit(sc, 0, again)).toEqual({ type: 'CONFIRM' });
    expect(sc.state.lands.find((l) => l.id === 'L1')?.level).toBe(to);
  });

  it('FACILITY_TYPE（福神买下 0 级设施 → 免费首建）：只有 YES，选购物中心 → CHOOSE_FACILITY_TYPE', async () => {
    const sc = scenario({ players: ['human', 'human'], map: MAP })
      .untilMenu(0)
      .edit((s) => {
        s.players[0]!.god = { kind: 3, days: 7 };
        s.gods.find((g) => g.kind === 3)!.where = { t: 'attached', seat: 0 };
      });
    sc.teleport(0, 16, 15).force('dice', 1).roll(0).expectAsk(0, 'BUY_FACILITY').confirm(0);
    const m = await mount(sc, 0, 'FACILITY_TYPE');
    expect(within(m.root).queryByTestId('facility-decline')).toBeNull();
    await m.user.click(within(m.root).getByTestId('facility-type-mall'));
    await m.user.click(within(m.root).getByTestId('facility-confirm'));
    expect(commit(sc, 0, m)).toEqual({ type: 'CHOOSE_FACILITY_TYPE', facility: 'mall' });
    expect(sc.state.facilities[0]).toMatchObject({ owner: 0, level: 1, type: 'mall' });
  });

  it('RESEARCH：自己的 2 级研究所，项目 3 以上禁用，选项目 2 → RESEARCH{project:2}', async () => {
    const sc = scenario({ players: ['human', 'human'], map: MAP })
      .untilMenu(0)
      .edit((s) => {
        Object.assign(s.facilities[0]!, { owner: 0, level: 2, type: 'lab' });
      });
    sc.teleport(0, 16, 15).force('dice', 1).roll(0).expectAsk(0, 'UPGRADE_FACILITY').decline(0);
    const m = await mount(sc, 0, 'RESEARCH');
    expect(within(m.root).getByTestId('research-3')).toBeDisabled();
    expect(within(m.root).getByTestId('research-confirm')).toBeDisabled();
    await m.user.click(within(m.root).getByTestId('research-2'));
    await m.user.click(within(m.root).getByTestId('research-confirm'));
    expect(commit(sc, 0, m)).toEqual({ type: 'RESEARCH', project: 2 });
    expect(sc.event('RESEARCH_STARTED')).toMatchObject({ seat: 0, project: 2 });
  });

  it('SUBSCRIBE_SHARES：计算器输入股数（液晶屏输入框 / MAX），合计 = 单价 × 股数，SUBSCRIBE 被接受', async () => {
    const sc = scenario({ map: 'test-allkinds', players: ['human', 'human', 'human'] }).untilMenu(0);
    sc.teleport(0, 23, 22).force('dice', 1).roll(0);
    const m = await mount(sc, 0, 'SUBSCRIBE_SHARES');
    const o = sc.pending(0).options as { unitPrice: number; max: number; cash: number };
    const input = within(m.root).getByTestId('subscribe-shares-input');
    await m.user.clear(input);
    await m.user.type(input, '50');
    expect(m.root).toHaveAttribute('data-shares', '50');
    expect(within(m.root).getByTestId('subscribe-total')).toHaveAttribute('data-value', String(o.unitPrice * 50));
    await m.user.click(within(m.root).getByTestId('subscribe-confirm'));
    expect(commit(sc, 0, m)).toEqual({ type: 'SUBSCRIBE', shares: 50 });
    expect(sc.player(0).holdings[1]?.shares).toBe(50);
    expect(sc.player(0).cash).toBe(100000 - o.unitPrice * 50);
  });

  it('回归：SUBSCRIBE_SHARES 计算器清到 0 → 液晶屏、消息框都是 0，YES 与 ↵ 不可按（不会认购 1 股）；再按 7 → 认购 7 股', async () => {
    const sc = scenario({ map: 'test-allkinds', players: ['human', 'human', 'human'] }).untilMenu(0);
    sc.teleport(0, 23, 22).force('dice', 1).roll(0);
    const m = await mount(sc, 0, 'SUBSCRIBE_SHARES');
    await m.user.click(within(m.root).getByTestId('subscribe-shares-key-clear'));
    expect(within(m.root).getByTestId('subscribe-shares')).toHaveAttribute('data-value', '0');
    expect(m.root).toHaveAttribute('data-shares', '0');
    expect(within(m.root).getByTestId('subscribe-total')).toHaveAttribute('data-value', '0');
    expect(within(m.root).getByTestId('subscribe-confirm')).toBeDisabled();
    expect(within(m.root).getByTestId('subscribe-shares-key-enter')).toBeDisabled();
    fireEvent.click(within(m.root).getByTestId('subscribe-confirm'));
    expect(intents(m.submit)).toEqual([]);
    await m.user.click(within(m.root).getByTestId('subscribe-shares-key-7'));
    expect(within(m.root).getByTestId('subscribe-shares')).toHaveAttribute('data-value', '7');
    await m.user.click(within(m.root).getByTestId('subscribe-confirm'));
    expect(commit(sc, 0, m)).toEqual({ type: 'SUBSCRIBE', shares: 7 });
  });

  it('CONSTRUCTION_PICK（建设公司）：候选列表选 L1 → PICK_LOT；不能跳过时只有 YES', async () => {
    const maps = buildFixtureMaps();
    const c3 = maps.find((m) => m.id === 'test-allkinds')!.companies.find((c) => c.id === 'C3')!;
    c3.industry = 11;
    c3.industryKey = 'construction';
    const registry = createRegistry(maps, { tables: TABLES, verifyHash: false });
    const sc = scenario({ map: 'test-allkinds', registry, players: ['human', 'human'], config: { vehicle: 'walk' } })
      .untilMenu(0)
      .edit((s) => {
        s.players[1]!.holdings[1] = { shares: 100, costCents: 500000 };
        s.stocks[1]!.float -= 100;
        s.stocks[1]!.chairman = 1;
        s.lands[0]!.owner = 0;
        s.lands[0]!.level = 1;
      });
    sc.teleport(0, 23, 22).force('dice', 1).roll(0);
    const m = await mount(sc, 0, 'CONSTRUCTION_PICK', { registry });
    expect(within(m.root).queryByTestId('construction-skip')).toBeNull();
    expect(within(m.root).getByTestId('construction-confirm')).toBeDisabled();
    await m.user.click(within(m.root).getByTestId('construction-L1'));
    await m.user.click(within(m.root).getByTestId('construction-confirm'));
    expect(commit(sc, 0, m)).toEqual({ type: 'PICK_LOT', lot: 'L1' });
    expect(sc.event('LOT_LEVEL')).toMatchObject({ lot: 'L1', from: 1, to: 2 });
  });
});

describe('原版被动卡、选人、弃牌 × 真实引擎', { timeout: 30_000 }, () => {
  it('USE_FREE_CARD：查税找上门 → YES（使用免费卡）→ CONFIRM，免查', async () => {
    const sc = scenario({ players: ['human', 'human', 'human'], map: MAP }).untilMenu(0);
    sc.teleport(0, 5, 4).teleport(1, 6, 5).teleport(2, 12, 11);
    sc.give(0, { cards: [26] }).give(1, { cards: [20] });
    const cash1 = sc.player(1).cash;
    sc.useCard(0, 26, { t: 'seat', seat: 1 });
    const m = await mount(sc, 1, 'USE_FREE_CARD');
    expect(within(m.root).getByTestId('free-text').textContent).not.toBe('');
    await m.user.click(within(m.root).getByTestId('free-confirm'));
    expect(commit(sc, 1, m)).toEqual({ type: 'CONFIRM' });
    expect(sc.player(1).cash).toBe(cash1);
  });

  it('SCAPEGOAT：被陷害 → 选择玩家窗点一名替罪者（选中前 YES 禁用）→ SCAPEGOAT{target}', async () => {
    const sc = scenario({ players: ['human', 'human', 'human'], map: MAP }).untilMenu(0);
    sc.teleport(0, 5, 4).teleport(1, 6, 5).teleport(2, 12, 11);
    sc.give(0, { cards: [17] }).give(1, { cards: [19] });
    sc.useCard(0, 17, { t: 'actor', actor: { t: 'seat', seat: 1 } });
    const m = await mount(sc, 1, 'SCAPEGOAT');
    const candidates = (sc.pending(1).options as { candidates: SeatIndex[] }).candidates;
    const target = candidates[0]!;
    expect(within(m.root).getByTestId('scapegoat-confirm')).toBeDisabled();
    expect(within(m.root).getByTestId('classic-picker')).toBeInTheDocument();
    await m.user.click(within(m.root).getByTestId(`scapegoat-seat-${target}`));
    expect(within(m.root).getByTestId(`scapegoat-seat-${target}`)).toHaveAttribute('aria-pressed', 'true');
    await m.user.click(within(m.root).getByTestId('scapegoat-confirm'));
    expect(commit(sc, 1, m)).toEqual({ type: 'SCAPEGOAT', target });
    expect(sc.player(1).st.jail).toBe(0);
  });

  it('DEATH_GOD_TARGET：投降后在选择玩家窗里指定 3 号 → 死神附身', async () => {
    const sc = scenario({ players: ['human', 'human', 'ai', 'human'], map: MAP }).untilMenu(0);
    sc.act(0, { type: 'SURRENDER' });
    const m = await mount(sc, 0, 'DEATH_GOD_TARGET');
    expect(within(m.root).queryByTestId('deathgod-seat-0')).toBeNull();
    await m.user.click(within(m.root).getByTestId('deathgod-seat-3'));
    await m.user.click(within(m.root).getByTestId('deathgod-confirm'));
    expect(commit(sc, 0, m)).toEqual({ type: 'DEATH_GOD_TARGET', target: 3 });
    expect(sc.event('GOD_ATTACHED')).toMatchObject({ seat: 3, kind: 15 });
  });

  it('DISCARD_CARD：满手（16 张）在卡片欄里选一张弃掉；第 16 张在欄外另列', async () => {
    const full: CardId[] = [1, 2, 9, 10, 11, 13, 15, 16, 17, 22, 23, 24, 25, 26, 29];
    const sc = scenario({ players: ['human', 'human'], map: MAP, rules: { handFull: 'choose' } }).untilMenu(0);
    sc.give(0, { cards: full }).teleport(0, 3, 2).force('deck', 20).force('dice', 1).roll(0);
    const m = await mount(sc, 0, 'DISCARD_CARD');
    expect(within(m.root).getByTestId('discard-incoming')).toHaveTextContent('免费卡');
    expect(within(m.root).getAllByTestId(/^discard-\d+$/)).toHaveLength(16);
    expect(within(m.root).getByTestId('discard-confirm')).toBeDisabled();
    await m.user.click(within(m.root).getByTestId('discard-15'));
    expect(within(m.root).getByTestId('discard-15')).toHaveAttribute('aria-pressed', 'true');
    await m.user.click(within(m.root).getByTestId('discard-0'));
    await m.user.click(within(m.root).getByTestId('discard-confirm'));
    expect(commit(sc, 0, m)).toEqual({ type: 'DISCARD', slot: 0 });
    expect(sc.player(0).cards).toHaveLength(15);
  });

  it('BIRTHDAY_PICK：切换对手、每人挑一张（预选第一张）→ PICK_CARDS', async () => {
    const sc = scenario({ map: 'test-allkinds', players: ['human', 'human', 'human'] }).untilMenu(0);
    sc.teleport(1, 6, 5).teleport(2, 12, 11);
    sc.give(1, { cards: [13, 14] }).give(2, { cards: [15] });
    sc.stackDeck('fate', [5]).teleport(0, 2, 1).force('dice', 1).roll(0, 1);
    const m = await mount(sc, 0, 'BIRTHDAY_PICK');
    expect(within(m.root).getByTestId('birthday-1-0')).toHaveAttribute('aria-pressed', 'true');
    await m.user.click(within(m.root).getByTestId('birthday-1-1'));
    await m.user.click(within(m.root).getByTestId('birthday-victim-2'));
    expect(m.root).toHaveAttribute('data-active', '2');
    expect(within(m.root).getByTestId('birthday-2-0')).toHaveAttribute('aria-pressed', 'true');
    await m.user.click(within(m.root).getByTestId('birthday-confirm'));
    expect(commit(sc, 0, m)).toEqual({
      type: 'PICK_CARDS',
      picks: [
        { from: 1, slot: 1 },
        { from: 2, slot: 0 },
      ],
    });
    expect(sc.player(0).cards).toEqual(expect.arrayContaining([14, 15]));
  });
});

describe('原版小游戏开场', { timeout: 30_000 }, () => {
  it('MINIGAME：讲话头像 + 玩法说明；NO（不玩了）→ MINIGAME_DECLINE', async () => {
    const fx = fixture();
    const submit = vi.fn<(intent: PlayerIntent) => unknown>(() => undefined);
    const now = Date.now();
    const decision = makeDecision('MINIGAME', fx.options.MINIGAME, { seat: 0, now, timeoutMs: 30_000 });
    render(
      <ClassicDecisionHost
        decision={decision as DecisionProps['decision']}
        isMine
        view={fx.view}
        map={fx.map}
        submit={submit}
        packId="test-pack"
        client={a11PackClient()}
      />,
    );
    const root = await screen.findByTestId('decision-MINIGAME', undefined, { timeout: 8000 });
    expect(root).toHaveAttribute('data-scene', 'classic');
    expect(within(root).getByTestId('classic-minigame-speaker')).toBeInTheDocument();
    await userEvent.click(within(root).getByTestId('minigame-decline'));
    expect(intents(submit)).toEqual([{ type: 'MINIGAME_DECLINE' }]);
  });
});

// ───────────────────────── 回合菜单（卡片欄 + 目标选择） ─────────────────────────

/** 对抗局面：三名真人，地产、路面物件、路上神明、附身神明、对手手牌道具都有（同 ui/decisions/realEngineCombat） */
function arena(): Scenario {
  const sc = scenario({ players: ['human', 'human', 'human'], map: MAP }).untilMenu(0);
  sc.teleport(0, 5, 4).teleport(1, 6, 5).teleport(2, 12, 11);
  sc.edit((s) => {
    const land = (id: string, owner: SeatIndex, level: number) => {
      const l = s.lands.find((x) => x.id === id);
      if (l) {
        l.owner = owner;
        l.level = level as 0;
      }
    };
    land('L1', 1, 2);
    land('L2', 1, 1);
    land('L3', 0, 1);
    land('L4', 0, 3);
    land('L5', 2, 1);
    const f = s.facilities.find((x) => x.id === 'F1');
    if (f) {
      f.owner = 1;
      f.level = 1;
      f.type = 'hotel';
    }
  });
  sc.give(1, { cards: [17, 12], items: [{ item: 3, qty: 1 }] });
  sc.placeObject('roadblock', 7, 1);
  sc.placeObject('mine', 9, 2);
  sc.placeGod(3, 8);
  sc.attachGod(2, 5, 5);
  sc.setPoints(0, 500);
  return sc;
}

const testIdOf = (el: Element): string => el.getAttribute('data-testid') ?? '';

/** 在原版目标面板里按候选形态点第一个（多步的依次点） */
async function pickFirst(user: Mounted['user'], picker: HTMLElement): Promise<void> {
  const clickFirst = async (re: RegExp): Promise<boolean> => {
    const el = [...picker.querySelectorAll('[data-testid]')].find(
      (x) => re.test(testIdOf(x)) && !(x as HTMLButtonElement).disabled,
    );
    if (!el) return false;
    await user.click(el);
    return true;
  };
  switch (picker.getAttribute('data-target-kind')) {
    case 'none':
    case 'auto':
      return;
    case 'anyNode': {
      const sel = within(picker).getByTestId('target-any-node') as HTMLSelectElement;
      const opt = [...sel.options].find((o) => o.value !== '');
      if (opt) await user.selectOptions(sel, opt.value);
      return;
    }
    case 'rob':
      await clickFirst(/^target-rob-\d+$/);
      await clickFirst(/^target-rob-(card|item)-/);
      return;
    case 'teleport':
      await clickFirst(/^target-tp-src-/);
      await clickFirst(/^target-tp-(road|lot)-/);
      return;
    default:
      await clickFirst(/^target-(seat|actor|lot|pair|object|stock|node|dice)-/);
      await clickFirst(/^target-type-/);
  }
}

type UseResult = { used: true; events: GameEvent[] } | { used: false; reason: string };

/** 原版回合菜单 → 卡片 / 道具欄 → 点格 → 原版目标面板选第一个候选 → YES → 交给引擎 */
async function useFromBar(sc: Scenario, tab: 'turn-cards' | 'turn-items', cell: string): Promise<UseResult> {
  const m = await mount(sc, 0, 'TURN_MENU');
  await m.user.click(within(m.root).getByTestId(tab));
  const btn = within(m.root).getByTestId(cell);
  if ((btn as HTMLButtonElement).disabled) return { used: false, reason: btn.getAttribute('aria-label') ?? '' };
  await m.user.click(btn);
  expect(m.root).toHaveAttribute('data-targeting', 'true');
  const picker = within(m.root).getByTestId('target-picker');
  await pickFirst(m.user, picker);
  const confirm = within(m.root).getByTestId('target-confirm');
  expect(confirm, `${cell} ${picker.getAttribute('data-target-kind')}`).not.toBeDisabled();
  await m.user.click(confirm);
  sc.act(0, lastIntent(m));
  return { used: true, events: sc.events };
}

const ACTIVE_CARDS = (Object.keys(CARD_KEYS).map(Number) as CardId[]).filter((c) => ![18, 19, 20, 21].includes(c));
const ACTIVE_ITEMS = ITEM_IDS.filter((i) => i !== 10) as ItemId[];

describe('原版卡片欄 × 引擎候选 → 目标面板 → 引擎接受', { timeout: 60_000 }, () => {
  it.each(ACTIVE_CARDS.map((c) => [c, CARD_KEYS[c]] as const))('卡 %i %s', async (card) => {
    const sc = arena();
    if (card === 22) sc.attachGod(0, 7, 5);
    sc.give(0, { cards: [card] });
    const slot = sc.player(0).cards.indexOf(card);
    const r = await useFromBar(sc, 'turn-cards', `inv-card-${slot}`);
    if (!r.used) throw new Error(`card ${card} not usable in arena: ${r.reason}`);
    const types = r.events.map((e) => e.type);
    expect(types.includes('CARD_USED') || types.includes('CARD_NO_EFFECT'), types.join(',')).toBe(true);
  });

  it.each(ACTIVE_ITEMS.map((i) => [i] as const))('道具 %i', async (item) => {
    const sc = arena();
    sc.give(0, { items: [{ item, qty: 1 }] });
    const r = await useFromBar(sc, 'turn-items', `inv-item-${item}`);
    if (!r.used) throw new Error(`item ${item} not usable in arena: ${r.reason}`);
    expect(r.events.map((e) => e.type)).toContain('ITEM_USED');
  });
});

describe('原版回合菜单的其他操作', { timeout: 30_000 }, () => {
  it('被动卡置灰（点它只看说明与原因）；时光机没有时间点时禁用', async () => {
    const sc = arena();
    sc.give(0, { cards: [8, 21], items: [{ item: 10, qty: 1 }] });
    const m = await mount(sc, 0, 'TURN_MENU');
    expect(within(m.root).getByTestId('inv-card-0')).toBeEnabled();
    const passive = within(m.root).getByTestId('inv-card-1');
    expect(passive).toBeDisabled();
    expect(passive).toHaveAttribute('data-usable', 'false');
    expect(passive.getAttribute('aria-label')).toContain('被动卡');
    await m.user.click(within(m.root).getByTestId('turn-items'));
    expect(m.root).toHaveAttribute('data-tab', 'items');
    expect(within(m.root).getByTestId('inv-item-10')).toBeDisabled();
  });

  it('工具列请求打开道具欄（TurnMenuSheetContext）；用完道具后收起回合菜单', async () => {
    const sc = arena();
    sc.give(0, { items: [{ item: 2, qty: 1 }] });
    const sheet = { request: 'items' as const, consume: vi.fn(), collapse: vi.fn() };
    const m = await mount(sc, 0, 'TURN_MENU', { sheet });
    expect(sheet.consume).toHaveBeenCalled();
    expect(m.root).toHaveAttribute('data-tab', 'items');
    await m.user.click(within(m.root).getByTestId('inv-item-2'));
    const picker = within(m.root).getByTestId('target-picker');
    expect(picker).toHaveAttribute('data-target-kind', 'node');
    // 返回：回到道具欄
    await m.user.click(within(m.root).getByTestId('target-cancel'));
    expect(m.root).toHaveAttribute('data-targeting', 'false');
    await m.user.click(within(m.root).getByTestId('inv-item-2'));
    await pickFirst(m.user, within(m.root).getByTestId('target-picker'));
    await m.user.click(within(m.root).getByTestId('target-confirm'));
    expect(lastIntent(m)).toMatchObject({ type: 'USE_ITEM', item: 2 });
    expect(sheet.collapse).toHaveBeenCalled();
  });

  it('投降：确认框 YES → SURRENDER', async () => {
    const sc = scenario({ players: ['human', 'human', 'human'], map: MAP }).untilMenu(0);
    const m = await mount(sc, 0, 'TURN_MENU');
    await m.user.click(within(m.root).getByTestId('turn-surrender'));
    expect(m.root).toHaveAttribute('data-sheet', 'surrender');
    await m.user.click(within(m.root).getByTestId('surrender-confirm'));
    expect(commit(sc, 0, m)).toEqual({ type: 'SURRENDER' });
    sc.expectAsk(0, 'DEATH_GOD_TARGET');
  });

  it('股市子页：买 300 股 → STOCK_BUY（原版回合菜单里的股票子页）', async () => {
    const sc = scenario({ players: ['human', 'human'], map: MAP }).untilMenu(0);
    const m = await mount(sc, 0, 'TURN_MENU');
    await m.user.click(within(m.root).getByTestId('turn-stock'));
    const sheet = await screen.findByTestId('turn-stock-sheet');
    await m.user.click(within(sheet).getByTestId('stock-pick-0'));
    const qty = within(sheet).getByRole('spinbutton', { name: '股数' });
    await m.user.clear(qty);
    await m.user.type(qty, '300');
    await m.user.click(within(sheet).getByTestId('stock-submit'));
    expect(commit(sc, 0, m)).toEqual({ type: 'STOCK_BUY', stock: 0, shares: 300 });
  });
});

describe('轮盘帧（纯函数）', () => {
  it('转动的最后一帧正好停在结果扇区；中途按减速曲线推进', () => {
    for (let final = 2; final <= 13; final++) expect(wheelFrameAt(1000, 1000, final)).toBe(final);
    expect(wheelFrameAt(0, 1000, 7)).toBe(2);
    act(() => undefined);
  });
});
