// 测试用：真实引擎自对弈，按观察者投影出快照与逐批 GameBatchMsg（与 GameRunner.composeBatch 同一组投影函数）。
// 只在测试里使用 engine-testing（architecture §3：测试文件不受前端分层限制）。

import type { Controller, GameState } from '@rich4/shared/engine';
import { intentRng, newGame, randomAction } from '@rich4/shared/engine-testing';
import type { GameBatchMsg } from '@rich4/shared/net';
import {
  estimateAnimMs,
  type GameView,
  type HandVisibility,
  type PendingView,
  projectEvent,
  projectState,
  type Viewer,
} from '@rich4/shared/view';

export interface SelfPlay {
  initial: { epoch: number; seq: number; view: GameView; pending: PendingView[] };
  batches: GameBatchMsg[];
  final: GameState;
}

export interface SelfPlayOptions {
  seed: number;
  steps: number;
  viewer?: Viewer;
  handVisibility?: HandVisibility;
  players?: Controller[];
  map?: string;
  vehicle?: 'walk' | 'moto' | 'car';
}

function pendingViews(s: GameState): PendingView[] {
  return s.pending.map((d) => ({
    decisionId: d.id,
    seat: d.seat,
    kind: d.kind,
    timing: d.timing,
    deadlineAt: null,
    control: 'human',
    publicInfo: d.publicInfo,
  }));
}

export function selfPlay(o: SelfPlayOptions): SelfPlay {
  const viewer: Viewer = o.viewer ?? { kind: 'seat', seat: 0 };
  const vis = { handVisibility: o.handVisibility ?? 'public' };
  const g = newGame({
    players: o.players ?? ['human', 'ai', 'human', 'ai'],
    seed: (0x5eed + o.seed).toString(16),
    map: o.map ?? 'test',
    config: { timeLimitDays: 0, vehicle: o.vehicle ?? (o.seed % 2 === 0 ? 'walk' : 'car') },
  });
  const rng = intentRng((0xc11e + o.seed).toString(16));
  let state = g.state;
  const initial = { epoch: 1, seq: 0, view: projectState(state, viewer, vis), pending: pendingViews(state) };
  const batches: GameBatchMsg[] = [];
  for (let i = 0; i < o.steps && state.status === 'playing'; i++) {
    const a = randomAction(state, rng);
    if (!a) break;
    const r = g.engine.applyAction(state, a);
    state = r.state;
    const events = r.events.map((e) => projectEvent(e, viewer, vis));
    const msg: GameBatchMsg = {
      epoch: 1,
      seq: i + 1,
      cause: { seat: 'seat' in a ? (a as { seat: 0 | 1 | 2 | 3 }).seat : null, intentType: a.type, by: 'player' },
      events,
      animMs: estimateAnimMs(r.events),
      view: projectState(state, viewer, vis),
      pending: pendingViews(state),
      serverNow: 0,
    };
    const mine = viewer.kind === 'seat' ? state.pending.find((d) => d.seat === viewer.seat) : undefined;
    if (mine) {
      msg.yourDecision = {
        decisionId: mine.id,
        seat: mine.seat,
        kind: mine.kind,
        timing: mine.timing,
        options: mine.options,
        defaultIntent: mine.defaultIntent,
        deadlineAt: null,
      };
    }
    batches.push(JSON.parse(JSON.stringify(msg)) as GameBatchMsg);
  }
  return { initial: JSON.parse(JSON.stringify(initial)) as SelfPlay['initial'], batches, final: state };
}
