// 对话框 × 真实引擎联调（M6 对抗系统）：引擎算出的卡片 / 道具目标候选 → 回合菜单的卡片 / 道具页 → TargetPicker 的 DOM 候选列表
// → 点第一个候选并确认 → 得到的 USE_CARD / USE_ITEM 交给引擎执行，必须被接受并发出 CARD_USED / ITEM_USED（或 CARD_NO_EFFECT）。
// 覆盖 26 张可主动使用的卡（M7 起含拍卖卡）与 12 种道具（时光机没有时间点时按引擎给的不可用原因显示为禁用；
// 有时间点时走完 TIME_REWOUND），拍卖卡另走一遍多人出价的 AUCTION_BID 对话框；
// 另覆盖被动卡询问（USE_FREE_CARD、SCAPEGOAT）、保释（BAIL）与满手弃牌（DISCARD_CARD）四种对抗决策。
// fixture 'test'：1 银行 → … 5 L1 → 6 L2 → 7 L3 → … 11 L4 → 12 L5 → 13 岔路 → 14 监狱 → 15 医院 → … 17/18 F1（整张图在视窗内）。
import { fixtureRegistry, type MapIndex } from '@rich4/shared/data';
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
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DecisionHost } from './DecisionHost';
import { installResizeObserver, intents } from './testing';

installResizeObserver();

afterEach(() => {
  cleanup();
});

const MAP = 'test';

function mapOf(sc: Scenario): MapIndex {
  return fixtureRegistry.getMap(sc.state.dataRef.mapId);
}

/** 对抗局面：三名真人，地产、路面物件、路上神明、附身神明、对手手牌道具都有 */
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

function youOf(sc: Scenario, seat: SeatIndex): DecisionForYou {
  return { ...decisionForSeat(sc.pending(seat)), deadlineAt: null } as DecisionForYou;
}

interface Mounted {
  submit: ReturnType<typeof vi.fn<(intent: PlayerIntent) => unknown>>;
  user: ReturnType<typeof userEvent.setup>;
  root: HTMLElement;
}

async function mount(sc: Scenario, seat: SeatIndex, kind: DecisionKind): Promise<Mounted> {
  sc.expectAsk(seat, kind);
  const submit = vi.fn<(intent: PlayerIntent) => unknown>(() => undefined);
  const user = userEvent.setup();
  render(
    <DecisionHost
      decision={youOf(sc, seat)}
      isMine
      view={projectState(sc.state, { kind: 'seat', seat }, { handVisibility: 'public' })}
      map={mapOf(sc)}
      submit={submit}
    />,
  );
  const root = await screen.findByTestId(`decision-${kind}`);
  return { submit, user, root };
}

function lastIntent(m: Mounted): PlayerIntent {
  const last = intents(m.submit).at(-1);
  if (!last) throw new Error('dialog submitted nothing');
  return last;
}

const testIdOf = (el: Element): string => el.getAttribute('data-testid') ?? '';

/** 在 TargetPicker 里按候选形态点第一个（多步的依次点） */
async function pickFirst(user: Mounted['user'], picker: HTMLElement): Promise<void> {
  const clickFirst = async (re: RegExp): Promise<boolean> => {
    const el = [...picker.querySelectorAll('[data-testid]')].find(
      (x) => re.test(testIdOf(x)) && !(x as HTMLButtonElement).disabled,
    );
    if (!el) return false;
    await user.click(el);
    return true;
  };
  const kind = picker.getAttribute('data-target-kind');
  switch (kind) {
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
      // 0 级设施首建（天使卡）或脚下设施（购地卡）要选类型
      await clickFirst(/^target-type-/);
  }
}

type UseResult = { used: true; events: GameEvent[] } | { used: false; reason: string };

