/**
 * 裁判与宿主共用的会话辅助（architecture §5.10；design/minigames-ai.md §6–§7）：
 * 输入日志的前缀判定与哈希、按服务器时间换算 tick、观战票据。服务器 MinigameReferee 与客户端 MiniGameHost 共用，
 * 保证两端对「已上传的流」「来自未来的 tick」的口径一致。
 */
import { hashFinish, hashInit, hashInt } from './hash';
import type { InputEvent, MinigameTicket } from './types';

/** 两条输入是否相同（第 4 项缺省与 undefined 视为相同） */
export function sameInput(a: InputEvent, b: InputEvent): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && (a[3] ?? null) === (b[3] ?? null);
}

/** prefix 是否为 log 的前缀（逐条相同） */
export function isLogPrefix(prefix: readonly InputEvent[], log: readonly InputEvent[]): boolean {
  if (prefix.length > log.length) return false;
  for (let i = 0; i < prefix.length; i++) if (!sameInput(prefix[i]!, log[i]!)) return false;
  return true;
}

/** 输入日志的 FNV-1a 32 位哈希（MINIGAME_RESULT.logHash；第 4 项缺省记 −1） */
export function hashLog(log: readonly InputEvent[]): number {
  let h = hashInt(hashInit(), log.length);
  for (const e of log) {
    h = hashInt(h, e[0]);
    h = hashInt(h, e[1]);
    h = hashInt(h, e[2]);
    h = hashInt(h, e[3] ?? -1);
  }
  return hashFinish(h);
}

/** 服务器时间 now 对应的已开始 tick 数：floor((now − startsAt) / tickMs)（开局前为负） */
export function ticksAt(now: number, startsAt: number, tickMs: number): number {
  return Math.floor((now - startsAt) / tickMs);
}

/** 观战票据：与玩家票据相同（含种子，企鹅布局对围观者可见是已接受的风险），role 改为 spectator */
export function spectatorTicket(t: MinigameTicket): MinigameTicket {
  return { ...t, params: { ...t.params }, role: 'spectator' };
}

/** 票据的形状检查（客户端收到 game:minigameWatch / DecisionForYou.minigame 时用） */
export function isMinigameTicket(x: unknown): x is MinigameTicket {
  if (typeof x !== 'object' || x === null) return false;
  const t = x as Record<string, unknown>;
  const num = (k: string) => typeof t[k] === 'number' && Number.isFinite(t[k]);
  return (
    typeof t.sessionId === 'string' &&
    typeof t.decisionId === 'string' &&
    (t.minigameId === 'penguin' || t.minigameId === 'balloon' || t.minigameId === 'xicong') &&
    num('seat') &&
    num('seed') &&
    num('tickMs') &&
    num('introTicks') &&
    num('maxTicks') &&
    num('startsAt') &&
    num('deadlineAt') &&
    (t.role === 'player' || t.role === 'spectator') &&
    typeof t.params === 'object' &&
    t.params !== null
  );
}
