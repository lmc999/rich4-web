// M6 / M7 事件演出（design/client.md §3.6、§4.5）：用记录调用的假舞台 / 假棋盘检查 handler 的演出调用、
// 弹窗内容与包装器的舞台同步。
import {
  CHARACTER_KEYS,
  type GameEvent,
  type GameEventOf,
  type GameEventType,
  type SeatIndex,
} from '@rich4/shared/engine';
import type { GameView } from '@rich4/shared/view';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AnimClock } from '../../game/anim/AnimClock';
import { initI18n } from '../../i18n';
import { tx } from '../../i18n/tx';
import { useUiStore } from '../../store/uiStore';
import { selfPlay } from '../../test/selfPlay';
import { type OpenPopup, usePopupStore } from '../../ui/popups/popupStore';
import { makeNames } from '../names';
import type { BoardPort, PresentationContext } from '../types';
import { createUiPresenter } from '../UiPresenter';
import { HANDLERS, RAW_HANDLERS } from '.';
import { removalOf } from './items';
import { recordingStage, type StageCall } from './testStage';
import { touchesStage } from './wrap';

beforeAll(() => {
  initI18n('original');
});

beforeEach(() => {
  usePopupStore.getState().clear();
});

type Call = [string, ...unknown[]];

function fakeBoard(calls: Call[], stageCalls: StageCall[]): BoardPort & { stage: ReturnType<typeof recordingStage> } {
  const rec =
    (name: string, ret?: unknown) =>
    (...a: unknown[]) => {
      calls.push([name, ...a.filter((x) => !(x instanceof AbortSignal))]);
      return ret;
    };
  return {
    ready: true,
    syncView: rec('syncView'),
    walk: rec('walk', Promise.resolve()) as BoardPort['walk'],
    placeActor: rec('placeActor'),
    hop: rec('hop', Promise.resolve()) as BoardPort['hop'],
    setActorPose: rec('setActorPose'),
    setLot: rec('setLot'),
    focus: rec('focus', Promise.resolve()) as BoardPort['focus'],
    follow: rec('follow'),
    floatText: rec('floatText'),
    coinFlight: rec('coinFlight', Promise.resolve()) as BoardPort['coinFlight'],
    plantFlag: rec('plantFlag', Promise.resolve()) as BoardPort['plantFlag'],
    popBuilding: rec('popBuilding', Promise.resolve()) as BoardPort['popBuilding'],
    pulseTile: rec('pulseTile'),
    shake: rec('shake'),
    clearFx: rec('clearFx'),
    stage: recordingStage(stageCalls),
  };
}

const base = selfPlay({ seed: 3, steps: 2 }).initial.view;
const view: GameView = { ...base, beggars: [{ seat: 3, node: 7 }] };

interface Run {
  calls: Call[];
  stage: StageCall[];
  popups: OpenPopup[];
}

async function run<T extends GameEventType>(
  e: GameEventOf<T>,
  o: { v?: GameView; me?: SeatIndex | null; raw?: boolean; speed?: number } = {},
): Promise<Run> {
  const calls: Call[] = [];
  const stage: StageCall[] = [];
  const popups: OpenPopup[] = [];
  const off = usePopupStore.subscribe((st) => {
    if (st.current && popups.at(-1)?.id !== st.current.id) popups.push(st.current);
  });
  const clock = new AnimClock();
  clock.instant = true;
  const v = o.v ?? view;
  const me = o.me === undefined ? 0 : o.me;
  const ctx: PresentationContext = {
    signal: new AbortController().signal,
    wait: (ms) => clock.wait(ms),
    board: fakeBoard(calls, stage),
    ui: createUiPresenter({ wait: (ms, s) => clock.wait(ms, s) }),
    audio: { play: () => {} },
    me,
    role: me === null ? 'spectator' : 'player',
    view: () => v,
    map: null,
    names: makeNames({ t: tx, view: () => v, map: () => null }),
    t: tx,
    ...(o.speed !== undefined ? { animSpeed: () => o.speed! } : {}),
  };
  const table = o.raw ? RAW_HANDLERS : HANDLERS;
  const h = table[e.type] as unknown as (x: GameEvent, c: PresentationContext) => Promise<void>;
  await h(e as GameEvent, ctx);
  off();
  return { calls, stage, popups };
}

