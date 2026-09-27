// 对局显示态（design/client.md §10.1，按 architecture §14 修订）：
// - view：按播放进度提交的显示态（HUD 读它）；latest：最新收到的权威 view（批尾对账 / 调试用）；
// - pending / decision：只在一批动画播完后（批尾）才提交，保证「动画播完才弹决策框」；
// - submitting：已发出 intent、等待 ack 或下一批的决策 id（按钮锁定）。

import type { GameEvent } from '@rich4/shared/engine';
import type { BatchCause, GameOverMsg, YourDecision } from '@rich4/shared/net';
import type { GameView, PendingView } from '@rich4/shared/view';
import { create } from 'zustand';

/** 日志行的来源：界面语言切换时按新语言重新格式化（原版皮肤 U5：日志一律繁体，包括判定完成之前的开局事件） */
export interface LogSource {
  event: GameEvent;
  /** 提交该事件时的显示态（名字按当时的角色；与之后的显示态结构共享） */
  view: GameView;
}

export interface LogLine {
  id: number;
  seq: number;
  type: GameEvent['type'];
  text: string;
  /** 游戏日期（DateNum） */
  date: number;
  src?: LogSource;
}

export const LOG_LIMIT = 200;

export interface AnimState {
  playing: boolean;
  backlogMs: number;
  speed: number;
  instant: boolean;
}

export interface GameStoreState {
  epoch: number | null;
  seq: number;
  view: GameView | null;
  latest: GameView | null;
  pending: PendingView[];
  decision: YourDecision | null;
  submitting: string | null;
  anim: AnimState;
  log: LogLine[];
  over: GameOverMsg | null;
  lastCause: BatchCause | null;
  /** 批尾提交的次数（测试用来等待「一批播完」） */
  batchCount: number;
  resetTo(s: {
    epoch: number;
    seq: number;
    view: GameView;
    pending: PendingView[];
    decision: YourDecision | null;
  }): void;
  /** 一批开始播放：收起过时的决策与等待条（批尾再提交新的） */
  /** 一批开始播放时收起过时的决策与等待条；next 与当前决策是同一座位重发的同种决策时保留（见 REISSUED_KINDS） */
  beginBatch(next?: YourDecision | null): void;
  commitView(view: GameView): void;
  commitBatch(b: {
    epoch: number;
    seq: number;
    view: GameView;
    pending: PendingView[];
    decision: YourDecision | null;
    cause: BatchCause | null;
  }): void;
  commitPending(pending: PendingView[], decision: YourDecision | null): void;
  setLatest(view: GameView, seq: number): void;
  setAnim(a: AnimState): void;
  pushLog(lines: Omit<LogLine, 'id'>[]): void;
  /** 按当前语言重排带来源的日志行（format 返回 null 时保留原文） */
  relocalizeLog(format: (src: LogSource) => string | null): void;
  setSubmitting(id: string | null): void;
  setOver(o: GameOverMsg | null): void;
  clear(): void;
}

let logId = 0;

/**
 * 做完一笔非终结操作后引擎以新 decisionId 重发的决策种类（回合菜单的股票 / 卡片 / 道具 / 公布栏，商店每笔交易，拍卖出价）。
 * 播放这批结果期间保留旧决策框（已提交、锁定），批尾换成新决策，组件与子页不必卸载重建。
 */
const REISSUED_KINDS: ReadonlySet<string> = new Set(['TURN_MENU', 'SHOP', 'AUCTION_BID']);

function isReissue(cur: YourDecision, next: YourDecision): boolean {
  return cur.seat === next.seat && cur.kind === next.kind && REISSUED_KINDS.has(cur.kind);
}

const initial = {
  epoch: null,
  seq: 0,
  view: null,
  latest: null,
  pending: [] as PendingView[],
  decision: null,
  submitting: null,
  anim: { playing: false, backlogMs: 0, speed: 1, instant: false },
  log: [] as LogLine[],
  over: null,
  lastCause: null,
  batchCount: 0,
};

/** 新决策与正在提交的不同时解锁 */
function nextSubmitting(cur: string | null, decision: YourDecision | null): string | null {
  if (cur === null) return null;
  return decision && decision.decisionId === cur ? cur : null;
}

export const useGameStore = create<GameStoreState>()((set, get) => ({
  ...initial,
  resetTo: (s) =>
    set({
      epoch: s.epoch,
      seq: s.seq,
      view: s.view,
      latest: s.view,
      pending: s.pending,
      decision: s.decision,
      submitting: nextSubmitting(get().submitting, s.decision),
      over: get().epoch === s.epoch ? get().over : null,
    }),
  beginBatch: (next = null) => {
    const s = get();
    if (s.decision !== null && next !== null && isReissue(s.decision, next)) return;
    if (s.decision !== null || s.pending.length > 0) set({ decision: null, pending: [] });
  },
  commitView: (view) => set({ view }),
  commitBatch: (b) =>
    set((st) => ({
      epoch: b.epoch,
      seq: b.seq,
      view: b.view,
      pending: b.pending,
      decision: b.decision,
      lastCause: b.cause,
      submitting: nextSubmitting(st.submitting, b.decision),
      batchCount: st.batchCount + 1,
    })),
  commitPending: (pending, decision) =>
    set((st) => ({ pending, decision, submitting: nextSubmitting(st.submitting, decision) })),
  setLatest: (latest, _seq) => set({ latest }),
  setAnim: (anim) => {
    const a = get().anim;
    if (
      a.playing === anim.playing &&
      a.backlogMs === anim.backlogMs &&
      a.speed === anim.speed &&
      a.instant === anim.instant
    )
      return;
    set({ anim });
  },
  pushLog: (lines) => {
    if (lines.length === 0) return;
    const add = lines.map((l) => ({ ...l, id: ++logId }));
    set((st) => ({ log: [...st.log, ...add].slice(-LOG_LIMIT) }));
  },
  relocalizeLog: (format) => {
    set((st) => {
      let changed = false;
      const log = st.log.map((l) => {
        if (!l.src) return l;
        const text = format(l.src);
        if (text === null || text === l.text) return l;
        changed = true;
        return { ...l, text };
      });
      return changed ? { log } : {};
    });
  },
  setSubmitting: (submitting) => set({ submitting }),
  setOver: (over) => set({ over }),
  clear: () => set({ ...initial, log: [] }),
}));

/** 本人（座位）在显示态里的玩家 */
export function playerOf(view: GameView | null, seat: number | null) {
  if (!view || seat === null) return null;
  return view.players.find((p) => p.seat === seat) ?? null;
}

/** 当前行动者座位（游标指向座位时） */
export function currentSeat(view: GameView | null): number | null {
  const c = view?.clock.cursor;
  return c && c.t === 'seat' ? c.seat : null;
}