/** 回合菜单 → 卡片 / 道具页 → 点 testId → 选目标 → 确认 → 交给引擎 */
async function useFromMenu(sc: Scenario, sheet: 'turn-cards' | 'turn-items', tile: string): Promise<UseResult> {
  const m = await mount(sc, 0, 'TURN_MENU');
  await m.user.click(within(m.root).getByTestId(sheet));
  const btn = await screen.findByTestId(tile);
  if ((btn as HTMLButtonElement).disabled) {
    return { used: false, reason: btn.textContent ?? '' };
  }
  await m.user.click(btn);
  const picker = await screen.findByTestId('target-picker');
  await pickFirst(m.user, picker);
  const confirm =
    within(picker.parentElement ?? picker).queryByTestId('target-confirm') ?? screen.getByTestId('target-confirm');
  expect(confirm, `${tile} ${picker.getAttribute('data-target-kind')}`).not.toBeDisabled();
  await m.user.click(confirm);
  const intent = lastIntent(m);
  sc.act(0, intent);
  return { used: true, events: sc.events };
}

/** 可主动使用的卡（18–21 为被动卡）；拍卖卡（8）M7 起可用 */
const ACTIVE_CARDS = (Object.keys(CARD_KEYS).map(Number) as CardId[]).filter((c) => ![18, 19, 20, 21].includes(c));

describe('M6 卡片：引擎候选 → DOM 目标选择 → 引擎接受', { timeout: 30_000 }, () => {
  it.each(ACTIVE_CARDS.map((c) => [c, CARD_KEYS[c]] as const))('卡 %i %s', async (card) => {
    const sc = arena();
    // 送神符：送走附在自己身上的衰神
    if (card === 22) sc.attachGod(0, 7, 5);
    sc.give(0, { cards: [card] });
    const slot = sc.player(0).cards.indexOf(card);
    const r = await useFromMenu(sc, 'turn-cards', `inv-card-${slot}`);
    if (!r.used) throw new Error(`card ${card} not usable in arena: ${r.reason}`);
    const types = r.events.map((e) => e.type);
    expect(types.includes('CARD_USED') || types.includes('CARD_NO_EFFECT'), types.join(',')).toBe(true);
  });

  it('被动卡在菜单里是禁用的并显示原因；拍卖卡（M7）可用', async () => {
    const sc = arena();
    sc.give(0, { cards: [8, 21] });
    const m = await mount(sc, 0, 'TURN_MENU');
    await m.user.click(within(m.root).getByTestId('turn-cards'));
    expect(await screen.findByTestId('inv-card-0')).toBeEnabled();
    const passive = await screen.findByTestId('inv-card-1');
    expect(passive).toBeDisabled();
    expect(passive).toHaveTextContent('被动卡');
  });

  it('拍卖卡：脚下 L1 开拍 → 两名竞拍者在 AUCTION_BID 对话框里出价 / 加价 / 放弃 → 成交', async () => {
    const sc = arena();
    sc.give(0, { cards: [8] });
    const r = await useFromMenu(sc, 'turn-cards', `inv-card-${sc.player(0).cards.indexOf(8)}`);
    if (!r.used) throw new Error(r.reason);
    const started = sc.log.find((e) => e.type === 'AUCTION_STARTED');
    expect(started).toMatchObject({ lot: 'L1', seller: 0, source: 'card', bidders: [1, 2] });
    cleanup();
    // 1 号按起拍价出价（两人并发各有一个决策；出价后另一人的旧决策作废、按新价重问）
    const b1 = await mount(sc, 1, 'AUCTION_BID');
    const start = (sc.pending(1).options as { start: number }).start;
    expect(within(b1.root).getByTestId('auction-price')).toHaveTextContent(start.toLocaleString('en-US'));
    await b1.user.click(within(b1.root).getByTestId('auction-bid-0'));
    sc.act(1, lastIntent(b1));
    cleanup();
    // 2 号看到领先者 1 号，加价 500
    const b2 = await mount(sc, 2, 'AUCTION_BID');
    expect(within(b2.root).getByTestId('auction-leader')).not.toHaveTextContent('还没有人出价');
    await b2.user.click(within(b2.root).getByTestId('auction-bid-500'));
    sc.act(2, lastIntent(b2));
    cleanup();
    // 1 号放弃这一轮 → 没有人可以再出价 → 2 号以起拍价 + 500 成交
    const b3 = await mount(sc, 1, 'AUCTION_BID');
    await b3.user.click(within(b3.root).getByTestId('auction-pass'));
    expect(lastIntent(b3)).toEqual({ type: 'PASS' });
    sc.act(1, lastIntent(b3));
    const ended = sc.log.find((e) => e.type === 'AUCTION_ENDED');
    expect(ended).toMatchObject({ lot: 'L1', winner: 2, price: start + 500 });
    expect(sc.state.lands.find((l) => l.id === 'L1')?.owner).toBe(2);
    sc.expectAsk(0, 'TURN_MENU');
  });
});

