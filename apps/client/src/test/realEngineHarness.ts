// 测试用（只在单测里使用）：真实引擎事件样本 × handler 的播放台架（presentation/handlers 的 realEngine.test.ts、
// realEngineM7.test.ts 共用）。
// - collect*：推进真实引擎，按座位视角投影出事件，每个样本带提交前的显示态；
// - play：在 1x 假时钟下运行未封顶的 handler，接计时舞台（game/fx/timings 的真实特效时长），返回自然用时与产生的全部文案
//   （日志行、toast、横幅、飘字、气泡、弹窗与竞价横幅）；
// - BAD_TEXT：文案里不该出现的东西（undefined / NaN / 残留插值 / 未命中的 i18n 键）。
import { makeAiContext, OriginalAiPolicy } from '@rich4/shared/ai';
import type { MapIndex } from '@rich4/shared/data';
import type { GameAction, GameEvent, GameState } from '@rich4/shared/engine';
import { decisionForSeat, simpleView } from '@rich4/shared/engine-testing';
import {
  applyPostPatch,
  type DecisionForYou,
  type GameView,
  projectEvent,
  projectState,
  STEP_MS,
  type Viewer,
} from '@rich4/shared/view';
import { AnimClock } from '../game/anim/AnimClock';
import { COIN_FLIGHT_MS, FLAG_MS, HOP_MS, POP_MS } from '../game/fx/timings';
import { tx } from '../i18n/tx';
import { BUDGET_TOLERANCE } from '../presentation/EventPlayer';
import { RAW_HANDLERS } from '../presentation/handlers';
import { budgetMs } from '../presentation/handlers/budget';
import { recordingStage, type StageCall } from '../presentation/handlers/testStage';
import { formatEvent } from '../presentation/logFormat';
import { makeNames } from '../presentation/names';
import type { BoardPort, PresentationContext, UiPort } from '../presentation/types';
import { createUiPresenter } from '../presentation/UiPresenter';
import { usePopupStore } from '../ui/popups/popupStore';

export interface Sample {
  e: GameEvent;
  /** 事件提交之前的显示态 */
  before: GameView;
}

export const VIEWER: Viewer = { kind: 'seat', seat: 0 };
const VIS = { handVisibility: 'public' as const };

/** 引擎的一次 applyAction 结果 → 样本（按 VIEWER 投影；view 从 before 起折叠，批尾以权威投影为准） */
export function samplesOf(
  events: readonly GameEvent[],
  before: GameView,
  after: GameState,
  keep: (e: GameEvent) => boolean = () => true,
): { samples: Sample[]; view: GameView } {
  const out: Sample[] = [];
  let view = before;
  for (const raw of events) {
    const e = projectEvent(raw, VIEWER, VIS);
    if (e.type !== 'TIME_REWOUND' && keep(e)) out.push({ e, before: view });
    if (e.post) view = applyPostPatch(view, e.post);
  }
  return { samples: out, view: projectState(after, VIEWER, VIS) };
}

export function viewOf(s: GameState): GameView {
  return projectState(s, VIEWER, VIS);
}

/** 原版 AI 对 s.pending[0] 的回答（不合法时退回 defaultIntent，与服务器的兜底一致） */
export function aiAction(s: GameState, map: MapIndex, index = 0): GameAction | null {
  const d = s.pending[index];
  if (!d) return null;
  const p = s.players.find((x) => x.seat === d.seat);
  if (!p) return null;
  const ctx = makeAiContext({
    aiSeed: s.secret.aiSeed,
    seat: d.seat,
    decisionId: d.id,
    turnNo: s.clock.turnNo,
    traits: p.aiTraits,
    map,
    handVisibility: 'public',
  });
  const intent = OriginalAiPolicy.decide(simpleView(s) as GameView, decisionForSeat(d) as DecisionForYou, ctx);
  return { ...intent, seat: d.seat, decisionId: d.id } as GameAction;
}

export function defaultAction(s: GameState, index = 0): GameAction | null {
  const d = s.pending[index];
  return d ? ({ ...d.defaultIntent, seat: d.seat, decisionId: d.id } as GameAction) : null;
}

// ───────────────────────── 计时假棋盘 / 记录文案 ─────────────────────────

interface Texts {
  lines: string[];
}

function timedBoard(clock: AnimClock, texts: Texts, stage: StageCall[]): BoardPort & { stage: unknown } {
  const noop = (): void => {};
  const wait = (ms: number) => (_a?: unknown, _b?: unknown, s?: unknown) =>
    clock.wait(ms, s instanceof AbortSignal ? s : undefined);
  return {
    ready: true,
    syncView: noop,
    walk: (_seat, path, signal) => clock.wait(Math.max(0, path.length - 1) * STEP_MS, signal),
    placeActor: noop,
    hop: (_s, signal) => clock.wait(HOP_MS, signal),
    setActorPose: noop,
    setLot: noop,
    focus: (_a, ms, signal) => clock.wait(ms, signal),
    follow: noop,
    floatText: (_at, text) => {
      texts.lines.push(text);
    },
    coinFlight: wait(COIN_FLIGHT_MS),
    plantFlag: wait(FLAG_MS),
    popBuilding: (_l, signal) => clock.wait(POP_MS, signal),
    pulseTile: noop,
    shake: noop,
    clearFx: noop,
    stage: recordingStage(stage, clock),
  };
}

