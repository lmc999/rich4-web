// 第二组场所屏（client-dom）× 真实引擎：用引擎场景 DSL 走到真实决策，按座位视角投影出 view，渲染原版场景，
// 按场景里的原版热区 / 按钮操作得到 intent，再交给引擎执行，断言被接受且效果正确。
// 覆盖 MAGIC_CAST（悬停提示、点选确认、掩膜像素命中、取消、只读、施法 FLC 播完才提交、倒计时快到时直接提交）、
// BAIL（监狱保释、雇用恶人、医院离开、点券不足）、AUCTION_BID（三人竞价：起拍价出价、加价、领先者与价格随重问刷新、成交）、
// TURN_MENU 公佈欄子页（SALE → 类别 → 表格 → 表单挂牌、另一位玩家买下、撤下、地产上限、EXIT 收起）；
// 注册表与宿主回退；观战版拍卖厅。
import { fixtureRegistry, type MapIndex } from '@rich4/shared/data';
import type {
  DecisionKind,
  MagicEffectId,
  PlayerIntent,
  SeatIndex,
  TurnMenuOptions,
  UseTarget,
} from '@rich4/shared/engine';
import { decisionForSeat, type Scenario, scenario } from '@rich4/shared/engine-testing';
import { type DecisionForYou, projectState } from '@rich4/shared/view';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MotionGlobalConfig } from 'motion/react';
import type { ComponentType, ReactElement, ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientContext } from '../../../../app/services';
import { venueScene } from '../../../../audio';
import type { GameClient } from '../../../../net/client';
import { useGameStore } from '../../../../store/gameStore';
import { installResizeObserver, intents } from '../../../decisions/testing';
import { TurnMenuSheetContext, type TurnMenuSheetControl } from '../../../decisions/turnMenuSheet';
import type { DecisionProps } from '../../../decisions/types';
import { usePopupStore } from '../../../popups/popupStore';
import { resetClassicAssetsForTest, useClassicAssets } from '../../assets';
import { maskFromRegions } from '../../common/mask';
import { fakePackClient, installSceneAssets } from '../../common/testing';
import { ClassicDecisionHost, type SceneGateState } from '../../decisions/ClassicDecisionHost';
import { CLASSIC_REGISTRY_CONFLICTS, classicDecisionRegistry } from '../../decisions/registry';
import { type ClassicSceneModule, resolveRequiredKeys, sceneLoader } from '../../decisions/scene';
import AuctionScene, { AuctionWatchScene } from './Auction';
import BailScene from './Bail';
import { ClassicBoardSheet } from './BoardSheet';
import { BulletinBoardScene } from './BulletinBoard';
import { classicVenuesB } from './index';
import MagicHouseScene from './MagicHouse';
import { MAGIC_ICON_AT, MAGIC_MASK } from './magicLayout';
import { fakeVenueBSheets, venueBKeys } from './testing';

installResizeObserver();

beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true;
});
afterAll(() => {
  MotionGlobalConfig.skipAnimations = false;
});
beforeEach(() => {
  installSceneAssets({ sprites: fakeVenueBSheets() });
});
afterEach(() => {
  resetClassicAssetsForTest();
  usePopupStore.getState().clear();
  useGameStore.getState().clear();
});

type Submit = ReturnType<typeof vi.fn<(intent: PlayerIntent) => unknown>>;

interface Mounted {
  submit: Submit;
  user: ReturnType<typeof userEvent.setup>;
  root: HTMLElement;
  /** 以当前待决策重新渲染（新的 decisionId），返回场景根 */
  rerender(testId?: string): Promise<HTMLElement>;
  unmount(): void;
}

function mapOf(sc: Scenario): MapIndex {
  return fixtureRegistry.getMap(sc.state.dataRef.mapId);
}

function youOf(sc: Scenario, seat: SeatIndex, deadlineAt: number | null = null): DecisionForYou {
  return { ...decisionForSeat(sc.pending(seat)), deadlineAt } as DecisionForYou;
}

interface MountOpts {
  isMine?: boolean;
  wrap?: (el: ReactElement) => ReactElement;
  testId?: string;
  extra?: object;
  deadlineAt?: number | null;
}

