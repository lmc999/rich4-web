/**
 * 小游戏契约（architecture §5.10；design/minigames-ai.md §2.4–§2.5、§6.1）。
 * shared/minigames 只能依赖 util（architecture §3），所以 MinigameId / MinigameParams 在这里另声明一份，
 * 与 data/tables/ids.ts 的同名类型由类型测试保证一致。
 *
 * 确定性铁律（sim 目录）：只用整数、Math.imul、>>、|0、Math.trunc（小整数相除）；随机数只来自 sim 自己持有的 Watcom LCG。
 */

/** 企鹅挖宝（落点码 6）/ 七彩气球（7）/ 喜从天降（8） */
export type MinigameId = 'penguin' | 'balloon' | 'xicong';
export const MINIGAME_IDS: readonly MinigameId[] = Object.freeze(['penguin', 'balloon', 'xicong'] as const);

/** 落点码 → 小游戏 */
export const MINIGAME_BY_LANDING_CODE = Object.freeze({ 6: 'penguin', 7: 'balloon', 8: 'xicong' } as const);

/** 规则参数（预留 'exe206'，若核实后 v2.06 有差异） */
export interface MinigameParams {
  ruleset: 'exe311';
}

export const DEFAULT_MINIGAME_PARAMS: Readonly<MinigameParams> = Object.freeze({ ruleset: 'exe311' });

/** 输入码：企鹅点格、气球点击、喜从天降光标横坐标 */
export const InputCode = Object.freeze({ PickCell: 1, Click: 2, CursorX: 3 } as const);
export type InputCode = (typeof InputCode)[keyof typeof InputCode];

/** [tick, code, a, b?]：在第 tick 次 step 之前生效；a/b 为 640×480 舞台整数坐标或格号 */
export type InputEvent = readonly [tick: number, code: InputCode, a: number, b?: number];

export interface MinigameSpec {
  id: MinigameId;
  tickMs: 50 | 100;
  /** 入场 tick 数（原版 intro 计数） */
  introTicks: number;
  /** 游玩计时 tick 数 */
  playTicks: number;
  /** 硬上限（含 intro 与收场），重放和超时判定用 */
  maxTicks: number;
  stage: { w: 640; h: 480 };
  acceptedCodes: readonly InputCode[];
  maxInputsPerTick: number;
  maxInputsPerSecond: number;
  /** 只防 bug；真实上限由规则决定 */
  scoreSanityMax: number;
  /** 是否启用「最近 tick 归属」（只有气球开，DEV-07） */
  rollbackAttribution: boolean;
}

/** 各游戏的计时参数（design/minigames-ai.md §3–§5；M8 的 sim.spec 必须与之相同，服务器 Deadlines 可先用它） */
export const MINIGAME_TIMING = Object.freeze({
  penguin: { tickMs: 100, introTicks: 10, playTicks: 150, maxTicks: 170, scoreSanityMax: 188 },
  balloon: { tickMs: 100, introTicks: 5, playTicks: 150, maxTicks: 300, scoreSanityMax: 65535 },
  xicong: { tickMs: 50, introTicks: 10, playTicks: 360, maxTicks: 420, scoreSanityMax: 999 },
} as const satisfies {
  readonly [M in MinigameId]: Pick<MinigameSpec, 'tickMs' | 'introTicks' | 'playTicks' | 'maxTicks' | 'scoreSanityMax'>;
});

export type SimPhase = 'intro' | 'play' | 'ending' | 'over';

/** 表现用提示（音效、粒子）：每次 step 开头清空，不参与状态计算 */
export type SimFx =
  | { t: 'dig'; cell: number }
  | { t: 'arrive'; cell: number }
  | { t: 'reveal'; cell: number; item: number }
  | { t: 'bomb' }
  | { t: 'timeup' }
  | { t: 'spawn'; slot: number }
  | { t: 'pop'; slot: number; kind: number; scoreAfter: number }
  | { t: 'miss' }
  | { t: 'effect'; effect: 0 | 1 | 2 | 3 | 4 | 5 }
  | { t: 'drop'; slot: number; item: number }
  | { t: 'warn'; x: number }
  | { t: 'bombDrop'; slot: number }
  | { t: 'catch'; item: number }
  | { t: 'boom' };

