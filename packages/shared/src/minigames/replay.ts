/**
 * 重放（design/minigames-ai.md §2.5）：从 init 开始按日志逐 tick 推进，直到 isOver 或 maxTicks。
 * 服务器裁判、观战、golden 与三端一致性测试共用；客户端宿主可用 takeInputs 逐 tick 取输入。
 */
import type { InputEvent, MinigameBot, MinigameParams, MinigameSim, ReplayFn, ReplayResult, SimBase } from './types';

const NO_INPUTS: readonly InputEvent[] = Object.freeze([]);

/** 日志游标：指向下一条尚未消费的输入 */
export interface LogCursor {
  i: number;
}

/**
 * 取出 tick 对应的输入并推进游标。早于 tick 的条目被跳过（不会让重放卡住）；
 * 日志须已通过 validateLog，这里不再逐条校验。
 */
export function takeInputs(log: readonly InputEvent[], cursor: LogCursor, tick: number): readonly InputEvent[] {
  let i = cursor.i;
  while (i < log.length && log[i]![0] < tick) i++;
  const start = i;
  while (i < log.length && log[i]![0] === tick) i++;
  cursor.i = i;
  return i > start ? log.slice(start, i) : NO_INPUTS;
}

/** 是否还需要再 step（未结束且未到硬上限） */
export function canStep<S extends SimBase>(sim: MinigameSim<S>, s: S): boolean {
  return !sim.isOver(s) && s.tick < sim.spec.maxTicks;
}

/** 按日志把 s 推进到 targetTick（或结束）；返回是否仍可继续。观战与断线追帧用 */
export function advanceTo<S extends SimBase>(
  sim: MinigameSim<S>,
  s: S,
  log: readonly InputEvent[],
  cursor: LogCursor,
  targetTick: number,
): boolean {
  while (s.tick < targetTick && canStep(sim, s)) sim.step(s, takeInputs(log, cursor, s.tick));
  return canStep(sim, s);
}

export function clampScore<S extends SimBase>(sim: MinigameSim<S>, s: S): number {
  const v = sim.score(s);
  if (!(v > 0)) return 0;
  return v > sim.spec.scoreSanityMax ? sim.spec.scoreSanityMax : v;
}

export function resultOf<S extends SimBase>(sim: MinigameSim<S>, s: S): ReplayResult {
  return { score: clampScore(sim, s), endTick: s.tick, hash: sim.hash(s) };
}

export const replay: ReplayFn = <S extends SimBase>(
  sim: MinigameSim<S>,
  seed: number,
  p: MinigameParams,
  log: readonly InputEvent[],
): ReplayResult => {
  const s = sim.init(seed, p);
  const cursor: LogCursor = { i: 0 };
  while (canStep(sim, s)) sim.step(s, takeInputs(log, cursor, s.tick));
  return resultOf(sim, s);
};

export interface BotRun extends ReplayResult {
  log: InputEvent[];
}

/**
 * 让 bot 玩一局并记录日志（测试、演示、golden 生成）。bot 的输出按 sim.validateInput 与 maxInputsPerTick 过滤，
 * tick 不等于当前 tick 的条目丢弃。
 */
export function playBot<S extends SimBase>(
  sim: MinigameSim<S>,
  bot: MinigameBot<S>,
  seed: number,
  p: MinigameParams,
  botSeed: number,
): BotRun {
  const s = sim.init(seed, p);
  const mem = bot.create(botSeed);
  const log: InputEvent[] = [];
  while (canStep(sim, s)) {
    const inputs: InputEvent[] = [];
    for (const e of bot.act(mem, s)) {
      if (inputs.length >= sim.spec.maxInputsPerTick) break;
      if (e[0] === s.tick && sim.validateInput(e)) inputs.push(e);
    }
    log.push(...inputs);
    sim.step(s, inputs);
  }
  return { ...resultOf(sim, s), log };
}