const names = (xs: { 0: string }[]): string[] => xs.map((x) => x[0]);

describe('M6 卡片与道具', () => {
  it('CARD_USED：施放姿势 + 出卡弹窗 + 光束连到目标，结束后弹窗关闭', async () => {
    const r = await run({ type: 'CARD_USED', seat: 0, card: 17, target: { t: 'seat', seat: 1 } });
    expect(r.calls).toContainEqual(['setActorPose', 0, 'cast']);
    expect(r.stage).toContainEqual(['beam', { seat: 0 }, { seat: 1 }, 0xf2545b]);
    const p = r.popups[0];
    expect(p?.kind).toBe('cardCast');
    if (p?.kind === 'cardCast') {
      expect(p.cardName).toBe('陷害卡');
      expect(p.variant).toBe('cast');
      expect(p.targetText).toBe(tx(`characters:${CHARACTER_KEYS[view.players[1]!.character]}.name`));
    }
    expect(usePopupStore.getState().current).toBeNull();
  });

  it('PASSIVE：被动卡弹窗 + 气泡台词', async () => {
    const r = await run({ type: 'PASSIVE', seat: 1, card: 21, context: 'frame' });
    expect(r.popups[0]).toMatchObject({ kind: 'cardCast', variant: 'passive', card: 21 });
    expect(r.stage.find((c) => c[0] === 'bubble')?.[2]).toBe('免罪卡发动：逃过一劫！');
  });

  it('OBJECT_PLACED / OBJECT_REMOVED：物件落下；按起因弹飞或爆炸', async () => {
    const obj = { id: 4, kind: 'mine', node: 6, placedBy: 0 } as const;
    const a = await run({ type: 'OBJECT_PLACED', obj });
    expect(a.stage).toContainEqual(['dropObject', obj]);
    const e: GameEventOf<'OBJECT_REMOVED'> = { type: 'OBJECT_REMOVED', obj, cause: { k: 'object', ref: null, by: 1 } };
    expect(removalOf(e)).toBe('boom');
    expect(removalOf({ ...e, obj: { ...obj, kind: 'roadblock' } })).toBe('burst');
    expect(removalOf({ ...e, cause: { k: 'villain', ref: 'thief', by: null } })).toBe('pickup');
    const b = await run(e);
    expect(b.stage).toContainEqual(['removeObject', obj, 'boom']);
  });

  it('DOLL_WALK：机器娃娃沿路走；被扫走的神明交给随后的 GOD_LEFT 离场（这里不提前离场，免得同步后播两次）', async () => {
    const r = await run({ type: 'DOLL_WALK', seat: 0, path: [2, 3, 4], clearedObjects: [9], clearedGods: [7] });
    expect(r.stage).toContainEqual(['dollWalk', [2, 3, 4], [9]]);
    expect(names(r.stage)).not.toContain('godLeave');
    const g = await run({ type: 'GOD_LEFT', kind: 7, seat: null, reason: 'swept' } as GameEventOf<'GOD_LEFT'>);
    expect(g.stage).toContainEqual(['godLeave', null, 7]);
  });

  it('BOMB_*：贴上、转移、爆炸（镜头移到爆点、闪白、大爆炸）', async () => {
    expect((await run({ type: 'BOMB_ATTACHED', seat: 1, fuse: 38 })).stage).toContainEqual(['bombAttach', 1, 38]);
    expect((await run({ type: 'BOMB_TRANSFERRED', from: 1, to: 2, fuse: 30 })).stage).toContainEqual([
      'bombPass',
      1,
      2,
      30,
    ]);
    const r = await run({ type: 'BOMB_EXPLODED', seat: 2, node: 6, lot: null });
    expect(r.calls).toContainEqual(['focus', { tile: 6 }, 300]);
    expect(names(r.stage)).toContain('flash');
    expect(r.stage).toContainEqual(['explode', { tile: 6 }, 'big']);
  });

  it('STRIKE：飞弹与核弹都交给舞台，落点与范围原样传入', async () => {
    const m = await run({ type: 'STRIKE', kind: 'missile', center: 6, half: 100, lots: [], actors: [] });
    expect(m.stage).toContainEqual(['strike', 'missile', 6, 100]);
    const n = await run({ type: 'STRIKE', kind: 'nuke', center: 9, half: 220, lots: [], actors: [] });
    expect(n.stage).toContainEqual(['strike', 'nuke', 9, 220]);
  });

  it('TELEPORTED / TIME_REWOUND：两端光柱；倒带滤镜', async () => {
    const t = await run({
      type: 'TELEPORTED',
      by: 0,
      source: { k: 'actor', actor: { t: 'seat', seat: 1 } },
      dest: { k: 'road', node: 9 },
    });
    expect(t.stage).toContainEqual(['teleport', { seat: 1 }, { tile: 9 }]);
    expect(t.calls).toContainEqual(['hop', 1]);
    const r = await run({ type: 'TIME_REWOUND', bySeat: 0, toTurnNo: 2 });
    expect(names(r.stage)).toContain('rewind');
  });

  it('VEHICLE / VEHICLE_DESTROYED', async () => {
    expect((await run({ type: 'VEHICLE', seat: 0, vehicle: 'car', dice: 3 })).stage).toContainEqual([
      'vehicle',
      0,
      'car',
    ]);
    expect((await run({ type: 'VEHICLE_DESTROYED', seat: 0, vehicle: 'moto' })).stage).toContainEqual([
      'wreck',
      0,
      'moto',
    ]);
  });
});