async function mount<K extends DecisionKind>(
  sc: Scenario,
  seat: SeatIndex,
  kind: K,
  Comp: ComponentType<DecisionProps<K>>,
  o: MountOpts = {},
): Promise<Mounted> {
  sc.expectAsk(seat, kind);
  const submit = vi.fn<(intent: PlayerIntent) => unknown>(() => undefined);
  const user = userEvent.setup();
  const map = mapOf(sc);
  const el = (): ReactElement => {
    const inner = (
      <Comp
        decision={youOf(sc, seat, o.deadlineAt ?? null) as DecisionForYou<K>}
        isMine={o.isMine ?? true}
        view={projectState(sc.state, { kind: 'seat', seat }, { handVisibility: 'public' })}
        map={map}
        submit={submit}
        {...o.extra}
      />
    );
    return o.wrap ? o.wrap(inner) : inner;
  };
  const utils = render(el());
  // 不在经典舞台里时场景就地渲染在容器里：按容器找（同时挂着几位玩家的场景时互不干扰）
  const root = await within(utils.container).findByTestId(o.testId ?? `decision-${kind}`);
  return {
    submit,
    user,
    root,
    async rerender(testId) {
      utils.rerender(el());
      return within(utils.container).findByTestId(testId ?? `decision-${sc.pending(seat).kind}`);
    },
    unmount: () => utils.unmount(),
  };
}

/** 取场景提交的最后一个 intent 交给引擎（不合法时引擎抛错，测试失败） */
function commit(sc: Scenario, seat: SeatIndex, m: Mounted): PlayerIntent {
  const last = intents(m.submit).at(-1);
  if (!last) throw new Error('scene submitted nothing');
  sc.act(seat, last);
  return last;
}

/** 三名真人，P1 站在魔法屋前一格，条件预置为「现金最多的人」（P2 现金最多） */
function magicScenario(): Scenario {
  const sc = scenario({ players: ['human', 'human', 'human'] }).untilMenu(0);
  sc.setCash(1, 900_000).force('magicCond', 3).teleport(0, 8, 7).force('dice', 1).roll(0);
  return sc;
}

/** 让 seat 在监狱（15 → 14）或医院（16 → 15）的保释格停下 */
function bailScenario(where: 'jail' | 'hospital', points = 400, inmate = where === 'jail'): Scenario {
  const sc = scenario({ players: ['human', 'human', 'human'] }).untilMenu(0);
  if (inmate) {
    // fixture test：14 号格既是保释格也是关押格（与 realEngineCombat 的 BAIL 用例相同）
    sc.edit((s) => {
      const p = s.players.find((x) => x.seat === 1)!;
      p.st.jail = 3;
      p.node = 14;
    });
  }
  sc.setPoints(0, points);
  if (where === 'jail') sc.teleport(0, 15, 16);
  else sc.teleport(0, 16, 17);
  sc.force('dice', 1).roll(0);
  return sc;
}

describe('注册表', () => {
  it('第二组登记 MAGIC_CAST / AUCTION_BID / BAIL，合并后没有冲突；requiredKeys 按真实 options 解出', async () => {
    expect(CLASSIC_REGISTRY_CONFLICTS).toEqual([]);
    for (const k of ['MAGIC_CAST', 'AUCTION_BID', 'BAIL'] as const) {
      expect(classicVenuesB[k], k).toBeDefined();
      expect(classicDecisionRegistry[k]).toBe(classicVenuesB[k]);
    }
    const sc = magicScenario();
    const magic = await sceneLoader(classicVenuesB.MAGIC_CAST!)!.load();
    const props = {
      decision: youOf(sc, 0),
      isMine: true,
      view: projectState(sc.state, { kind: 'seat', seat: 0 }, { handVisibility: 'public' }),
      map: mapOf(sc),
      submit: () => undefined,
    } as DecisionProps;
    expect(resolveRequiredKeys(magic, props)).toEqual(['venue.magic.screen', 'ui.yesno', 'ui.common']);
    const jail = bailScenario('jail');
    const bail = await sceneLoader(classicVenuesB.BAIL!)!.load();
    expect(resolveRequiredKeys(bail, { ...props, decision: youOf(jail, 0) })).toEqual([
      'venue.jail.screen',
      'venue.jail.villains',
      'ui.yesno',
    ]);
    const hosp = bailScenario('hospital');
    expect(resolveRequiredKeys(bail, { ...props, decision: youOf(hosp, 0) })).toEqual([
      'venue.hospital.screen',
      'ui.yesno',
    ]);
  });

  it('场景曲走现有的 audioWiring：魔法屋 / 拍卖 / 监狱 / 医院各有场所曲，公佈欄（TURN_MENU）没有', () => {
    expect(venueScene({ kind: 'MAGIC_CAST' })).toBe('magic');
    expect(venueScene({ kind: 'AUCTION_BID' })).toBe('auction');
    expect(venueScene({ kind: 'BAIL', where: 'jail' })).toBe('jail');
    expect(venueScene({ kind: 'BAIL', where: 'hospital' })).toBe('hospital');
    expect(venueScene({ kind: 'TURN_MENU' })).toBeNull();
  });
});

