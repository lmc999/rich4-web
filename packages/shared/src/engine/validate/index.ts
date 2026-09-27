/**
 * validateState（design/engine.md §15）：先做 zod 结构校验，再逐项检查不变量。
 * explainState 返回全部问题（开发 / 测试用）；validateState 只回答是否合法。
 * 时光机锚点世界（secret.timeAnchor / timeAnchors）同样检查：结构由 schema 严格校验，不变量按锚点世界拼成的
 * GameState 逐项检查（回滚会把它整体写回 state，导入的存档不能借锚点注入未校验的世界）。
 */
import type { DataRegistry } from '../../data/maps/registry';
import type { EngineMap } from '../core/mapCache';
import { engineMap } from '../core/mapCache';
import type { GameState, TimeAnchor } from '../types/state';
import { checkInvariants } from './invariants';
import { GameStateSchema } from './schema';

/** 锚点世界拼成的 GameState：待决策为空，counters 与其余 secret 用当前值（锚点不含它们） */
function anchorState(s: GameState, a: TimeAnchor): GameState {
  const { flow, decks, ...pub } = a.world;
  return {
    ...pub,
    flow,
    pending: [],
    counters: s.counters,
    secret: { ...s.secret, ...decks, timeAnchor: null, timeAnchors: [] },
  };
}

/** 锚点的不变量：座位集合与当前一致、进行中、锚点座位与下标一致，再按锚点世界检查全部不变量 */
export function explainAnchors(s: GameState, em: EngineMap): string[] {
  const out: string[] = [];
  const seats = s.players.map((p) => p.seat).join(',');
  const check = (a: TimeAnchor, where: string, slot: number | null) => {
    if (slot !== null && a.seat !== slot) out.push(`${where}: anchor seat ${a.seat} in slot ${slot}`);
    if (a.world.players.map((p) => p.seat).join(',') !== seats) out.push(`${where}: seats differ from the game`);
    if (!a.world.players.some((p) => p.seat === a.seat)) out.push(`${where}: anchor seat ${a.seat} is not a player`);
    if (a.world.dataRef.mapId !== s.dataRef.mapId) out.push(`${where}: map ${a.world.dataRef.mapId}`);
    if (a.world.status !== 'playing') out.push(`${where}: anchor world is not playing`);
    if (a.takenAtTurn !== a.world.clock.turnNo) out.push(`${where}: takenAtTurn ${a.takenAtTurn} != world turn`);
    for (const x of checkInvariants(anchorState(s, a), em, { anchor: true })) out.push(`${where}: ${x}`);
  };
  if (s.secret.timeAnchor !== null) check(s.secret.timeAnchor, 'timeAnchor', null);
  s.secret.timeAnchors.forEach((a, k) => {
    if (a !== null) check(a, `timeAnchors[${k}]`, k);
  });
  return out;
}

export function explainState(reg: DataRegistry, x: unknown): string[] {
  const parsed = GameStateSchema.safeParse(x);
  if (!parsed.success) {
    return parsed.error.issues.slice(0, 20).map((i) => `schema ${i.path.join('.')}: ${i.message}`);
  }
  const s = x as GameState;
  let em: ReturnType<typeof engineMap>;
  try {
    // 与 applyAction 同一口径：mapHash 必须与注册表一致（不符即 DataError MAP_UNAVAILABLE「hash mismatch」）
    em = engineMap(reg.getMap(s.dataRef.mapId, s.dataRef.mapHash));
  } catch (e) {
    return [`map ${s.dataRef.mapId} unavailable: ${String(e)}`];
  }
  const bad = checkInvariants(s, em);
  return bad.length > 0 ? bad : explainAnchors(s, em);
}

export function validateStateWith(reg: DataRegistry, x: unknown): x is GameState {
  return explainState(reg, x).length === 0;
}

export { checkInvariants } from './invariants';
export { GameConfigSchema, GameStateSchema, PlayerSetupSchema, RuleConfigSchema } from './schema';