describe('M6 神明与关押', () => {
  it('GOD_ATTACHED：光柱降临 + 台词弹窗', async () => {
    const r = await run({ type: 'GOD_ATTACHED', seat: 0, kind: 2, displaced: null });
    expect(r.stage).toContainEqual(['godArrive', 0, 2]);
    expect(r.popups[0]).toMatchObject({ kind: 'god', god: 2, godName: '大财神', good: true, slot: null });
  });

  it('GOD_POWER：老虎机数字与本人金额', async () => {
    const r = await run({
      type: 'GOD_POWER',
      seat: 0,
      kind: 6,
      slot: { digits: 4, value: 3721 },
      transfers: [
        { seat: 0, amount: -3721 },
        { seat: 1, amount: 3721 },
      ],
    });
    expect(r.popups[0]).toMatchObject({ kind: 'god', slot: { digits: 4, value: 3721 }, amountText: '-3,721' });
    expect(r.stage).toContainEqual(['godPower', 0, 6]);
    expect(r.calls).toContainEqual(['coinFlight', { seat: 0 }, { seat: 1 }]);
  });

  it('GOD_LEFT / GOD_SPAWNED / GOD_MANIFEST / DOG_* / DEATH_GOD_SUMMONED', async () => {
    expect((await run({ type: 'GOD_LEFT', seat: 0, kind: 2, reason: 'expired' })).stage).toContainEqual([
      'godLeave',
      0,
      2,
    ]);
    expect((await run({ type: 'GOD_SPAWNED', kind: 1, node: 8 })).stage).toContainEqual(['godSpawn', 1, 8]);
    const m = await run({ type: 'GOD_MANIFEST', seat: 0, kind: 12, lot: 'L1', effect: 'seize' });
    expect(m.stage).toContainEqual(['manifest', 12, { lot: 'L1' }, 'seize']);
    expect(m.popups[0]).toMatchObject({ kind: 'god', line: '神明显灵，这块地收归己有！' });
    expect((await run({ type: 'DOG_BITE', seat: 1, node: 7 })).stage).toContainEqual(['dogBite', 1, 7, false]);
    expect((await run({ type: 'DOG_KNOCKED', seat: 1, node: 7 })).stage).toContainEqual(['dogBite', 1, 7, true]);
    const d = await run({ type: 'DEATH_GOD_SUMMONED', by: 0, target: 2 });
    expect(d.stage).toContainEqual(['beam', { seat: 0 }, { seat: 2 }, 0x9b6bff]);
    expect(d.popups[0]).toMatchObject({ kind: 'god', god: 15 });
  });

  it('CONFINED：坐牢叫警车、住院叫救护车；出国只冒气泡', async () => {
    const cause = { k: 'card', ref: 17, by: 0 } as const;
    const j = await run({ type: 'CONFINED', actor: { t: 'seat', seat: 1 }, where: 'jail', days: 5, total: 5, cause });
    expect(j.stage).toContainEqual(['escort', 1, 'jail']);
    const h = await run({
      type: 'CONFINED',
      actor: { t: 'seat', seat: 2 },
      where: 'hospital',
      days: 3,
      total: 3,
      cause,
    });
    expect(h.stage).toContainEqual(['escort', 2, 'hospital']);
    const a = await run({ type: 'CONFINED', actor: { t: 'seat', seat: 2 }, where: 'away', days: 3, total: 3, cause });
    expect(names(a.stage)).not.toContain('escort');
    expect(a.stage.find((c) => c[0] === 'bubble')?.[2]).toBe('出国 3 天');
  });

  it('CONFINED / RELEASED：警车开走后、出狱演出前立即同步关押外观（不等事件结束）', async () => {
    const st = { ...view.players[1]!.st, jail: 5 };
    const post = { players: [{ seat: 1 as SeatIndex, set: { st, node: 14 } }] };
    const cause = { k: 'card', ref: 17, by: 0 } as const;
    const j = await run({
      type: 'CONFINED',
      actor: { t: 'seat', seat: 1 },
      where: 'jail',
      days: 5,
      total: 5,
      cause,
      post,
    } as GameEventOf<'CONFINED'>);
    const seq = names(j.stage);
    // 事件前、警车之后、事件后各一次
    expect(seq.indexOf('escort')).toBeGreaterThan(0);
    expect(seq.slice(seq.indexOf('escort')).filter((n) => n === 'syncWorld')).toHaveLength(2);
    const free = { players: [{ seat: 1 as SeatIndex, set: { st: { ...st, jail: 0 }, node: 13 } }] };
    const r = await run({ type: 'RELEASED', actor: { t: 'seat', seat: 1 }, from: 'jail', post: free });
    const rs = names(r.stage);
    expect(rs.slice(0, rs.indexOf('release')).filter((n) => n === 'syncWorld')).toHaveLength(2);
  });

  it('RELEASED / BAIL：开门闪光', async () => {
    expect((await run({ type: 'RELEASED', actor: { t: 'seat', seat: 1 }, from: 'jail' })).stage).toContainEqual([
      'release',
      1,
    ]);
    const b = await run({ type: 'BAIL', by: 0, seat: 1, cost: 30 });
    expect(b.stage).toContainEqual(['release', 1]);
    expect(b.stage).toContainEqual(['beam', { seat: 0 }, { seat: 1 }, 0xffd84d]);
  });
});

