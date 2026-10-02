/**
 * 按观察者投影（architecture §5.7；design/net.md §6.1）。
 *
 * - state.secret / flow / pending / counters 永不下发：GameView 用 WORLD_KEYS 白名单逐键拷贝，
 *   GameState 新增字段时编译期就会在这里报错，迫使作者决定它是否可以下发。
 * - 手牌可见性（卡片与道具同一规则，canSeeHand）：public 模式所有人看到完整手牌；private 模式（联机 ≥ 2 名真人时服务器
 *   开局锁定，net/room.ts effectiveHandVisibility）只有本人看到自己的 cards / items，其他座位与观战者只有
 *   cardCount / itemCount，pools（牌堆与共享道具库存的剩余数）整个为 null——每批前后的张数差能精确推出别人摸到、
 *   买到了哪张卡、哪种道具。
 * - 事件脱敏的唯一依据是 EVENT_META[type].privacy：redactHand 事件按 HAND_REDACTORS 逐类置 null；
 *   post.players[].set.cards / items 按同样规则改写并补 cardCount / itemCount，私密模式下去掉 post.pools。
 * - 本人决策的选项同样不能带出 pools：私密模式下 SHOP.items[].pool 只留有没有货（projectDecisionOptions）。
 * - 敌意值 hostility 与手牌同一规则（hideHostility）：私密模式下别人的 hostility 只保留「对观察者本人」那一项，其余为 0，
 *   观战者全为 0；post.players[].set.hostility 同样改写。抢夺卡结算时被抢人对出卡人的敌意正好加上被抢卡片 / 道具的标价
 *   （effects/cards/money.ts rob），第三方看得到这个增量就能按价格反推出被抢的种类。别人对本人的敌意只会因本人自己的
 *   动作而增加（addHostility(victim, by=本人, …) 的金额本人都知道）、因公开的同盟衰减与破产清零而减少，所以保留不泄漏。
 *   电脑策略只读自己的 hostility（ai/view.ts mostHated），不受影响。
 * - 私密模式下仍然公开、并且是有意保留的：
 *   · 卡片张数、道具总数：原版资产表本来就显示「卡片 N / 道具 N」，得失事件本来公开、数量推算得出；界面也要用（满手提示、
 *     抢夺 / 生日的候选）；
 *   · 正在骑的交通工具（vehicle）：棋盘上看得见，掷骰数也跟着变；点券：原版资料栏「其他」页与座位条都显示；
 *   · 出卡、用道具（CARD_USED 除抢夺道具的种类外、ITEM_USED、PASSIVE）、公布栏挂牌、研究所研发、路面物件、命运 / 魔法屋的
 *     金额：原版都是当着所有人发生的动作；
 *   · 需要看对手手牌的效果（抢夺卡、命运「生日」）的清单只在 DecisionForYou 里发给出卡人本人：原版真人出抢夺卡时先看到
 *     对方的卡片与道具、可以取消且不扣卡（r_cards.md），给出的信息量相同。
 * - 结果与 state 共享深层子对象（只做浅拷贝），调用方不得修改；需要可变副本时自行 structuredClone。
 */
import { EVENT_META, type GameEventOf, type RedactHandEventType } from '../engine/types/events';
import type {
  DecisionKind,
  DecisionOptionsMap,
  GameEvent,
  PlayerPatch,
  PlayerState,
  PostPatch,
  PublicWorld,
  SeatIndex,
  ShopOptions,
} from '../engine/types/index';
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

/** 观察者能否看到 seat 手上卡片与道具的种类 */
export function canSeeHand(seat: SeatIndex, v: Viewer, o: VisibilityOptions): boolean {
  return o.handVisibility === 'public' || (v.kind === 'seat' && v.seat === seat);
}

/** 背包里的道具合计（items 下标 0 不用，恒为 0） */
export function itemTotal(items: readonly number[]): number {
  let n = 0;
  for (const x of items) n += x;
  return n;
}

type Hostility = PlayerState['hostility'];

/**
 * 看不到手牌时的敌意值：只留 hostility[观察者本人]，其余置 0（观战者全为 0）。
 * 客户端据此判断不了「谁是他最敌视的人」（audio/cues.ts rivalOf 对这样的座位返回 null）。
 */
export function hideHostility(h: Readonly<Hostility>, v: Viewer): Hostility {
  const me = v.kind === 'seat' ? v.seat : -1;
  return [me === 0 ? h[0] : 0, me === 1 ? h[1] : 0, me === 2 ? h[2] : 0, me === 3 ? h[3] : 0];
}

export function projectPlayer(p: PlayerState, v: Viewer, o: VisibilityOptions): PlayerView {
  const see = canSeeHand(p.seat, v, o);
  return {
    ...p,
    cards: see ? [...p.cards] : null,
    cardCount: p.cards.length,
    items: see ? [...p.items] : null,
    itemCount: itemTotal(p.items),
    hostility: see ? p.hostility : hideHostility(p.hostility, v),
  };
}

export const projectState: ProjectStateFn = (s, v, o) => {
  const world: Partial<Record<WorldKey, unknown>> = {};
  for (const k of WORLD_KEY_LIST) world[k] = s[k];
  if (o.handVisibility === 'private') world.pools = null;
  return { ...(world as Omit<GameView, 'players'>), players: s.players.map((p) => projectPlayer(p, v, o)) };
};

/** 引擎生成的原始值（未经投影改写） */
const isRaw = <T>(x: T | null | undefined): x is T => x !== undefined && x !== null;

