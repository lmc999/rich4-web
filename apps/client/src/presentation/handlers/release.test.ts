// 监狱 / 医院获释后的棋子位置（VERIFY V-M7，exe v2.06 0x40d184：获释不换节点）：真实引擎在 fixture 'test-industries' 上
// 坐牢 / 住院到获释，事件按座位视角投影后逐个交给 handler（记录调用的假棋盘与假舞台）：
// - 台湾式监狱：关押格 26 在支线尽头、保释格 16 在环路上（16→25 封路）。获释（RELEASED）与走回棋盘（RETURNED）时棋子都留在 26，
//   从不放到 16；下一次掷骰从 26 沿支线走出来（walk 的路径以 26 开头）。
// - 环路式医院：关押格 = 保释格 20，获释后来路 = 20，第一步两个方向都可能。
// - 关押期间不画棋子、获释时从景观走一步出来（exe v2.06 0x4082a5–0x4082c3、fcn.0040bb40 bit4 分支）：舞台在被关之后的每次同步里
//   看到的都是关押状态（人在景观里，棋子不画）；RELEASED 先 walkOut（从监狱 / 医院出来），出现那一刻才同步成获释后的状态。
//   玩家与观战者同一套调用。
import { buildFixtureMaps, buildTestMapIndustries, createRegistry, TABLES } from '@rich4/shared/data';
import type { GameEvent, SeatIndex } from '@rich4/shared/engine';
import { type Scenario, scenario } from '@rich4/shared/engine-testing';
import type { GameView } from '@rich4/shared/view';
import { beforeAll, describe, expect, it } from 'vitest';
import { AnimClock } from '../../game/anim/AnimClock';
import { StageBench } from '../../game/orig/stage/testing/stageBench';
import { initI18n } from '../../i18n';
import { tx } from '../../i18n/tx';
import { type Sample, samplesOf, viewOf } from '../../test/realEngineHarness';
import { makeNames } from '../names';
import type { BoardPort, PresentationContext } from '../types';
import { createUiPresenter } from '../UiPresenter';
import { RAW_HANDLERS } from '.';
import { recordingStage, type StageCall } from './testStage';

beforeAll(() => {
  initI18n('original');
});

const registry = createRegistry([...buildFixtureMaps(), buildTestMapIndustries()], { tables: TABLES });
const MAP_ID = 'test-industries';
const map = registry.getMap(MAP_ID);
const JAIL_HOLD = 26;
const JAIL_GATE = 16;
const HOSPITAL_HOLD = 20;

type Call = [string, ...unknown[]];

/** 推进引擎并把这段事件记成样本（每个样本带提交前的显示态） */
class Tape {
  readonly samples: Sample[] = [];
  private view: GameView;
  constructor(readonly sc: Scenario) {
    this.view = viewOf(sc.state);
  }
  run(fn: (sc: Scenario) => void): void {
    const from = this.sc.log.length;
    fn(this.sc);
    const got = samplesOf(this.sc.log.slice(from), this.view, this.sc.state);
    this.samples.push(...got.samples);
    this.view = got.view;
  }
  get latest(): GameView {
    return this.view;
  }
}

/** 0 号获释（RELEASED）之后到自己的第一个回合菜单 */
function untilReleasedMenu(sc: Scenario): void {
  const from = sc.log.length;
  sc.until(
    (s) =>
      sc.log.slice(from).some((e) => e.type === 'RELEASED' && e.actor.t === 'seat' && e.actor.seat === 0) &&
      s.pending[0]?.seat === 0 &&
      s.pending[0]?.kind === 'TURN_MENU',
  );
}

/**
 * 只记 0 号的棋盘调用：placeActor / walk 的格，舞台 syncWorld 时 0 号所在的格与是否关着（['confined', 事件, 布尔]），
 * 舞台 walkOut（['walkOut', 从哪里出来]）
 */
