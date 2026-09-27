// 真实引擎载荷 × 前端演出（M6 整合）：原版 AI 在 test-allkinds 上自对弈（卡片、道具、神明、路面物件、关押、保释都会出现），
// 按座位 0 的视角投影出事件，逐个交给 handler：
// - 不抛错；日志行、toast、飘字、气泡、弹窗文案里没有 undefined / NaN / 残留的 {{…}} / 未命中的 i18n 键；
// - 接上计时舞台（按 game/fx/timings 的真实特效时长等待）时，未封顶的自然用时 ≤ EVENT_BUDGET_MS（同 EventPlayer 容差）。
// handler 按设计稿载荷开发、而引擎实际载荷不同（字段缺失、取值范围、事件顺序）时，这里会先失败。
import { makeAiContext, OriginalAiPolicy } from '@rich4/shared/ai';
import { fixtureRegistry } from '@rich4/shared/data';
import type { GameAction, GameEvent, GameState } from '@rich4/shared/engine';
import { decisionForSeat, newGame, simpleView } from '@rich4/shared/engine-testing';
import {
  applyPostPatch,
  type DecisionForYou,
  eventBudgetMs,
  type GameView,
  projectEvent,
  projectState,
  STEP_MS,
  type Viewer,
} from '@rich4/shared/view';
import { beforeAll, describe, expect, it } from 'vitest';
import { AnimClock } from '../../game/anim/AnimClock';
import { COIN_FLIGHT_MS, FLAG_MS, HOP_MS, POP_MS } from '../../game/fx/timings';
import { initI18n } from '../../i18n';
import { tx } from '../../i18n/tx';
import { usePopupStore } from '../../ui/popups/popupStore';
import { BUDGET_TOLERANCE } from '../EventPlayer';
import { formatEvent } from '../logFormat';
import { makeNames } from '../names';
import type { BoardPort, PresentationContext, UiPort } from '../types';
import { createUiPresenter } from '../UiPresenter';
import { RAW_HANDLERS } from '.';
import { recordingStage, type StageCall } from './testStage';

beforeAll(() => {
  initI18n('original');
});

const MAP_ID = 'test-allkinds';
const map = fixtureRegistry.getMap(MAP_ID);
const viewer: Viewer = { kind: 'seat', seat: 0 };
const vis = { handVisibility: 'public' as const };

/** 本测试关注的 M6 事件（其余类型也会跑，但每种只抽前几条） */
const M6_TYPES = new Set<string>([
  'CARD_USED',
  'CARD_NO_EFFECT',
  'PASSIVE',
  'ITEM_USED',
  'VEHICLE',
  'VEHICLE_DESTROYED',
  'OBJECT_PLACED',
  'OBJECT_REMOVED',
  'DOLL_WALK',
  'BOMB_ATTACHED',
  'BOMB_TRANSFERRED',
  'BOMB_EXPLODED',
  'STRIKE',
  'TELEPORTED',
  'GOD_ATTACHED',
  'GOD_POWER',
  'GOD_LEFT',
  'GOD_SPAWNED',
  'GOD_MANIFEST',
  'DOG_BITE',
  'DOG_KNOCKED',
  'DEATH_GOD_SUMMONED',
  'CONFINED',
  'RELEASED',
  'BAIL',
  'BLESSING',
  'STATUS_SET',
  'ALLIANCE_FORMED',
  'ALLIANCE_BROKEN',
  'ALLIANCE_EXPIRED',
  'BEGGAR_ALMS',
  'CARD_GAINED',
  'CARD_LOST',
  'ITEM_GAINED',
  'ITEM_LOST',
  'LOT_LEVEL',
  'LOT_MUTATED',
  'MONEY',
  'TOLL_PAID',
  'TOLL_EXEMPT',
  'STOCK_FLAG',
  'MARK_SET',
  'OBJECTS_RESPAWNED',
  'BANKRUPT',
]);
/** 每种 M6 事件最多测多少条（载荷多样性）；其他事件每种只测前 3 条 */
const PER_TYPE = 40;
const PER_OTHER = 3;

interface Sample {
  e: GameEvent;
  /** 事件提交之前的显示态 */
  before: GameView;
}

