/**
 * 按观察者投影（architecture §5.7；design/net.md §6.1）。
 *
 * - state.secret / flow / pending / counters 永不下发：GameView 用 WORLD_KEYS 白名单逐键拷贝，
 *   GameState 新增字段时编译期就会在这里报错，迫使作者决定它是否可以下发。
 * - 手牌可见性：public 模式所有人看到完整手牌；private 模式只有本人看到自己的 cards，其他人只有 cardCount。
 * - 事件脱敏的唯一依据是 EVENT_META[type].privacy；post.players[].set.cards 按同样规则改写并补 cardCount。
 * - 结果与 state 共享深层子对象（只做浅拷贝），调用方不得修改；需要可变副本时自行 structuredClone。
 */
import { EVENT_META, type GameEventOf, type RedactCardsEventType } from '../engine/types/events';
import type { CardId, GameEvent, PlayerPatch, PlayerState, PublicWorld, SeatIndex } from '../engine/types/index';
import type {
  GameView,
  PlayerView,
  ProjectEventFn,
  ProjectStateFn,
  Viewer,
  ViewerClassKeyFn,
  VisibilityOptions,
} from './types';

/** 可以下发的世界字段（players 另行投影）；对 PublicWorld 穷举 */
const WORLD_KEYS = {
  v: true,
  engine: true,
  dataRef: true,
  config: true,
  status: true,
  result: true,
  clock: true,
  econ: true,
  villains: true,
  lands: true,
  facilities: true,
  companies: true,
  objects: true,
  gods: true,
  beggars: true,
  stocks: true,
  pools: true,
  lottery: true,
  noticeBoard: true,
} as const satisfies { readonly [K in Exclude<keyof PublicWorld, 'players'>]: true };

type WorldKey = keyof typeof WORLD_KEYS;
const WORLD_KEY_LIST = Object.freeze(Object.keys(WORLD_KEYS) as WorldKey[]);

/** 观察者能否看到 seat 的完整手牌 */
export function canSeeCards(seat: SeatIndex, v: Viewer, o: VisibilityOptions): boolean {
  return o.handVisibility === 'public' || (v.kind === 'seat' && v.seat === seat);
}

export function projectPlayer(p: PlayerState, v: Viewer, o: VisibilityOptions): PlayerView {
  return { ...p, cards: canSeeCards(p.seat, v, o) ? [...p.cards] : null, cardCount: p.cards.length };
}

export const projectState: ProjectStateFn = (s, v, o) => {
  const world: Partial<Record<WorldKey, unknown>> = {};
  for (const k of WORLD_KEY_LIST) world[k] = s[k];
  return { ...(world as Omit<GameView, 'players'>), players: s.players.map((p) => projectPlayer(p, v, o)) };
};

function projectPlayerPatch(
  pp: { seat: SeatIndex; set: PlayerPatch },
  v: Viewer,
  o: VisibilityOptions,
): { seat: SeatIndex; set: PlayerPatch } {
  const cards = pp.set.cards;
  // 没有改动手牌，或上游已经改写过
  if (cards === undefined || cards === null) return pp;
  return {
    seat: pp.seat,
    set: { ...pp.set, cards: canSeeCards(pp.seat, v, o) ? cards : null, cardCount: cards.length },
  };
}

/** redactCards 类事件的载荷都带 seat 与 card（编译期断言） */
type RedactShape = { seat: SeatIndex; card: CardId | null };
const redactShapeOk: GameEventOf<RedactCardsEventType> extends RedactShape ? true : false = true;
void redactShapeOk;

export const projectEvent: ProjectEventFn = (e, v, o) => {
  let out: GameEvent = e;
  const players = e.post?.players;
  if (players?.some((pp) => pp.set.cards !== undefined && pp.set.cards !== null)) {
    out = { ...e, post: { ...e.post, players: players.map((pp) => projectPlayerPatch(pp, v, o)) } } as GameEvent;
  }
  if (o.handVisibility === 'private' && EVENT_META[e.type].privacy === 'redactCards') {
    const r = out as GameEvent & RedactShape;
    if (r.card !== null && !canSeeCards(r.seat, v, o)) out = { ...r, card: null } as GameEvent;
  }
  return out;
};

/** public 模式全员共用一个 key；private 模式每个座位一个 key，观战者共用一个 */
export const viewerClassKey: ViewerClassKeyFn = (v, o) => {
  if (o.handVisibility === 'public') return 'public';
  return v.kind === 'seat' ? `seat:${v.seat}` : 'spectator';
};
