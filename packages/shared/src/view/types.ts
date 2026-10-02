/**
 * 按观察者投影后的视图类型（architecture §5.7、§5.8；design/net.md §4.4、§6.1）。
 * project.ts（projectState / projectEvent / viewerClassKey）与 pacing.ts（STEP_MS / EVENT_BUDGET_MS / estimateAnimMs）
 * 由 M2 实现；这里只定义类型。view 不得依赖 net 与 minigames（architecture §3），所以：
 * - SeatControl 定义在这里，net 再导出；
 * - DecisionForYou 的小游戏票据类型用泛型参数注入，net 用 YourDecision = DecisionForYou<DecisionKind, MinigameTicket>。
 */
import type {
  CardId,
  DecisionKind,
  DecisionOptionsMap,
  DecisionPublicInfo,
  DecisionTimingClass,
  GameEvent,
  GameState,
  PlayerIntent,
  PlayerState,
  Pools,
  PublicWorld,
  SeatIndex,
} from '../engine/types/index';

export type HandVisibility = 'public' | 'private';

export interface VisibilityOptions {
  /**
   * 默认 public（还原原版同屏体验）；private 时对手与观战者只看到卡片张数与道具总数（服务器开局时按真人座位数锁定：
   * 联机 ≥ 2 名真人一律 private，见 net/room.ts effectiveHandVisibility）
   */
  handVisibility: HandVisibility;
}

export type Viewer = { kind: 'seat'; seat: SeatIndex } | { kind: 'spectator' };

/**
 * 私密模式下非本人的 cards / items 为 null；cardCount / itemCount 始终有效；非本人的 hostility 只保留对观察者本人的
 * 那一项、其余为 0（观战者全为 0；project.ts hideHostility）。
 * 保留为公开的：张数与道具总数（原版资产表本来就有「卡片 N / 道具 N」，得失事件的数量也公开）、正在骑的交通工具
 * （vehicle，棋盘上看得见）、点券。
 */
export type PlayerView = Omit<PlayerState, 'cards' | 'items'> & {
  cards: CardId[] | null;
  cardCount: number;
  /** 长度 14，下标 = ItemId；私密模式下非本人为 null */
  items: number[] | null;
  /** 背包里的道具合计（装备中的机车、汽车不计入，与 items 同口径） */
  itemCount: number;
};

/**
 * 下发给客户端的世界：包含 dataRef、config、pools（牌堆剩余张数），不含 secret / flow / pending / counters。
 * pools 在私密手牌模式下为 null：每批前后的张数差能精确推出别人摸到、买到了哪张卡、哪种道具（客户端与 AI 都不读它）
 */
export interface GameView extends Omit<PublicWorld, 'players' | 'pools'> {
  players: PlayerView[];
  pools: Pools | null;
}

/** 座位控制状态（托管状态机见 design/net.md §5.3）；托管不改变引擎里的 controller */
export type SeatControl =
  | 'human'
  | 'ai'
  | 'autopilot:manual'
  | 'autopilot:afk'
  | 'autopilot:disconnect'
  | 'autopilot:left';

export const SEAT_CONTROLS: readonly SeatControl[] = Object.freeze([
  'human',
  'ai',
  'autopilot:manual',
  'autopilot:afk',
  'autopilot:disconnect',
  'autopilot:left',
] as const);

export function isAutopilot(c: SeatControl): boolean {
  return c.startsWith('autopilot:');
}

/** 所有观察者都能看到的待决策（例如「阿土伯 思考中 12s」） */
export interface PendingView<K extends DecisionKind = DecisionKind> {
  decisionId: string;
  seat: SeatIndex;
  kind: K;
  timing: DecisionTimingClass;
  /** 服务器时间戳（ms）；null 表示不限时 */
  deadlineAt: number | null;
  control: SeatControl;
  publicInfo: DecisionPublicInfo<K>;
}

/** 只发给做决策的那位玩家（观战者永远拿不到） */
export interface DecisionForYou<K extends DecisionKind = DecisionKind, Ticket = unknown> {
  decisionId: string;
  seat: SeatIndex;
  kind: K;
  timing: DecisionTimingClass;
  /** 可能含私密信息（例如抢夺卡里对手的手牌） */
  options: DecisionOptionsMap[K];
  defaultIntent: PlayerIntent;
  deadlineAt: number | null;
  /** 只有 MINIGAME 决策带票据（net 里为 MinigameTicket） */
  minigame?: Ticket;
}

/** 按 kind 展开的判别联合（前端决策注册表、AI HANDLERS 用它收窄 options） */
export type AnyDecisionForYou<Ticket = unknown> = { [K in DecisionKind]: DecisionForYou<K, Ticket> }[DecisionKind];

/** 收窄 kind（options 随之收窄） */
export function isDecisionForYouOf<K extends DecisionKind, Ticket>(
  d: DecisionForYou<DecisionKind, Ticket>,
  kind: K,
): d is DecisionForYou<K, Ticket> {
  return d.kind === kind;
}

/** 转成判别联合以便 switch(d.kind) 收窄（kind 与 options 的对应由引擎保证） */
export function asAnyDecision<Ticket>(d: DecisionForYou<DecisionKind, Ticket>): AnyDecisionForYou<Ticket> {
  return d as AnyDecisionForYou<Ticket>;
}

// ───────────────────────── project.ts / pacing.ts 的签名（M2 实现） ─────────────────────────

/** 去掉 secret/flow/pending/counters，按手牌可见性改写 players */
export type ProjectStateFn = (s: GameState, v: Viewer, o: VisibilityOptions) => GameView;
/** 私密模式下把非本人的 post.players[].set.cards / items 改写为 null（补 cardCount / itemCount）、去掉 post.pools，并按 EVENT_META.privacy 脱敏载荷 */
export type ProjectEventFn = (e: GameEvent, v: Viewer, o: VisibilityOptions) => GameEvent;
/** public 模式下全员共用一个 key，投影只算一次 */
export type ViewerClassKeyFn = (v: Viewer, o: VisibilityOptions) => string;
/** 按事件估算动画时长（ms），服务器用于截止时间，客户端用于告警 */
export type EstimateAnimMsFn = (events: readonly GameEvent[]) => number;