describe('M7 事件', () => {
  it('NEWS：分类、打字机标题、按显示态解析的内文与受影响玩家', async () => {
    const e: GameEventOf<'NEWS'> = {
      type: 'NEWS',
      id: 8,
      params: { seat: 1, amount: 10000 },
      affected: [1],
      post: { players: [{ seat: 1, set: { cash: view.players[1]!.cash + 10000 } }] },
    };
    const r = await run(e);
    const p = r.popups[0];
    expect(p?.kind).toBe('news');
    if (p?.kind !== 'news') return;
    expect(p.headline).toBe('地产大亨受表扬');
    expect(p.categoryLabel).toBe('政府公告');
    expect(p.body).toContain('10,000');
    expect(p.body).not.toContain('{{');
    expect(p.affected).toHaveLength(1);
    expect(p.affected[0]).toMatchObject({ seat: 1, deltas: [{ field: 'cash', delta: 10000 }] });
  });

  it('NEWS：缺参数时模板用中性默认值，不残留占位符', async () => {
    const r = await run({ type: 'NEWS', id: 29, params: {}, affected: [] });
    const p = r.popups[0];
    expect(p?.kind === 'news' && p.body).toBe('某家公司的董事长涉嫌违法超贷，被送进监狱。');
  });

  it('FATE：卡片内容、金额、加持结果', async () => {
    const r = await run({ type: 'FATE', seat: 0, id: 25, amount: 10000, blessing: 'high' });
    expect(r.popups[0]).toMatchObject({
      kind: 'fate',
      title: '继承遗产',
      tone: 'good',
      amountText: '+10,000',
      blessingText: '财运亨通，奖金加倍！',
    });
    const f = await run({ type: 'FATE', seat: 0, id: 14, amount: 3000, blessing: null });
    expect(f.popups[0]).toMatchObject({ kind: 'fate', tone: 'bad', amountText: '-3,000', blessingText: null });
  });

  it('MAGIC_CONDITION / MAGIC_CAST：女巫魔法阵 + 结果条', async () => {
    const c = await run({ type: 'MAGIC_CONDITION', caster: 0, cond: 3, targets: [1, 2] });
    expect(c.stage).toContainEqual(['magic', 0, [1, 2]]);
    expect(c.popups[0]).toMatchObject({ kind: 'magic', line: '女巫挥动魔杖：现金最多的人，过来吧！' });
    const m = await run({ type: 'MAGIC_CAST', caster: 0, effect: 2, targets: [1] });
    expect(m.popups[0]).toMatchObject({ kind: 'magic', title: '魔法：坐牢 3 天' });
  });

  it('LOTTERY_DRAW：摇奖弹窗（显示号码 = 下标 + 1）', async () => {
    const r = await run({ type: 'LOTTERY_DRAW', number: 11, winner: 2, prize: 36000 });
    expect(r.popups[0]).toMatchObject({ kind: 'lottery', number: 12, winner: { seat: 2 } });
    const none = await run({ type: 'LOTTERY_DRAW', number: null, winner: null, prize: 0 });
    expect(none.popups[0]).toMatchObject({ kind: 'lottery', number: null, winner: null });
    // 弹窗按打开时的动画倍速换算真实寿命（组件内部的滚号按真实时间走）
    const fast = await run({ type: 'LOTTERY_DRAW', number: 11, winner: 2, prize: 36000 }, { speed: 3 });
    const p = fast.popups[0]!;
    expect(p.realMs).toBeCloseTo(p.ms / 3, 6);
  });

  it('VILLAIN_*：恶人行走、作案光束、雇主分赃', async () => {
    const w = await run({ type: 'MOVE_SEGMENT', actor: { t: 'villain', kind: 'thief' }, path: [4, 5], remaining: 0 });
    expect(names(w.stage)).toContain('walkVillain');
    const a = await run({
      type: 'VILLAIN_ACTION',
      kind: 'robber',
      employer: 0,
      victim: 1,
      what: 'robDeposit',
      amount: 4000,
    });
    expect(a.stage).toContainEqual(['beam', { tile: 5 }, { seat: 1 }, 0xc0392b]);
    expect(a.calls).toContainEqual(['coinFlight', { seat: 1 }, { seat: 0 }]);
  });

  it('BEGGAR_ALMS：金币飞向乞丐，乞丐挪窝', async () => {
    const r = await run({ type: 'BEGGAR_ALMS', payer: 0, beggar: 3, amount: 1000, newNode: 11 });
    expect(r.calls).toContainEqual(['coinFlight', { seat: 0 }, { tile: 7 }]);
    expect(r.stage).toContainEqual(['beggarMove', 3, 11]);
  });

  it('AUCTION_*：公开竞价横幅随出价更新，结束后收起', async () => {
    await run({ type: 'AUCTION_STARTED', lot: 'L1', seller: 0, source: 'card', start: 2000, bidders: [1, 2, 3] });
    expect(usePopupStore.getState().auction).toMatchObject({ lot: 'L1', price: 2000, leader: null });
    expect(usePopupStore.getState().auction?.bidders.map((b) => b.seat)).toEqual([1, 2, 3]);
    await run({ type: 'AUCTION_BID', seat: 2, price: 2600 });
    expect(usePopupStore.getState().auction).toMatchObject({ price: 2600, leader: { seat: 2 }, tick: 1 });
    await run({ type: 'AUCTION_PASS', seat: 1 });
    await run({ type: 'AUCTION_QUIT', seat: 3 });
    expect(usePopupStore.getState().auction?.bidders.map((b) => b.state)).toEqual(['passed', 'active', 'quit']);
    const end = await run({ type: 'AUCTION_ENDED', lot: 'L1', winner: 2, price: 2600 });
    expect(end.calls).toContainEqual(['plantFlag', 'L1', 2]);
    expect(usePopupStore.getState().auction).toBeNull();
  });

  it('GAME_OVER：烟花 + 终局弹窗（排名与资产构成）', async () => {
    const r = await run({
      type: 'GAME_OVER',
      result: {
        reason: 'timeLimit',
        code: 3,
        winner: 1,
        date: 19990101,
        elapsedDays: 365,
        ranking: [
          { seat: 1, netWorth: view.players[1]!.cash + view.players[1]!.deposit + 5000, alive: true },
          { seat: 0, netWorth: view.players[0]!.cash + view.players[0]!.deposit, alive: true },
        ],
      },
    });
    expect(names(r.stage)).toContain('fireworks');
    const p = r.popups[0];
    expect(p?.kind).toBe('gameOver');
    if (p?.kind !== 'gameOver') return;
    expect(p.rows.map((x) => x.rank)).toEqual([1, 2]);
    expect(p.rows[0]!.parts.estate).toBe(5000);
    expect(p.winner?.seat).toBe(1);
  });
});