/** 原版 AI 自对弈一局，按座位 0 的视角收集事件样本（每个事件带提交前的显示态） */
function collect(seed: number, maxActions: number, out: Sample[], counts: Map<string, number>): void {
  const g = newGame({
    players: ['ai', 'ai', 'ai', 'ai'],
    seed: (0xa11 + seed).toString(16),
    map: MAP_ID,
    config: { timeLimitDays: 365 },
    board: 'random',
  });
  let s: GameState = g.state;
  let view = projectState(s, viewer, vis);
  for (let n = 0; n < maxActions && s.status === 'playing'; n++) {
    const d = s.pending[0];
    if (!d) break;
    const p = s.players.find((x) => x.seat === d.seat);
    if (!p) break;
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
    let r: ReturnType<typeof g.engine.applyAction>;
    try {
      r = g.engine.applyAction(s, { ...intent, seat: d.seat, decisionId: d.id } as GameAction);
    } catch {
      r = g.engine.applyAction(s, { ...d.defaultIntent, seat: d.seat, decisionId: d.id } as GameAction);
    }
    for (const raw of r.events) {
      const e = projectEvent(raw, viewer, vis);
      const c = counts.get(e.type) ?? 0;
      counts.set(e.type, c + 1);
      const limit = M6_TYPES.has(e.type) ? PER_TYPE : PER_OTHER;
      if (c < limit && e.type !== 'TIME_REWOUND') out.push({ e, before: view });
      if (e.post) view = applyPostPatch(view, e.post);
    }
    s = r.state;
    // 批尾以权威投影为准（与 EventPlayer 一致）
    view = projectState(s, viewer, vis);
  }
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
const BAD_TEXT =
  /undefined|NaN|\{\{|\[object|\b(?:events|gods|items|cards|hud|magic|news|fate|tiles|characters|ui|game):[A-Za-z]/;

function strings(x: unknown, out: string[] = []): string[] {
  if (typeof x === 'string') out.push(x);
  else if (Array.isArray(x)) for (const v of x) strings(v, out);
  else if (x && typeof x === 'object') for (const v of Object.values(x)) strings(v, out);
  return out;
}

/** 在 1x 假时钟下运行 handler（接计时舞台、不经封顶包装），返回用时与产生的全部文案 */
async function play(sample: Sample): Promise<{ used: number; texts: string[] }> {
  const clock = new AnimClock();
  const signal = new AbortController().signal;
  const texts: Texts = { lines: [] };
  const stage: StageCall[] = [];
  const popups: unknown[] = [];
  const off = usePopupStore.subscribe((st) => {
    if (st.current) popups.push(st.current);
    if (st.auction) popups.push(st.auction);
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
  usePopupStore.getState().clear();
  if (err) throw err;
  const all = [...texts.lines, ...strings(popups)];
  for (const c of stage) if (c[0] === 'bubble' && typeof c[2] === 'string') all.push(c[2]);
  return { used: clock.now() - t0, texts: all };
}

describe('真实引擎事件 × handler（M6 载荷对齐）', () => {
  const samples: Sample[] = [];
  const counts = new Map<string, number>();

  // 单独运行约 3 秒；全量并行时 CPU 紧张，给足时间
  beforeAll(() => {
    for (const seed of [1, 2, 3]) collect(seed, 2500, samples, counts);
  }, 120_000);

  it('自对弈覆盖到主要的对抗事件', () => {
    if (process.env.RICH4_DEBUG_COUNTS) console.log([...counts].sort((a, b) => b[1] - a[1]));
    for (const t of ['CARD_USED', 'ITEM_USED', 'OBJECT_PLACED', 'GOD_ATTACHED', 'GOD_SPAWNED', 'CONFINED']) {
      expect(counts.get(t) ?? 0, t).toBeGreaterThan(0);
    }
  });

  it('日志行完整（formatEvent 对每个样本）', () => {
    const names = (v: GameView) => makeNames({ t: tx, view: () => v, map: () => map });
    for (const s of samples) {
      const line = formatEvent(s.e, names(s.before));
      if (line === null) continue;
      expect(line, `${s.e.type} ${JSON.stringify({ ...s.e, post: undefined })}`).not.toMatch(BAD_TEXT);
    }
  });

  it('handler 不抛错、文案完整、自然用时 ≤ 预算', { timeout: 120_000 }, async () => {
    const over: string[] = [];
    let total = 0;
    for (const s of samples) {
      const tag = `${s.e.type} ${JSON.stringify({ ...s.e, post: undefined })}`;
      const r = await play(s).catch((x: unknown) => {
        throw new Error(`${tag}: ${String(x)}`);
      });
      for (const t of r.texts) expect(t, tag).not.toMatch(BAD_TEXT);
      total += r.used;
      const budget = eventBudgetMs(s.e);
      if (r.used > budget * BUDGET_TOLERANCE + 50) over.push(`${tag}: ${r.used}ms > ${budget}ms`);
    }
    expect(over).toEqual([]);
    expect(samples.length).toBeGreaterThan(100);
    // 编排确实在跑（不是空转通过）：M6 样本的总用时应有数十秒
    if (process.env.RICH4_DEBUG_COUNTS) console.log({ samples: samples.length, total });
    expect(total).toBeGreaterThan(samples.length * 300);
  });
});
