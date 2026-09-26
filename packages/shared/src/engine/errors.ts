/**
 * 引擎错误（architecture §5.2）。
 * - EngineRuleError：action 不合法（服务器映射为 INVALID_ACTION{rule} / STALE_DECISION / NOT_YOUR_DECISION），入参 state 不受影响。
 * - EngineInvariantError：引擎内部不变量被破坏（缺陷），服务器按 INTERNAL 处理并导出 journal。
 */

/** 已知的规则错误码；规则实现可以追加更细的码（服务器原样透传给客户端） */
export type KnownEngineRule =
  | 'STALE_DECISION' // decisionId 不在 pending 里
  | 'NOT_YOUR_DECISION' // 决策不属于该座位
  | 'INTENT_NOT_ALLOWED' // intent.type 不在 ALLOWED_INTENTS[kind]
  | 'MENU_LIMIT' // 本回合非终结 TURN_MENU 操作超过 MENU_ACTION_LIMIT
  | 'GAME_OVER' // 对局已结束
  | 'NOT_DEBUG' // 未开启 config.debug 却提交 SYS_DEBUG
  | 'BAD_ACTION' // 结构或取值非法（未通过 schema 等）
  | 'BAD_SEAT' // 座位不存在或已出局
  | 'INVALID_TARGET' // 目标不在候选内
  | 'NOT_USABLE' // 卡片、道具当前不可用
  | 'CANNOT_AFFORD' // 现金、点券不足
  | 'OUT_OF_RANGE' // 数量、金额越界
  | 'NOT_ALLOWED'; // 其他规则禁止

export type EngineRule = KnownEngineRule | (string & {});

export class EngineRuleError extends Error {
  override name = 'EngineRuleError';

  constructor(
    readonly rule: EngineRule,
    message?: string,
    readonly details: Record<string, unknown> | null = null,
  ) {
    super(message === undefined ? rule : `${rule}: ${message}`);
  }
}

export class EngineInvariantError extends Error {
  override name = 'EngineInvariantError';

  constructor(
    readonly code: string,
    message?: string,
    readonly details: Record<string, unknown> | null = null,
  ) {
    super(message === undefined ? code : `${code}: ${message}`);
  }
}

export function isEngineRuleError(e: unknown): e is EngineRuleError {
  return e instanceof EngineRuleError;
}