describe('MAGIC_CAST 魔法屋', () => {
  it('条件与名单；悬停点亮图标并出提示框；点选 → YES/NO 确认 → MAGIC_CAST{effect}，引擎执行（现金全部存入）', async () => {
    const sc = magicScenario();
    const m = await mount(sc, 0, 'MAGIC_CAST', MagicHouseScene);
    expect(m.root).toHaveAttribute('data-scene', 'classic');
    expect(within(m.root).getByTestId('magic-targets')).toHaveAttribute('data-targets', '1');
    expect(within(m.root).getByTestId('magic-condition').textContent).toMatch(/现金最多|現金最多/);
    // 键盘焦点 = 悬停：点亮图标、弹出提示框
    act(() => within(m.root).getByTestId('magic-effect-9').focus());
    expect(within(m.root).getByTestId('magic-lit-9')).toBeInTheDocument();
    expect(within(m.root).getByTestId('magic-hint')).toHaveAttribute('data-effect', '9');
    await m.user.click(within(m.root).getByTestId('magic-effect-4'));
    expect(m.root).toHaveAttribute('data-pick', '4');
    expect(within(m.root).getByTestId('magic-confirm-box')).toBeInTheDocument();
    expect(m.submit).not.toHaveBeenCalled();
    // 取消后重选
    await m.user.click(within(m.root).getByTestId('magic-cancel'));
    expect(m.root).toHaveAttribute('data-pick', '');
    await m.user.click(within(m.root).getByTestId('magic-effect-4'));
    const cash1 = sc.player(1).cash;
    const dep1 = sc.player(1).deposit;
    await m.user.click(within(m.root).getByTestId('magic-confirm'));
    expect(commit(sc, 0, m)).toEqual({ type: 'MAGIC_CAST', effect: 4 });
    expect(sc.player(1)).toMatchObject({ cash: 0, deposit: dep1 + cash1 });
  });

  it('点在星区按钮之外：按掩膜像素取区号（区 e+1 → 效果 e）；Esc 取消点选', async () => {
    const [ix, iy] = MAGIC_ICON_AT[4]!;
    installSceneAssets({
      sprites: fakeVenueBSheets(),
      masks: {
        [MAGIC_MASK]: maskFromRegions(640, 480, (x, y) => (Math.abs(x - ix) < 70 && Math.abs(y - iy) < 50 ? 5 : 0)),
      },
    });
    const sc = magicScenario();
    const m = await mount(sc, 0, 'MAGIC_CAST', MagicHouseScene);
    const area = within(m.root).getByTestId('magic-star').parentElement!;
    area.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 480 }) as DOMRect;
    // 按钮（56×56）之外、仍在区 5 里
    fireEvent.click(within(m.root).getByTestId('magic-star'), { clientX: ix + 60, clientY: iy + 40, detail: 1 });
    expect(m.root).toHaveAttribute('data-pick', '4');
    // 掩膜空白处：不选
    fireEvent.keyDown(m.root, { key: 'Escape' });
    expect(m.root).toHaveAttribute('data-pick', '');
    fireEvent.click(within(m.root).getByTestId('magic-star'), { clientX: 20, clientY: 20, detail: 1 });
    expect(m.root).toHaveAttribute('data-pick', '');
  });

  it('施法 FLC：有播放器时播完才提交；倒计时快到时不播、直接提交', async () => {
    let finish: () => void = () => {};
    const player = {
      canvas: document.createElement('canvas'),
      play: vi.fn(() => new Promise<void>((r) => (finish = r))),
      destroy: vi.fn(),
    };
    const loadFlic = vi.fn(async () => player);
    useClassicAssets.setState({ loadFlic: loadFlic as never });
    const clock = { now: () => 0, wait: () => Promise.resolve(), instant: false };
    const wrap = (el: ReactElement): ReactElement => (
      <ClientContext.Provider value={{ anim: clock } as unknown as GameClient}>{el}</ClientContext.Provider>
    );
    const sc = magicScenario();
    const m = await mount(sc, 0, 'MAGIC_CAST', MagicHouseScene, { wrap });
    await m.user.click(within(m.root).getByTestId('magic-effect-3'));
    await m.user.click(within(m.root).getByTestId('magic-confirm'));
    expect(m.root).toHaveAttribute('data-casting', 'true');
    await vi.waitFor(() => expect(player.play).toHaveBeenCalled());
    expect(loadFlic).toHaveBeenCalledWith('venue.magic.cast', clock);
    expect(m.submit).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(intents(m.submit)).toEqual([{ type: 'MAGIC_CAST', effect: 3 }]);
    m.unmount();

    // 倒计时只剩 2 秒：不播 FLC
    player.play.mockClear();
    const sc2 = magicScenario();
    const m2 = await mount(sc2, 0, 'MAGIC_CAST', MagicHouseScene, { wrap, deadlineAt: Date.now() + 2000 });
    await m2.user.click(within(m2.root).getByTestId('magic-effect-7'));
    await m2.user.click(within(m2.root).getByTestId('magic-confirm'));
    expect(intents(m2.submit)).toEqual([{ type: 'MAGIC_CAST', effect: 7 }]);
    expect(player.play).not.toHaveBeenCalled();
  });

  it('只读（托管 / 非本人）：显示等待状态，效果按钮禁用、不提交', async () => {
    const sc = magicScenario();
    const m = await mount(sc, 0, 'MAGIC_CAST', MagicHouseScene, { isMine: false });
    expect(m.root).toHaveAttribute('data-readonly', 'true');
    expect(within(m.root).getByTestId('decision-MAGIC_CAST-status')).toBeInTheDocument();
    for (const e of [0, 4, 11] as MagicEffectId[])
      expect(within(m.root).getByTestId(`magic-effect-${e}`)).toBeDisabled();
    expect(m.submit).not.toHaveBeenCalled();
  });
});

