// 监狱 / 医院获释后的棋子位置（VERIFY V-M7，exe v2.06 0x40d184：获释不换节点）：真实引擎在 fixture 'test-industries' 上
// 坐牢 / 住院到获释，事件按座位视角投影后逐个交给 handler（记录调用的假棋盘与假舞台）：
// - 台湾式监狱：关押格 26 在支线尽头、保释格 16 在环路上（16→25 封路）。获释（RELEASED）与走回棋盘（RETURNED）时棋子都留在 26，
//   从不放到 16；下一次掷骰从 26 沿支线走出来（walk 的路径以 26 开头）。
// - 环路式医院：关押格 = 保释格 20，获释后来路 = 20，第一步两个方向都可能。
import { buildFixtureMaps, buildTestMapIndustries, createRegistry, TABLES } from '@rich4/shared/data';
import type { GameEvent, SeatIndex } from '@rich4/shared/engine';
import { type Scenario, scenario } from '@rich4/shared/engine-testing';
import type { GameView } from '@rich4/shared/view';
import { beforeAll, describe, expect, it } from 'vitest';
import { AnimClock } from '../../game/anim/AnimClock';
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

/** 只记 0 号的棋盘调用：placeActor / walk 的格，舞台 syncWorld 时 0 号所在的格 */
async function playAll(samples: Sample[], seat: SeatIndex = 0): Promise<Call[]> {
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
          calls.push(['syncWorld', s.e.type, view.players.find((p) => p.seat === seat)?.node]);
        },
      },
    };
    const ctx: PresentationContext = {
      signal: new AbortController().signal,
      wait: (ms) => clock.wait(ms),
      board,
      ui: createUiPresenter({ wait: (ms, sig) => clock.wait(ms, sig) }),
      audio: { play: () => {} },
      me: 0,
      role: 'player',
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

      const next = new Tape(sc);
      next.run((x) => x.force('fork', fork).force('dice', 1).roll(0));
      const walk = (await playAll(next.samples)).find((c) => c[0] === 'walk');
      expect(walk).toEqual(['walk', [HOSPITAL_HOLD, to]]);
    }
  });
});