const ACTIVE_ITEMS = ITEM_IDS.filter((i) => i !== 10) as ItemId[];

describe('M6 道具：引擎候选 → DOM 目标选择 → 引擎接受', { timeout: 30_000 }, () => {
  it.each(ACTIVE_ITEMS.map((i) => [i] as const))('道具 %i', async (item) => {
    const sc = arena();
    sc.give(0, { items: [{ item, qty: 1 }] });
    const r = await useFromMenu(sc, 'turn-items', `inv-item-${item}`);
    if (!r.used) throw new Error(`item ${item} not usable in arena: ${r.reason}`);
    const types = r.events.map((e) => e.type);
    expect(types.includes('ITEM_USED'), types.join(',')).toBe(true);
  });

  it('时光机：没有时间点时禁用（noAnchor）', async () => {
    const sc = arena();
    sc.give(0, { items: [{ item: 10, qty: 1 }] });
    const m = await mount(sc, 0, 'TURN_MENU');
    await m.user.click(within(m.root).getByTestId('turn-items'));
    const b = await screen.findByTestId('inv-item-10');
    expect(b).toBeDisabled();
    expect(b).toHaveTextContent('还没有可以回去的时间点');
  });

  it('时光机（M7，global）：回到最近一次真人掷骰之前（TIME_REWOUND + SYNC）', async () => {
    const sc = arena();
    // 0、1、2 号依次掷骰；global 模式下锚点是最后一次真人掷骰（2 号）之前的世界
    sc.force('dice', 1).roll(0).untilMenu(1).roll(1).untilMenu(2);
    const turn2 = sc.state.clock.turnNo;
    const at2 = { node: sc.player(2).node, cash: sc.player(2).cash };
    sc.roll(2).untilMenu(0);
    sc.give(0, { items: [{ item: 10, qty: 2 }] });
    const r = await useFromMenu(sc, 'turn-items', 'inv-item-10');
    if (!r.used) throw new Error(r.reason);
    const types = r.events.map((e) => e.type);
    expect(types).toContain('TIME_REWOUND');
    expect(types.at(-1)).toBe('SYNC');
    expect(sc.state.clock.turnNo).toBe(turn2);
    expect(sc.player(2)).toMatchObject(at2);
    // 锚点世界里 0 号还没有时光机（之后才发的）：扣减后最低为 0
    expect(sc.player(0).items[10] ?? 0).toBe(0);
    sc.expectAsk(2, 'TURN_MENU');
  });

  it('时光机目标面板的说明按模式区分：global「最近一次真人掷骰之前」，perSeat「你上一次掷骰之前」', async () => {
    for (const [mode, text] of [
      ['global', '最近一次真人掷骰之前'],
      ['perSeat', '你上一次掷骰之前'],
    ] as const) {
      const sc = scenario({ players: ['human', 'human'], map: MAP, rules: { timeMachine: mode } }).untilMenu(0);
      sc.teleport(0, 3, 2).force('dice', 1).roll(0).untilMenu(1).roll(1).untilMenu(0);
      sc.give(0, { items: [{ item: 10, qty: 1 }] });
      const m = await mount(sc, 0, 'TURN_MENU');
      await m.user.click(within(m.root).getByTestId('turn-items'));
      await m.user.click(await screen.findByTestId('inv-item-10'));
      const note = await screen.findByTestId('target-note');
      expect(note).toHaveTextContent(text);
      cleanup();
    }
  });
});