describe('BAIL 监狱 / 医院', () => {
  it('监狱：在押的 P2 与关在这里的小偷、强盗露出大头；选 P2 → YES → BAIL{target:1}，引擎保释', async () => {
    const sc = bailScenario('jail');
    const m = await mount(sc, 0, 'BAIL', BailScene);
    expect(m.root).toHaveAttribute('data-scene', 'classic');
    expect(m.root).toHaveAttribute('data-venue', 'jail');
    expect(within(m.root).getByTestId('bail-points')).toHaveAttribute('data-value', '400');
    expect(within(m.root).getByTestId('bail-portrait-1')).toBeInTheDocument();
    expect(within(m.root).getByTestId('bail-portrait-4')).toBeInTheDocument(); // 小偷
    expect(within(m.root).getByTestId('bail-portrait-5')).toBeInTheDocument(); // 强盗
    expect(within(m.root).queryByTestId('bail-portrait-6')).toBeNull(); // 流氓住医院
    // 没选时 YES 不能按
    expect(within(m.root).getByTestId('bail-confirm')).toBeDisabled();
    await m.user.click(within(m.root).getByTestId('bail-hire-thief'));
    expect(within(m.root).getByTestId('bail-villain-figure')).toBeInTheDocument();
    await m.user.click(within(m.root).getByTestId('bail-seat-1'));
    expect(m.root).toHaveAttribute('data-pick', 'seat-1');
    await m.user.click(within(m.root).getByTestId('bail-confirm'));
    expect(commit(sc, 0, m)).toEqual({ type: 'BAIL', target: 1 });
    expect(sc.log.some((e) => e.type === 'BAIL' && e.seat === 1)).toBe(true);
    expect(sc.player(0).points).toBe(370);
  });

  it('监狱（没有在押的人）：雇用强盗 → HIRE{robber}，引擎发出 VILLAIN_HIRED', async () => {
    const sc = bailScenario('jail', 400, false);
    const m = await mount(sc, 0, 'BAIL', BailScene);
    await m.user.click(within(m.root).getByTestId('bail-hire-robber'));
    await m.user.click(within(m.root).getByTestId('bail-confirm'));
    expect(commit(sc, 0, m)).toEqual({ type: 'HIRE', villain: 'robber' });
    expect(sc.log.some((e) => e.type === 'VILLAIN_HIRED')).toBe(true);
  });

  it('医院：流氓、间谍躺在病床上；NO = 离开 → SKIP', async () => {
    const sc = bailScenario('hospital');
    const m = await mount(sc, 0, 'BAIL', BailScene);
    expect(m.root).toHaveAttribute('data-venue', 'hospital');
    expect(within(m.root).getByTestId('bail-hire-thug')).toBeEnabled();
    expect(within(m.root).getByTestId('bail-hire-spy')).toBeEnabled();
    expect(within(m.root).queryByTestId('bail-hire-thief')).toBeNull();
    await m.user.click(within(m.root).getByTestId('bail-skip'));
    expect(commit(sc, 0, m)).toEqual({ type: 'SKIP' });
    sc.expectNoAsk(0, 'BAIL');
  });

  it('点券只够保释：恶人的格子禁用；Esc 也是离开', async () => {
    const sc = bailScenario('jail', 100);
    const m = await mount(sc, 0, 'BAIL', BailScene);
    expect(within(m.root).getByTestId('bail-seat-1')).toBeEnabled();
    expect(within(m.root).getByTestId('bail-hire-thief')).toBeDisabled();
    expect(within(m.root).getByTestId('bail-bubble').textContent).not.toBe('');
    fireEvent.keyDown(m.root, { key: 'Escape' });
    expect(intents(m.submit)).toEqual([{ type: 'SKIP' }]);
  });
});