function recordingUi(clock: AnimClock, texts: Texts): UiPort {
  const real = createUiPresenter({ wait: (ms, sig) => clock.wait(ms, sig) });
  return {
    ...real,
    toast: (text, kind) => {
      texts.lines.push(text);
      real.toast(text, kind);
    },
    banner: (b, ms, signal) => {
      texts.lines.push(b.title, b.subtitle ?? '');
      return real.banner(b, ms, signal);
    },
  };
}

/** 文案里不该出现的东西：undefined / NaN / 残留插值 / 未命中的 i18n 键（命名空间:键） */
export const BAD_TEXT =
  /undefined|NaN|\{\{|\[object|\b(?:events|gods|items|cards|hud|magic|news|fate|tiles|characters|ui|game):[A-Za-z0-9]/;

function strings(x: unknown, out: string[] = []): string[] {
  if (typeof x === 'string') out.push(x);
  else if (Array.isArray(x)) for (const v of x) strings(v, out);
  else if (x && typeof x === 'object') for (const v of Object.values(x)) strings(v, out);
  return out;
}

export interface Played {
  /** 自然用时（1x 毫秒） */
  used: number;
  /** 产生的全部文案（日志行不在内） */
  texts: string[];
  /** 打开过的弹窗 / 竞价横幅（按打开顺序） */
  popups: unknown[];
}

/** 在 1x 假时钟下运行 handler（接计时舞台、不经封顶包装），返回用时与产生的全部文案 */
export async function play(sample: Sample, map: MapIndex): Promise<Played> {
  const clock = new AnimClock();
  const signal = new AbortController().signal;
  const texts: Texts = { lines: [] };
  const stage: StageCall[] = [];
  const popups: unknown[] = [];
  const off = usePopupStore.subscribe((st) => {
    if (st.current && popups.at(-1) !== st.current) popups.push(st.current);
    if (st.auction && popups.at(-1) !== st.auction) popups.push(st.auction);
  });
  const v = sample.before;
  const ctx: PresentationContext = {
    signal,
    wait: (ms) => clock.wait(ms, signal),
    board: timedBoard(clock, texts, stage),
    ui: recordingUi(clock, texts),
    audio: { play: () => {} },
    me: 0,
    role: 'player',
    view: () => v,
    map,
    names: makeNames({ t: tx, view: () => v, map: () => map }),
    t: tx,
  };
  const h = RAW_HANDLERS[sample.e.type] as unknown as (x: GameEvent, c: PresentationContext) => Promise<void>;
  let done = false;
  let err: unknown = null;
  const p = h(sample.e, ctx).then(
    () => {
      done = true;
    },
    (x: unknown) => {
      done = true;
      err = x;
    },
  );
  const t0 = clock.now();
  for (let i = 0; i < 3000 && !done; i++) {
    clock.advance(16);
    for (let k = 0; k < 4; k++) await Promise.resolve();
  }
  await p;
  off();
  if (err) throw err;
  const all = [...texts.lines, ...strings(popups)];
  for (const c of stage) if (c[0] === 'bubble' && typeof c[2] === 'string') all.push(c[2]);
  return { used: clock.now() - t0, texts: all, popups };
}

export function tagOf(e: GameEvent): string {
  return `${e.type} ${JSON.stringify({ ...e, post: undefined })}`;
}

/** 日志行：没有坏文案 */
export function logLine(s: Sample, map: MapIndex): string | null {
  return formatEvent(s.e, makeNames({ t: tx, view: () => s.before, map: () => map }));
}

/**
 * 逐个播放样本：不抛错、文案完整、自然用时 ≤ 预算（与 EventPlayer 同一容差）。返回超预算的描述与总用时。
 * 弹窗 / 竞价横幅在样本之间不清空（拍卖横幅跨事件累积，与真实播放相同）；需要隔离时调用方自己 clear。
 */
export async function playAll(
  samples: readonly Sample[],
  map: MapIndex,
  check: (tag: string, text: string) => void,
): Promise<{ over: string[]; total: number }> {
  const over: string[] = [];
  let total = 0;
  for (const s of samples) {
    const tag = tagOf(s.e);
    const r = await play(s, map).catch((x: unknown) => {
      throw new Error(`${tag}: ${String(x)}`);
    });
    for (const t of r.texts) check(tag, t);
    const line = logLine(s, map);
    if (line !== null) check(`log ${tag}`, line);
    total += r.used;
    // 与 EventPlayer / wrap 同一口径：当前演出节奏下的预算（handler 的节奏相关时长，如亮卡、掷骰，也按它取）
    const budget = budgetMs(s.e);
    if (r.used > budget * BUDGET_TOLERANCE + 50) over.push(`${tag}: ${r.used}ms > ${budget}ms`);
  }
  return { over, total };
}
