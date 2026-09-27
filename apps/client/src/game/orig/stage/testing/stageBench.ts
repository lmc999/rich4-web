// 测试用（client-unit）：在 1x 假时钟下用真的 OrigStage（假棋盘 + 合成 FLIC）跑未封顶的 handler，量「自然用时」。
// 与 handler 包装（wrap.ts）同一顺序：事件前 syncWorld + beginEvent（事件、当前节奏的预算、ctx.audio），事件后按 post 同步；
// 棋盘端口按真实特效时长等待（行走、镜头、跳一下、金币、插旗、升级）；开局跳伞的 hop 按棋盘伞 FLIC 的 playFit 计划等待。
import type { MapIndex } from '@rich4/shared/data';
import type { GameEvent, SeatIndex } from '@rich4/shared/engine';
import {
  applyPostPatch,
  eventBudgetMs,
  type GameView,
  PACING_PROFILES,
  PARACHUTE_FLICS,
  type PacingProfile,
  STEP_MS,
} from '@rich4/shared/view';
import { tx } from '../../../../i18n/tx';
import { RAW_HANDLERS } from '../../../../presentation/handlers';
import { setPacingOverride } from '../../../../presentation/handlers/budget';
import { touchesStage } from '../../../../presentation/handlers/wrap';
import { makeNames } from '../../../../presentation/names';
import type { BoardPort, PresentationContext } from '../../../../presentation/types';
import { createUiPresenter } from '../../../../presentation/UiPresenter';
import { AnimClock } from '../../../anim/AnimClock';
import { COIN_FLIGHT_MS, FLAG_MS, HOP_MS, POP_MS } from '../../../fx/timings';
import { PARACHUTE_FIT_MS } from '../../OrigActor';
import { planFlic } from '../flicPlan';
import type { FakeFlicPack } from './fakeFlics';
import { createFakeStage, type FakeStage } from './fakeStageHost';

export { PACING_PROFILES };

export interface BenchResult {
  /** 自然用时（1x 时钟毫秒） */
  used: number;
  /** 当前节奏下的预算 */
  budget: number;
}

export interface StageBenchOptions {
  profile: PacingProfile;
  /** 合成 FLIC（null = 没有 FLIC） */
  flics: FakeFlicPack | null;
  map?: MapIndex | null;
  me?: SeatIndex | null;
  /** 地图节日表（HOLIDAY 的 FLIC 按它判定） */
  holidays?: { slot: number; flagsRaw: number }[];
}

export class StageBench {
  readonly clock = new AnimClock();
  readonly fake: FakeStage;
  private readonly board: BoardPort & { stage: FakeStage['stage'] };

  constructor(private readonly o: StageBenchOptions) {
    this.fake = createFakeStage({
      clock: this.clock,
      flics: o.flics,
      ...(o.holidays ? { holidays: o.holidays } : {}),
    });
    const clock = this.clock;
    const stage = this.fake.stage;
    const noop = (): void => {};
    const wait = (ms: number) => (_a?: unknown, _b?: unknown, s?: unknown) =>
      clock.wait(ms, s instanceof AbortSignal ? s : undefined);
    this.board = {
      ready: true,
      syncView: noop,
      walk: (_seat, path, signal) => clock.wait(Math.max(0, path.length - 1) * STEP_MS, signal),
      placeActor: noop,
      // 开局跳伞：原版棋盘伞 FLIC 按可用时长 playFit（OrigActor.drop）
      hop: (seat, signal) => {
        const ev = stage.currentEvent;
        if (ev?.type !== 'PARACHUTE') return clock.wait(HOP_MS, signal);
        const t = PARACHUTE_FLICS[this.fake.host.characterOf(seat) ?? 0]!;
        return clock.wait(planFlic(t, stage.parachuteFitMs(PARACHUTE_FIT_MS)).durationMs, signal);
      },
      setActorPose: noop,
      setLot: noop,
      focus: (_a, ms, signal) => clock.wait(ms, signal),
      follow: noop,
      floatText: noop,
      coinFlight: wait(COIN_FLIGHT_MS),
      plantFlag: wait(FLAG_MS),
      popBuilding: (_l, signal) => clock.wait(POP_MS, signal),
      pulseTile: noop,
      shake: noop,
      clearFx: () => this.fake.fx.clear(),
      stage,
    };
  }

  /** 播一个事件（未封顶），返回自然用时 */
  async run(e: GameEvent, view: GameView): Promise<BenchResult> {
    const { clock, fake } = this;
    const budget = eventBudgetMs(e, this.o.profile);
    setPacingOverride(this.o.profile);
    const signal = new AbortController().signal;
    const map = this.o.map ?? null;
    const ctx: PresentationContext = {
      signal,
      wait: (ms) => clock.wait(ms, signal),
      board: this.board,
      ui: createUiPresenter({ wait: (ms, s) => clock.wait(ms, s) }),
      audio: fake.audio,
      me: this.o.me === undefined ? 0 : this.o.me,
      role: 'player',
      view: () => view,
      map,
      names: makeNames({ t: tx, view: () => view, map: () => map }),
      t: tx,
    };
    fake.stage.syncWorld(view);
    fake.stage.beginEvent(e, { audio: fake.audio, budgetMs: budget });
    const h = RAW_HANDLERS[e.type] as unknown as (x: GameEvent, c: PresentationContext) => Promise<void>;
    let done = false;
    let err: unknown = null;
    const p = h(e, ctx).then(
      () => {
        done = true;
      },
      (x: unknown) => {
        done = true;
        err = x;
      },
    );
    const t0 = clock.now();
    for (let i = 0; i < 4000 && !done; i++) {
      clock.advance(16);
      for (let k = 0; k < 6; k++) await Promise.resolve();
    }
    await p;
    if (err) throw err;
    const used = clock.now() - t0;
    if (touchesStage(e.post)) fake.stage.syncWorld(applyPostPatch(view, e.post!));
    // 不阻塞的尾巴（终局烟火、离场动画）落定，免得带进下一个事件
    for (let i = 0; i < 400 && fake.fx.count > 0; i++) {
      clock.advance(16);
      for (let k = 0; k < 6; k++) await Promise.resolve();
    }
    return { used, budget };
  }
}