/** 三名真人：P1 站在无主的 L1 上用拍卖卡 → P2、P3 竞拍 */
function auctionScenario(cash1?: number): Scenario {
  const sc = scenario({ players: ['human', 'human', 'human'] }).untilMenu(0);
  if (cash1 !== undefined) sc.setCash(1, cash1);
  sc.teleport(0, 5, 4).give(0, { cards: [8] });
  const row = (sc.pending(0).options as TurnMenuOptions).cards.find((r) => r.card === 8)!;
  const tg = row.targets;
  const target: UseTarget =
    tg.t === 'underfoot'
      ? { t: 'underfoot', facility: null }
      : tg.t === 'lot'
        ? { t: 'lot', lot: tg.lots[0]!, facility: null }
        : { t: 'none' };
  // （Scenario.useCard 的名字会被 lint 当成 React 钩子：直接提交 USE_CARD）
  sc.act(0, { type: 'USE_CARD', slot: row.slot, card: 8, target });
  return sc;
}

describe('AUCTION_BID 拍卖厅', () => {
  it('三人竞价：P2 按起拍价 → P3 加价 500（P2 的场景随重问刷新价格与领先者）→ P2 放弃这一轮 → P3 成交', async () => {
    const sc = auctionScenario();
    const start = (sc.pending(1).options as { start: number }).start;
    const p2 = await mount(sc, 1, 'AUCTION_BID', AuctionScene);
    expect(p2.root).toHaveAttribute('data-scene', 'classic');
    expect(within(p2.root).getByTestId('auction-price')).toHaveAttribute('data-value', String(start));
    expect(within(p2.root).getByTestId('auction-leader')).toHaveAttribute('data-leader', '');
    expect(within(p2.root).getByTestId('auction-item')).toBeInTheDocument();
    await p2.user.click(within(p2.root).getByTestId('auction-bid-0'));
    expect(commit(sc, 1, p2)).toEqual({ type: 'BID', inc: 0 });

    const p3 = await mount(sc, 2, 'AUCTION_BID', AuctionScene, { testId: 'decision-AUCTION_BID' });
    expect(within(p3.root).getByTestId('auction-leader')).toHaveAttribute('data-leader', '1');
    expect(within(p3.root).getByTestId('auction-bidder-1')).toHaveAttribute('data-leader', 'true');
    // 还没人出价时才有「按起拍价出价」
    expect(within(p3.root).queryByTestId('auction-bid-0')).toBeNull();
    await p3.user.click(within(p3.root).getByTestId('auction-bid-500'));
    expect(commit(sc, 2, p3)).toEqual({ type: 'BID', inc: 500 });
    p3.unmount();

    // P2 的场景同一实例重渲染：新价格、领先者换成 P3、拍卖官举手喊价
    const again = await p2.rerender();
    expect(within(again).getByTestId('auction-price')).toHaveAttribute('data-value', String(start + 500));
    expect(within(again).getByTestId('auction-leader')).toHaveAttribute('data-leader', '2');
    expect(within(again).getByTestId('auction-auctioneer-call')).toBeInTheDocument();
    await p2.user.click(within(again).getByTestId('auction-pass'));
    expect(commit(sc, 1, p2)).toEqual({ type: 'PASS' });
    const ended = sc.log.find((e) => e.type === 'AUCTION_ENDED');
    expect(ended).toMatchObject({ winner: 2, price: start + 500 });
  });

  it('出价后超过现金的档位禁用；退出 → QUIT', async () => {
    const start = (auctionScenario().pending(1).options as { start: number }).start;
    const sc = auctionScenario(start + 600);
    const p2 = await mount(sc, 1, 'AUCTION_BID', AuctionScene);
    expect(within(p2.root).getByTestId('auction-bid-100')).toBeEnabled();
    expect(within(p2.root).getByTestId('auction-bid-500')).toBeEnabled();
    expect(within(p2.root).getByTestId('auction-bid-1000')).toBeDisabled();
    expect(within(p2.root).getByTestId('auction-bid-10000')).toBeDisabled();
    await p2.user.click(within(p2.root).getByTestId('auction-quit'));
    expect(commit(sc, 1, p2)).toEqual({ type: 'QUIT' });
  });

  it('观战版：有公开竞价横幅时显示拍卖厅（只读、竞拍者状态），没有拍卖时不渲染', async () => {
    const sc = auctionScenario();
    const view = projectState(sc.state, { kind: 'spectator' }, { handVisibility: 'public' });
    const map = mapOf(sc);
    const { rerender } = render(<AuctionWatchScene view={view} map={map} />);
    expect(screen.queryByTestId('classic-auction-watch')).toBeNull();
    act(() =>
      usePopupStore.getState().setAuction({
        lot: 'L1',
        lotName: 'L1',
        sellerName: null,
        start: 1000,
        price: 1500,
        leader: { seat: 2, character: view.players[2]!.character, name: 'P3' },
        bidders: [
          { seat: 1, character: view.players[1]!.character, name: 'P2', state: 'passed' },
          { seat: 2, character: view.players[2]!.character, name: 'P3', state: 'active' },
        ],
        result: null,
        tick: 1,
      }),
    );
    rerender(<AuctionWatchScene view={view} map={map} />);
    const w = await screen.findByTestId('classic-auction-watch');
    expect(w).toHaveAttribute('data-readonly', 'true');
    expect(within(w).getByTestId('auction-price')).toHaveAttribute('data-value', '1500');
    expect(within(w).getByTestId('auction-bidder-1')).toHaveAttribute('data-state', 'passed');
    expect(within(w).getByTestId('auction-bidder-2')).toHaveAttribute('data-leader', 'true');
    expect(within(w).queryByTestId('auction-pass')).toBeNull();
  });
});