describe('包装器：舞台同步', () => {
  it('事件前按提交前显示态同步；post 改到舞台字段时事件后再同步一次', async () => {
    const obj = { id: 5, kind: 'roadblock', node: 6, placedBy: 0 } as const;
    const r = await run({ type: 'OBJECT_PLACED', obj, post: { objects: [obj] } });
    const syncs = r.stage.filter((c) => c[0] === 'syncWorld');
    expect(syncs).toEqual([
      ['syncWorld', view.objects.length],
      ['syncWorld', 1],
    ]);
  });

  it('touchesStage 只对物件、神明、乞丐、恶人与玩家状态字段为真', () => {
    expect(touchesStage(undefined)).toBe(false);
    expect(touchesStage({ players: [{ seat: 0, set: { cash: 1 } }] })).toBe(false);
    expect(touchesStage({ players: [{ seat: 0, set: { vehicle: 'car' } }] })).toBe(true);
    expect(touchesStage({ gods: [] })).toBe(true);
    expect(touchesStage({ lands: [] })).toBe(false);
  });

  it('handler 自然结束时不中止派生信号：不阻塞的回合横幅完整显示 1.4 秒', async () => {
    const clock = new AnimClock();
    const calls: Call[] = [];
    const stageCalls: StageCall[] = [];
    const outer = new AbortController();
    const ctx: PresentationContext = {
      signal: outer.signal,
      wait: (ms) => clock.wait(ms, outer.signal),
      board: fakeBoard(calls, stageCalls),
      ui: createUiPresenter({ wait: (ms, s) => clock.wait(ms, s) }),
      audio: { play: () => {} },
      me: 0,
      role: 'player',
      view: () => view,
      map: null,
      names: makeNames({ t: tx, view: () => view, map: () => null }),
      t: tx,
    };
    const h = HANDLERS.TURN_STARTED as unknown as (x: GameEvent, c: PresentationContext) => Promise<void>;
    await h({ type: 'TURN_STARTED', actor: { t: 'seat', seat: 0 }, turnNo: 3 } as GameEvent, ctx);
    const flush = async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    };
    clock.advance(1300);
    await flush();
    expect(useUiStore.getState().banner?.kind).toBe('turn');
    clock.advance(200);
    await flush();
    expect(useUiStore.getState().banner).toBeNull();
  });

  it('外层中止（reset / skipAll）后事件后同步跳过：被中止的收尾不用旧时间线覆盖舞台', async () => {
    const clock = new AnimClock();
    const calls: Call[] = [];
    const stageCalls: StageCall[] = [];
    const outer = new AbortController();
    const ctx = {
      signal: outer.signal,
      wait: (ms: number) => clock.wait(ms, outer.signal),
      board: fakeBoard(calls, stageCalls),
      ui: createUiPresenter({ wait: (ms, s) => clock.wait(ms, s) }),
      audio: { play: () => {} },
      me: 0,
      role: 'player',
      view: () => view,
      map: null,
      names: makeNames({ t: tx, view: () => view, map: () => null }),
      t: tx,
    } as PresentationContext;
    const obj = { id: 5, kind: 'roadblock', node: 6, placedBy: 0 } as const;
    const h = HANDLERS.OBJECT_PLACED as unknown as (x: GameEvent, c: PresentationContext) => Promise<void>;
    const p = h({ type: 'OBJECT_PLACED', obj, post: { objects: [obj] } } as GameEvent, ctx);
    outer.abort();
    await p;
    expect(stageCalls.filter((c) => c[0] === 'syncWorld')).toHaveLength(1);
  });

  it('未包装的 handler 不同步舞台', async () => {
    const obj = { id: 5, kind: 'roadblock', node: 6, placedBy: 0 } as const;
    const r = await run({ type: 'OBJECT_PLACED', obj, post: { objects: [obj] } }, { raw: true });
    expect(r.stage.filter((c) => c[0] === 'syncWorld')).toHaveLength(0);
  });
});
