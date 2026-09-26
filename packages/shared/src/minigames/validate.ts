/**
 * 输入与日志校验（design/minigames-ai.md §2.5）。服务器在重放前调用 validateLog；
 * 各 sim 的 validateInput 就是 validateInputForSpec(spec, e)。
 */
import {
  InputCode,
  type InputEvent,
  type LogValidationError,
  MINIGAME_MAX_LOG,
  type MinigameSim,
  type MinigameSpec,
  type SimBase,
  type ValidateLogFn,
} from './types';

/** 各输入码的参数范围（含端点）；b 为 null 表示不带第 4 项 */
export interface InputRange {
  a: readonly [min: number, max: number];
  b: readonly [min: number, max: number] | null;
}

export const INPUT_RANGES: Readonly<Record<InputCode, InputRange>> = Object.freeze({
  /** 企鹅：格号 0..80（无效格、冰屋由 sim 忽略） */
  [InputCode.PickCell]: { a: [0, 80], b: null },
  /** 气球：640×480 舞台坐标 */
  [InputCode.Click]: { a: [0, 639], b: [0, 479] },
  /** 喜从天降：光标横坐标，客户端先夹到舞台内 */
  [InputCode.CursorX]: { a: [0, 639], b: null },
});

function intIn(x: unknown, r: readonly [number, number]): boolean {
  return typeof x === 'number' && Number.isInteger(x) && x >= r[0] && x <= r[1];
}

/** 单条输入：形状、tick 为非负整数、code 在 acceptedCodes 中、参数为范围内整数 */
export function validateInputForSpec(spec: MinigameSpec, e: InputEvent): boolean {
  if (!Array.isArray(e) || e.length < 3 || e.length > 4) return false;
  const tick: unknown = e[0];
  if (typeof tick !== 'number' || !Number.isSafeInteger(tick) || tick < 0) return false;
  const code = e[1];
  if (!spec.acceptedCodes.includes(code)) return false;
  const range = INPUT_RANGES[code];
  if (!intIn(e[2], range.a)) return false;
  if (range.b === null) return e.length === 3 || e[3] === undefined;
  return e.length === 4 && intIn(e[3], range.b);
}

/** 1 秒对应的 tick 数（100ms → 10，50ms → 20） */
export function ticksPerSecond(spec: MinigameSpec): number {
  return 1000 / spec.tickMs;
}

/**
 * 整条日志：长度 ≤ MINIGAME_MAX_LOG；tick 为整数、0 ≤ tick < maxTicks、单调不减；每条通过 validateInput；
 * 同一 tick 不超过 maxInputsPerTick；任意连续 1000/tickMs 个 tick 的窗口内不超过 maxInputsPerSecond。合法返回 null。
 */
export const validateLog: ValidateLogFn = (spec, log) =>
  validateLogWith(spec, log, (e) => validateInputForSpec(spec, e));

export function validateLogWith(
  spec: MinigameSpec,
  log: readonly InputEvent[],
  validateInput: (e: InputEvent) => boolean,
): LogValidationError | null {
  if (!Array.isArray(log)) return { code: 'BAD_INPUT', index: 0 };
  if (log.length > MINIGAME_MAX_LOG) return { code: 'TOO_LONG', index: MINIGAME_MAX_LOG };
  const window = ticksPerSecond(spec);
  let prevTick = -1;
  let sameTick = 0;
  let windowStart = 0;
  for (let i = 0; i < log.length; i++) {
    const e = log[i]!;
    const tick: unknown = Array.isArray(e) ? e[0] : undefined;
    if (typeof tick !== 'number' || !Number.isInteger(tick) || tick < 0 || tick >= spec.maxTicks) {
      return { code: 'BAD_TICK', index: i };
    }
    if (tick < prevTick) return { code: 'NOT_MONOTONIC', index: i };
    if (!validateInput(e)) return { code: 'BAD_INPUT', index: i };
    sameTick = tick === prevTick ? sameTick + 1 : 1;
    if (sameTick > spec.maxInputsPerTick) return { code: 'TOO_MANY_PER_TICK', index: i };
    // 窗口 [tick − window + 1, tick]
    while (log[windowStart]![0] <= tick - window) windowStart++;
    if (i - windowStart + 1 > spec.maxInputsPerSecond) return { code: 'TOO_DENSE', index: i };
    prevTick = tick;
  }
  return null;
}

/** 服务器裁判用：按 sim 自己的 spec 与 validateInput 校验整条日志 */
export function validateSimLog<S extends SimBase>(
  sim: MinigameSim<S>,
  log: readonly InputEvent[],
): LogValidationError | null {
  return validateLogWith(sim.spec, log, (e) => sim.validateInput(e));
}