describe('TURN_MENU 公佈欄子页', () => {
  function sheetCtl(request: TurnMenuSheetControl['request']): TurnMenuSheetControl & {
    consume: ReturnType<typeof vi.fn<() => void>>;
    collapse: ReturnType<typeof vi.fn<() => void>>;
  } {
    return { request, consume: vi.fn<() => void>(), collapse: vi.fn<() => void>() };
  }

  /** 单独渲染公佈欄（关闭回调为空） */
  function BoardOnly(props: DecisionProps<'TURN_MENU'>): ReactNode {
    return <BulletinBoardScene {...props} onClose={() => {}} />;
  }

  function Menu(props: DecisionProps<'TURN_MENU'>): ReactNode {
    return (
      <div data-testid="decision-TURN_MENU" data-menu="true">
        <button type="button" data-testid="turn-board">
          board
        </button>
        <span>{props.decision.decisionId}</span>
      </div>
    );
  }

  function Sheet(props: DecisionProps<'TURN_MENU'>): ReactNode {
    return (
      <ClassicBoardSheet {...props}>
        <Menu {...props} />
      </ClassicBoardSheet>
    );
  }

  it('工具列 SALE 请求：打开原版公佈欄 → 挂一张卡（1500）→ 重问后挂牌出现在板上；另一位玩家买下', async () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    sc.give(0, { cards: [12] });
    const ctl = sheetCtl('board');
    const wrap = (el: ReactElement): ReactElement => (
      <TurnMenuSheetContext.Provider value={ctl}>{el}</TurnMenuSheetContext.Provider>
    );
    const m = await mount(sc, 0, 'TURN_MENU', Sheet, { wrap });
    expect(m.root).toHaveAttribute('data-sheet', 'board');
    expect(m.root).toHaveAttribute('data-scene', 'classic');
    expect(ctl.consume).toHaveBeenCalled();
    expect(within(m.root).getByTestId('board-empty')).toBeInTheDocument();
    await m.user.click(within(m.root).getByTestId('board-sell'));
    expect(within(m.root).getByTestId('board-kind-stock')).toBeDisabled();
    await m.user.click(within(m.root).getByTestId('board-kind-card'));
    await m.user.click(within(m.root).getByTestId('board-pick-card-12'));
    const input = within(m.root).getByTestId('board-calc-input');
    await m.user.clear(input);
    await m.user.type(input, '1500');
    await m.user.click(within(m.root).getByTestId('board-list'));
    expect(commit(sc, 0, m)).toEqual({ type: 'BOARD_LIST', asset: { t: 'card', card: 12 }, price: 1500 });
    const again = await m.rerender();
    expect(again).toHaveAttribute('data-step', 'board');
    const listing = (sc.pending(0).options as TurnMenuOptions).board.listings[0]!;
    expect(within(again).getByTestId(`listing-${listing.id}`)).toHaveAttribute('data-mine', 'true');
    // EXIT：快捷入口打开的子页关掉就收起回合菜单
    await m.user.click(within(again).getByTestId('board-exit'));
    expect(ctl.collapse).toHaveBeenCalled();
    m.unmount();

    // P1 掷骰结束回合；P2 回合打开公佈欄买下
    sc.roll(0);
    sc.pass();
    sc.untilMenu(1);
    const cash0 = sc.player(0).cash + sc.player(0).deposit;
    const b = await mount(sc, 1, 'TURN_MENU', Sheet, { wrap: (el) => wrap(el) });
    await b.user.click(within(b.root).getByTestId(`listing-${listing.id}`));
    expect(within(b.root).getByTestId('listing-seller')).toBeInTheDocument();
    await b.user.click(within(b.root).getByTestId(`listing-buy-${listing.id}`));
    expect(commit(sc, 1, b)).toEqual({ type: 'BOARD_BUY', listingId: listing.id });
    expect(sc.player(1).cards).toContain(12);
    expect(sc.player(0).cash + sc.player(0).deposit).toBe(cash0 + 1500);
  });

  it('菜单里的「公布栏」钮：打开公佈欄，EXIT 回到菜单；自己的挂牌可撤下', async () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    sc.give(0, { items: [{ item: 3, qty: 2 }] });
    sc.act(0, { type: 'BOARD_LIST', asset: { t: 'item', item: 3, qty: 1 }, price: 700 });
    const ctl = sheetCtl(null);
    const wrap = (el: ReactElement): ReactElement => (
      <TurnMenuSheetContext.Provider value={ctl}>{el}</TurnMenuSheetContext.Provider>
    );
    const m = await mount(sc, 0, 'TURN_MENU', Sheet, { wrap });
    expect(m.root).toHaveAttribute('data-menu', 'true');
    await m.user.click(within(m.root).getByTestId('turn-board'));
    const board = await screen.findByTestId('board-panel');
    const id = (sc.pending(0).options as TurnMenuOptions).board.listings[0]!.id;
    await m.user.click(within(board).getByTestId(`listing-${id}`));
    await m.user.click(screen.getByTestId(`listing-delist-${id}`));
    expect(commit(sc, 0, m)).toEqual({ type: 'BOARD_DELIST', listingId: id });
    await m.rerender();
    await m.user.click(screen.getByTestId('board-exit'));
    expect(ctl.collapse).not.toHaveBeenCalled();
    expect(await screen.findByTestId('turn-board')).toBeInTheDocument();
  });

  it('挂道具：表格选道具 → 数量与价格分别用计算器输入；地产价格超过上限时「挂牌」禁用', async () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    sc.give(0, { items: [{ item: 3, qty: 3 }] });
    const m = await mount(sc, 0, 'TURN_MENU', BoardOnly);
    await m.user.click(within(m.root).getByTestId('board-sell'));
    await m.user.click(within(m.root).getByTestId('board-kind-item'));
    await m.user.click(within(m.root).getByTestId('board-pick-item-3'));
    expect(within(m.root).getByTestId('board-field-qty')).toHaveAttribute('data-active', 'true');
    await m.user.click(within(m.root).getByTestId('board-calc-key-2'));
    await m.user.click(within(m.root).getByTestId('board-edit-price'));
    const input = within(m.root).getByTestId('board-calc-input');
    await m.user.clear(input);
    await m.user.type(input, '2400');
    await m.user.click(within(m.root).getByTestId('board-list'));
    expect(intents(m.submit).at(-1)).toMatchObject({
      type: 'BOARD_LIST',
      asset: { t: 'item', item: 3 },
      price: 2400,
    });
    m.unmount();

    // 地产：P1 名下的 L1（1 级）挂牌，价格不能超过上限（计算器按上限夹住），引擎接受
    const sc2 = scenario({ players: ['human', 'human'] }).untilMenu(0);
    sc2.edit((s) => {
      const l = s.lands.find((x) => x.id === 'L1')!;
      l.owner = 0;
      l.level = 1;
    });
    // edit 之后回合菜单要重问才带上 lotCaps：随便做一次非终结操作（挂一件道具再撤下）
    sc2.give(0, { items: [{ item: 3, qty: 1 }] });
    sc2.act(0, { type: 'BOARD_LIST', asset: { t: 'item', item: 3, qty: 1 }, price: 100 });
    const cap = (sc2.pending(0).options as TurnMenuOptions).board.lotCaps.find((c) => c.lot === 'L1');
    expect(cap).toBeDefined();
    const m2 = await mount(sc2, 0, 'TURN_MENU', BoardOnly);
    await m2.user.click(within(m2.root).getByTestId('board-sell'));
    await m2.user.click(within(m2.root).getByTestId('board-kind-lot'));
    await m2.user.click(within(m2.root).getByTestId('board-pick-lot-L1'));
    expect(within(m2.root).getByTestId('board-cap').textContent).toContain(cap!.cap.toLocaleString('en-US'));
    const input2 = within(m2.root).getByTestId('board-calc-input');
    await m2.user.clear(input2);
    await m2.user.type(input2, String(cap!.cap + 5000));
    await m2.user.click(within(m2.root).getByTestId('board-list'));
    const listed = intents(m2.submit).at(-1) as { price: number };
    expect(listed).toMatchObject({ type: 'BOARD_LIST', asset: { t: 'lot', lot: 'L1' } });
    expect(listed.price).toBeLessThanOrEqual(cap!.cap);
    commit(sc2, 0, m2);
    expect((sc2.pending(0).options as TurnMenuOptions).board.listings.some((l) => l.asset.t === 'lot')).toBe(true);
  });

  it('宿主回退：缺公佈欄或计算器素材时整体回退程序化回合菜单（不在这里判定：接入方把 BULLETIN_REQUIRED_KEYS 并入 requiredKeys）', async () => {
    const mod = await import('./TurnMenuBoard');
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    const keys = resolveRequiredKeys(
      mod as unknown as Pick<ClassicSceneModule, 'requiredKeys'>,
      {
        decision: youOf(sc, 0),
        isMine: true,
        view: projectState(sc.state, { kind: 'seat', seat: 0 }, { handVisibility: 'public' }),
        map: mapOf(sc),
        submit: () => undefined,
      } as DecisionProps,
    );
    expect(keys).toEqual(expect.arrayContaining(['venue.bulletin.screen', 'ui.numpad', 'ui.numpad.mask']));
  });
});