async function playAll(samples: Sample[], seat: SeatIndex = 0, me: SeatIndex | null = 0): Promise<Call[]> {
  const calls: Call[] = [];
  for (const s of samples) {
    const stageCalls: StageCall[] = [];
    const clock = new AnimClock();
    clock.instant = true;
    const v = s.before;
    const rec =
      (name: string, ret?: unknown) =>
      (...a: unknown[]) => {
        if (a[0] === seat) calls.push([name, ...a.slice(1).filter((x) => !(x instanceof AbortSignal))]);
        return ret;
      };
    const board: BoardPort & { stage: unknown } = {
      ready: true,
      syncView: () => {},
      walk: rec('walk', Promise.resolve()) as BoardPort['walk'],
      placeActor: rec('placeActor'),
      hop: () => Promise.resolve(),
      setActorPose: () => {},
      setLot: () => {},
      focus: () => Promise.resolve(),
      follow: () => {},
      floatText: () => {},
      coinFlight: () => Promise.resolve(),
      plantFlag: () => Promise.resolve(),
      popBuilding: () => Promise.resolve(),
      pulseTile: () => {},
      shake: () => {},
      clearFx: () => {},
      stage: {
        ...recordingStage(stageCalls),
        syncWorld: (view: GameView) => {
          const p = view.players.find((x) => x.seat === seat);
          calls.push(['syncWorld', s.e.type, p?.node]);
          calls.push(['confined', s.e.type, p !== undefined && (p.st.jail !== 0 || p.st.hospital !== 0)]);
        },
        walkOut: (who: SeatIndex, from: string, o: { onShow?: () => void }) => {
          if (who === seat) calls.push(['walkOut', from]);
          o.onShow?.();
          return Promise.resolve();
        },
      },
    };
    const ctx: PresentationContext = {
      signal: new AbortController().signal,
      wait: (ms) => clock.wait(ms),
      board,
      ui: createUiPresenter({ wait: (ms, sig) => clock.wait(ms, sig) }),
      audio: { play: () => {} },
      me,
      role: me === null ? 'spectator' : 'player',
      view: () => v,
      map,
      names: makeNames({ t: tx, view: () => v, map: () => map }),
      t: tx,
    };
    const h = RAW_HANDLERS[s.e.type] as unknown as (x: GameEvent, c: PresentationContext) => Promise<void>;
    await h(s.e, ctx);
  }
  return calls;
}

function typesOf(samples: Sample[]): string[] {
  return samples.map((s) => s.e.type);
}

/**
 * 被关之后、获释之前，舞台每次同步看到的都是关押状态（人在景观里，棋子不画）；RELEASED 先从景观走出来（walkOut），
 * 出现那一刻（onShow）才同步成获释后的状态；走回棋盘（RETURNED）不再有舞台演出
 */
function expectWalkOut(calls: Call[], from: 'jail' | 'hospital'): void {
  const first = calls.findIndex((c) => c[0] === 'confined' && c[1] === 'CONFINED' && c[2] === true);
  const out = calls.findIndex((c) => c[0] === 'walkOut');
  expect(first).toBeGreaterThanOrEqual(0);
  expect(calls[out]).toEqual(['walkOut', from]);
  expect(calls.filter((c) => c[0] === 'walkOut')).toHaveLength(1);
  const between = calls.slice(first, out).filter((c) => c[0] === 'confined');
  expect(between.every((c) => c[2] === true)).toBe(true);
  const after = calls.slice(out).filter((c) => c[0] === 'confined');
  expect(after[0]).toEqual(['confined', 'RELEASED', false]);
  expect(after.every((c) => c[2] === false)).toBe(true);
}