describe('M6 对抗决策（真实引擎 options）', { timeout: 30_000 }, () => {
  it('USE_FREE_CARD：别人的查税找上门，在出卡者的回合里被问是否用免费卡 → 用 → 免查', async () => {
    const sc = scenario({ players: ['human', 'human', 'human'], map: MAP }).untilMenu(0);
    sc.teleport(0, 5, 4).teleport(1, 6, 5).teleport(2, 12, 11);
    sc.give(0, { cards: [26] }).give(1, { cards: [20] });
    const cash1 = sc.player(1).cash;
    sc.useCard(0, 26, { t: 'seat', seat: 1 });
    const m = await mount(sc, 1, 'USE_FREE_CARD');
    await m.user.click(within(m.root).getByTestId('free-confirm'));
    const intent = lastIntent(m);
    expect(intent).toEqual({ type: 'CONFIRM' });
    sc.act(1, intent);
    expect(sc.log.some((e) => e.type === 'PASSIVE' && e.card === 20 && e.seat === 1)).toBe(true);
    expect(sc.player(1).cash).toBe(cash1);
    sc.expectAsk(0, 'TURN_MENU');
  });

  it('SCAPEGOAT：被陷害时用嫁祸卡，从 DOM 选一名替罪者', async () => {
    const sc = scenario({ players: ['human', 'human', 'human'], map: MAP }).untilMenu(0);
    sc.teleport(0, 5, 4).teleport(1, 6, 5).teleport(2, 12, 11);
    sc.give(0, { cards: [17] }).give(1, { cards: [19] });
    sc.useCard(0, 17, { t: 'actor', actor: { t: 'seat', seat: 1 } });
    // 被陷害者 1 号在 0 号的回合里回答
    const m = await mount(sc, 1, 'SCAPEGOAT');
    const candidates = (sc.pending(1).options as { candidates: SeatIndex[] }).candidates;
    const target = candidates[0]!;
    await m.user.click(within(m.root).getByTestId(`scapegoat-seat-${target}`));
    await m.user.click(within(m.root).getByTestId('scapegoat-confirm'));
    const intent = lastIntent(m);
    expect(intent).toEqual({ type: 'SCAPEGOAT', target });
    sc.act(1, intent);
    expect(sc.log.some((e) => e.type === 'PASSIVE' && e.card === 19)).toBe(true);
    expect(sc.player(1).st.jail).toBe(0);
  });

  it('BAIL：停在监狱格被问保释，点在押玩家 → BAIL{target} 被接受', async () => {
    const sc = scenario({ players: ['human', 'human'], map: MAP }).untilMenu(0);
    sc.edit((s) => {
      const p = s.players.find((x) => x.seat === 1)!;
      p.st.jail = 3;
      p.node = 14;
    });
    sc.setPoints(0, 200).teleport(0, 13, 12).force('dice', 1).roll(0);
    const m = await mount(sc, 0, 'BAIL');
    await m.user.click(within(m.root).getByTestId('bail-seat-1'));
    const intent = lastIntent(m);
    expect(intent).toEqual({ type: 'BAIL', target: 1 });
    sc.act(0, intent);
    expect(sc.log.some((e) => e.type === 'BAIL' && e.seat === 1)).toBe(true);
  });

  it('DISCARD_CARD：handFull=choose 时满手（16 张）选一张弃掉', async () => {
    const full: CardId[] = [1, 2, 9, 10, 11, 13, 15, 16, 17, 22, 23, 24, 25, 26, 29];
    const sc = scenario({ players: ['human', 'human'], map: MAP, rules: { handFull: 'choose' } }).untilMenu(0);
    sc.give(0, { cards: full }).teleport(0, 3, 2).force('deck', 20).force('dice', 1).roll(0);
    const m = await mount(sc, 0, 'DISCARD_CARD');
    expect(within(m.root).getByTestId('discard-incoming')).toHaveTextContent('免费卡');
    expect(within(m.root).getAllByTestId(/^discard-\d+$/)).toHaveLength(16);
    await m.user.click(within(m.root).getByTestId('discard-0'));
    await m.user.click(within(m.root).getByTestId('discard-confirm'));
    const intent = lastIntent(m);
    expect(intent).toEqual({ type: 'DISCARD', slot: 0 });
    sc.act(0, intent);
    expect(sc.player(0).cards).toHaveLength(15);
  });
});