describe('宿主：原版场所屏的回退判定', () => {
  it('素材齐全 → 原版场景；缺魔法屋图集 → 整体回退程序化对话框', async () => {
    const sc = magicScenario();
    const props = {
      decision: youOf(sc, 0),
      isMine: true,
      view: projectState(sc.state, { kind: 'seat', seat: 0 }, { handVisibility: 'public' }),
      map: mapOf(sc),
      submit: vi.fn(),
    } as unknown as DecisionProps;
    const gates: [SceneGateState, string | null][] = [];
    const ok = render(
      <ClassicDecisionHost
        {...props}
        packId="test-pack"
        client={fakePackClient(venueBKeys())}
        onGate={(g, r) => gates.push([g, r])}
      />,
    );
    expect(await screen.findByTestId('decision-MAGIC_CAST')).toHaveAttribute('data-scene', 'classic');
    ok.unmount();
    const without = venueBKeys().filter((k) => k !== 'venue.magic.screen');
    render(
      <ClassicDecisionHost
        {...props}
        packId="test-pack"
        client={fakePackClient(without)}
        onGate={(g, r) => gates.push([g, r])}
      />,
    );
    const fallback = await screen.findByTestId('decision-MAGIC_CAST');
    expect(fallback).not.toHaveAttribute('data-scene');
    expect(gates).toContainEqual(['fallback', 'keys']);
  });
});