function projectPlayerPatch(
  pp: { seat: SeatIndex; set: PlayerPatch },
  v: Viewer,
  o: VisibilityOptions,
): { seat: SeatIndex; set: PlayerPatch } {
  const { cards, items, hostility } = pp.set;
  const see = canSeeHand(pp.seat, v, o);
  const hideHate = !see && hostility !== undefined;
  // 没有改动手牌、背包与（要隐藏的）敌意，或上游已经改写过（hideHostility 可重复套用）
  if (!isRaw(cards) && !isRaw(items) && !hideHate) return pp;
  const set: PlayerPatch = { ...pp.set };
  if (hideHate) set.hostility = hideHostility(hostility, v);
  if (isRaw(cards)) {
    set.cards = see ? cards : null;
    set.cardCount = cards.length;
  }
  if (isRaw(items)) {
    set.items = see ? items : null;
    set.itemCount = itemTotal(items);
  }
  return { seat: pp.seat, set };
}

type Redactor<T extends RedactHandEventType> = (e: GameEventOf<T>, v: Viewer, o: VisibilityOptions) => GameEventOf<T>;

/**
 * redactHand 事件的逐类脱敏（只在 private 模式下调用；对 RedactHandEventType 穷举，新增 redactHand 事件时编译期报错）。
 * 数量（qty）、来源 / 原因、点券都保留：它们与公开的 cardCount / itemCount、点券余额一致，不带种类信息。
 */
const HAND_REDACTORS: { readonly [T in RedactHandEventType]: Redactor<T> } = {
  CARD_GAINED: (e, v, o) => (e.card === null || canSeeHand(e.seat, v, o) ? e : { ...e, card: null }),
  CARD_LOST: (e, v, o) => (e.card === null || canSeeHand(e.seat, v, o) ? e : { ...e, card: null }),
  SHOP_TRADE: (e, v, o) =>
    (e.card === null && e.item === null) || canSeeHand(e.seat, v, o) ? e : { ...e, card: null, item: null },
  CHAIRMAN_GIFT: (e, v, o) =>
    (e.card === null && e.item === null) || canSeeHand(e.seat, v, o) ? e : { ...e, card: null, item: null },
  ITEM_GAINED: (e, v, o) => (e.item === null || canSeeHand(e.seat, v, o) ? e : { ...e, item: null }),
  ITEM_LOST: (e, v, o) => (e.item === null || canSeeHand(e.seat, v, o) ? e : { ...e, item: null }),
  // 货架只有进店的人看得到（原版一台电脑同屏，别人也在看；联机时货架配合点券变化能缩小成交范围）
  SHOP_OPENED: (e, v, o) => (e.shelf.length === 0 || canSeeHand(e.seat, v, o) ? e : { ...e, shelf: [] }),
  // 出卡本身公开（原版亮卡）；抢夺卡抢道具时被抢的种类只给出卡人与被抢人（抢卡只带卡槽下标，不带卡号）
  CARD_USED: (e, v, o) => {
    const t = e.target;
    if (t.t !== 'rob' || t.take.k !== 'item' || t.take.item === null) return e;
    if (canSeeHand(e.seat, v, o) || canSeeHand(t.seat, v, o)) return e;
    return { ...e, target: { ...t, take: { k: 'item', item: null } } };
  },
};

type AnyRedactor = (e: GameEvent, v: Viewer, o: VisibilityOptions) => GameEvent;

export const projectEvent: ProjectEventFn = (e, v, o) => {
  let out: GameEvent = e;
  const post = e.post;
  if (post) {
    const players = post.players;
    const priv = o.handVisibility === 'private';
    const rewritePlayers =
      players?.some((pp) => isRaw(pp.set.cards) || isRaw(pp.set.items) || (priv && pp.set.hostility !== undefined)) ??
      false;
    const dropPools = priv && post.pools !== undefined;
    if (rewritePlayers || dropPools) {
      const next: PostPatch = { ...post };
      if (players && rewritePlayers) next.players = players.map((pp) => projectPlayerPatch(pp, v, o));
      if (dropPools) delete next.pools;
      out = { ...e, post: next } as GameEvent;
    }
  }
  if (o.handVisibility === 'private' && EVENT_META[e.type].privacy === 'redactHand') {
    const redact = HAND_REDACTORS[e.type as RedactHandEventType] as unknown as AnyRedactor;
    out = redact(out, v, o);
  }
  return out;
};

/**
 * 本人决策的选项（DecisionForYou.options，只发给做决策的本人）在私密模式下的改写：
 * SHOP.items[].pool 是共享道具库存的精确剩余数（与 GameView.pools.items 同源）。私密模式下 pools 不下发，这里也只留
 * 「有没有货」（0 / 1）——否则进店的人拿 10 减去自己的持有数与剩余数，就能推出别人手上道具 1..8 的种类与数量。
 * 界面只用它判断「已卖完」，电脑策略不读它（ai/decisions/shop.ts 只看 maxQty）；原版货架本来就不显示库存。
 */
export function projectDecisionOptions<K extends DecisionKind>(
  kind: K,
  options: DecisionOptionsMap[K],
  o: VisibilityOptions,
): DecisionOptionsMap[K] {
  if (o.handVisibility !== 'private' || kind !== 'SHOP') return options;
  const shop = options as ShopOptions;
  if (!shop.items.some((r) => r.pool > 1)) return options;
  return { ...shop, items: shop.items.map((r) => (r.pool > 1 ? { ...r, pool: 1 } : r)) } as DecisionOptionsMap[K];
}

/** public 模式全员共用一个 key；private 模式每个座位一个 key，观战者共用一个 */
export const viewerClassKey: ViewerClassKeyFn = (v, o) => {
  if (o.handVisibility === 'public') return 'public';
  return v.kind === 'seat' ? `seat:${v.seat}` : 'spectator';
};