export interface SimBase {
  /** 已完成的 step 数 */
  tick: number;
  phase: SimPhase;
  /** Watcom LCG 状态（uint32） */
  rng: number;
  fx: SimFx[];
}

export interface MinigameSim<S extends SimBase = SimBase> {
  spec: MinigameSpec;
  init(seed: number, p: MinigameParams): S;
  /** 原地推进一步；inputs 必须全部满足 e[0] === s.tick，并按到达顺序排列 */
  step(s: S, inputs: readonly InputEvent[]): void;
  /** 分数已最终确定（结算姿势和大号分数属于表现层） */
  isOver(s: S): boolean;
  score(s: S): number;
  clone(s: S): S;
  /** FNV-1a 32 位状态哈希（golden、三端一致性、提交时的 finalHash） */
  hash(s: S): number;
  /** code 在 acceptedCodes 中、坐标或格号在范围内、都是整数 */
  validateInput(e: InputEvent): boolean;
  /** 当前是否接受输入（客户端据此丢弃无效点击，缩小日志） */
  accepting(s: S): boolean;
}

/** AI 代玩：只用于测试、演示与可选玩法，不用于原版结算；只能读玩家屏幕上看得到的信息 */
export interface MinigameBot<S extends SimBase = SimBase> {
  create(seed: number): unknown;
  act(mem: unknown, s: Readonly<S>): InputEvent[];
}

export interface ReplayResult {
  /** 已夹到 [0, spec.scoreSanityMax] */
  score: number;
  endTick: number;
  hash: number;
}

/** replay.ts 的签名（M8 实现）：从 init 开始按日志逐 tick 重放，直到 isOver 或 maxTicks */
export type ReplayFn = <S extends SimBase>(
  sim: MinigameSim<S>,
  seed: number,
  p: MinigameParams,
  log: readonly InputEvent[],
) => ReplayResult;

export type LogValidationCode =
  | 'TOO_LONG' // 超过 MINIGAME_MAX_LOG
  | 'BAD_TICK' // tick 非整数或 ≥ maxTicks
  | 'NOT_MONOTONIC' // tick 递减
  | 'BAD_INPUT' // validateInput 未通过
  | 'TOO_MANY_PER_TICK'
  | 'TOO_DENSE'; // 任意 1 秒窗口超过 maxInputsPerSecond

export interface LogValidationError {
  code: LogValidationCode;
  index: number;
}

/** validate.ts 的签名（M8 实现）：合法返回 null */
export type ValidateLogFn = (spec: MinigameSpec, log: readonly InputEvent[]) => LogValidationError | null;

/** 单次会话输入日志的最大条数 */
export const MINIGAME_MAX_LOG = 2000;

/**
 * 小游戏票据：玩家票据经 DecisionForYou.minigame 下发；live 模式下观战票据经 game:minigameWatch 下发。
 * startsAt = now + animMs + 3000（3 秒倒计时，期间可以「跳过」）；deadlineAt = startsAt + maxTicks × tickMs + 5000。
 */
export interface MinigameTicket {
  sessionId: string;
  decisionId: string;
  seat: 0 | 1 | 2 | 3;
  minigameId: MinigameId;
  seed: number;
  params: MinigameParams;
  tickMs: 50 | 100;
  introTicks: number;
  maxTicks: number;
  startsAt: number;
  deadlineAt: number;
  role: 'player' | 'spectator';
}

/** 票据截止时间（服务器与客户端共用的公式） */
export function minigameDeadlineAt(startsAt: number, id: MinigameId, graceMs = 5000): number {
  const t = MINIGAME_TIMING[id];
  return startsAt + t.maxTicks * t.tickMs + graceMs;
}