describe('获释后棋子留在关押格（真实引擎 × handler）', () => {
  it('台湾式监狱：坐牢 → 获释 → 走回棋盘都在关押格 26，从不放到保释格 16；下一次从 26 沿支线走出来', async () => {
    const sc = scenario({ map: MAP_ID, registry, players: ['human', 'human'] }).untilMenu(0);
    const tape = new Tape(sc);
    tape.run((x) => {
      x.stackDeck('fate', [33]).teleport(0, 12, 11).force('dice', 1).roll(0);
      untilReleasedMenu(x);
    });
    const types = typesOf(tape.samples);
    expect(types).toEqual(expect.arrayContaining(['CONFINED', 'RELEASED', 'RETURNED']));
    expect(tape.latest.players[0]).toMatchObject({ node: JAIL_HOLD, prevNode: JAIL_HOLD });

    const calls = await playAll(tape.samples);
    // 被关时搬到关押格；获释时舞台同步到的仍是关押格；走回棋盘放在关押格
    expect(calls).toContainEqual(['placeActor', JAIL_HOLD]);
    expect(calls).toContainEqual(['syncWorld', 'RELEASED', JAIL_HOLD]);
    const afterConfine = calls.slice(calls.findIndex((c) => c[0] === 'syncWorld' && c[1] === 'CONFINED'));
    expect(afterConfine.filter((c) => c[0] === 'placeActor')).toEqual(
      afterConfine.filter((c) => c[0] === 'placeActor').map(() => ['placeActor', JAIL_HOLD]),
    );
    expect(calls).toContainEqual(['placeActor', JAIL_HOLD]);
    expect(calls.some((c) => c[0] !== 'walk' && c.includes(JAIL_GATE))).toBe(false);
    expectWalkOut(calls, 'jail');
    // 观战者看到的是同一套
    expect(await playAll(tape.samples, 0, null)).toEqual(calls);

    // 下一回合掷 2 点：26 → 25 → 16（棋子从关押格起步）
    const next = new Tape(sc);
    next.run((x) => x.force('dice', 2).roll(0));
    const walk = (await playAll(next.samples)).find((c) => c[0] === 'walk');
    expect(walk).toEqual(['walk', [JAIL_HOLD, 25, JAIL_GATE]]);
  });

  it('环路式医院 20：获释后 node = prevNode = 20，走回棋盘放在 20；fork 0 / 1 两个方向都可能', async () => {
    for (const [fork, to] of [
      [0, 19],
      [1, 21],
    ] as const) {
      const sc = scenario({ map: MAP_ID, registry, players: ['human', 'human'] }).untilMenu(0);
      const tape = new Tape(sc);
      tape.run((x) => {
        x.stackDeck('fate', [12]).teleport(0, 12, 11).force('dice', 1).roll(0);
        untilReleasedMenu(x);
      });
      expect(tape.latest.players[0]).toMatchObject({ node: HOSPITAL_HOLD, prevNode: HOSPITAL_HOLD });
      const calls = await playAll(tape.samples);
      expect(calls).toContainEqual(['syncWorld', 'RELEASED', HOSPITAL_HOLD]);
      expect(calls.filter((c) => c[0] === 'placeActor').at(-1)).toEqual(['placeActor', HOSPITAL_HOLD]);
      expectWalkOut(calls, 'hospital');

      const next = new Tape(sc);
      next.run((x) => x.force('fork', fork).force('dice', 1).roll(0));
      const walk = (await playAll(next.samples)).find((c) => c[0] === 'walk');
      expect(walk).toEqual(['walk', [HOSPITAL_HOLD, to]]);
    }
  });
});

describe('关押期间不画、获释从景观走出来（真实引擎 × 原版舞台：假棋盘 + 真 OrigStage，事件前后同步同 wrap）', () => {
  it('被关之后一直在景观里——包括获释那一回合 TURN_STARTED 已清计数之后；RELEASED 从景观走出来，之后在格上', async () => {
    for (const fate of [33, 12]) {
      const sc = scenario({ map: MAP_ID, registry, players: ['human', 'human'] }).untilMenu(0);
      const tape = new Tape(sc);
      tape.run((x) => {
        x.stackDeck('fate', [fate]).teleport(0, 12, 11).force('dice', 1).roll(0);
        untilReleasedMenu(x);
      });
      const bench = new StageBench({ profile: 'original', flics: null, map });
      const a = bench.fake.actors.get(0)!;
      const seen: [string, boolean][] = [];
      for (const s of tape.samples) {
        await bench.run(s.e, s.before);
        seen.push([s.e.type, a.inside !== null]);
      }
      const confined = seen.findIndex(([t, inside]) => t === 'CONFINED' && inside);
      const released = seen.findIndex(([t]) => t === 'RELEASED');
      expect(confined, `fate ${fate}`).toBeGreaterThanOrEqual(0);
      expect(released).toBeGreaterThan(confined);
      // 被关之后到获释之前（含受阻的回合、获释那一回合的 TURN_STARTED）：一直在景观里、不画
      expect(seen.slice(confined, released).every(([, inside]) => inside)).toBe(true);
      expect(seen[released - 1]![0]).toBe('TURN_STARTED');
      // 走出来一次（起点在景观里，按原版 tick 匀速、过半出现），之后在格上
      expect(a.walks.filter((w) => w.kind === 'out')).toHaveLength(1);
      expect(seen.slice(released).every(([, inside]) => !inside)).toBe(true);
    }
  });
});
