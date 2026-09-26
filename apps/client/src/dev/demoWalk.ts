// /dev/map 的演示：4 个角色在路网上随机行走（岔路随机、死路折返）。只用于开发页，与引擎规则无关。
import { buildMapIndex, type MapDef, type TileId } from '@rich4/shared/data';
import type { PlayerActor } from '../game/actors/PlayerActor';
import type { GameRenderer } from '../game/GameRenderer';

export const DEMO_CHARACTERS = ['sunXiaomei', 'atubo', 'madamQian', 'johnJoe'] as const;

export type Rand = () => number;

/** 从 at 出发、来自 prev，随机走 steps 步；岔路随机，死路掉头 */
export function randomPath(def: MapDef, at: TileId, prev: TileId | null, steps: number, rand: Rand): TileId[] {
  let forward: (a: TileId, p: TileId | null) => TileId[];
  try {
    const index = buildMapIndex(def);
    forward = (a, p) => index.forwardCandidates(a, p ?? -1);
  } catch {
    const byId = new Map(def.tiles.map((t) => [t.id, t] as const));
    forward = (a, p) => (byId.get(a)?.links ?? []).filter((l) => l.to !== p && !l.blocked).map((l) => l.to);
  }
  const path = [at];
  let cur = at;
  let from = prev;
  for (let i = 0; i < steps; i++) {
    let cands = forward(cur, from);
    if (cands.length === 0) cands = from !== null ? [from] : [];
    if (cands.length === 0) break;
    const next = cands[Math.floor(rand() * cands.length)]!;
    from = cur;
    cur = next;
    path.push(next);
  }
  return path;
}

/** 可放置角色的起点格 */
export function startTiles(def: MapDef): TileId[] {
  const ok = def.tiles.filter((t) => !t.noItems && t.holdFor === undefined).map((t) => t.id);
  return ok.length > 0 ? ok : def.tiles.map((t) => t.id);
}

/** 放置 4 个角色并循环随机行走，直到 signal 中止 */
export async function runDemoWalk(
  r: GameRenderer,
  names: readonly string[],
  signal: AbortSignal,
  rand: Rand = Math.random,
): Promise<void> {
  const def = r.board.def;
  const starts = startTiles(def);
  const frames = await Promise.all(DEMO_CHARACTERS.map((k) => r.loadCharacter(k).catch(() => null)));
  if (signal.aborted) return;
  const actors: PlayerActor[] = DEMO_CHARACTERS.map((_, seat) =>
    r.board.addActor(
      seat,
      frames[seat] ?? null,
      names[seat] ?? `P${seat + 1}`,
      starts[Math.floor(rand() * starts.length)]!,
    ),
  );
  const prev = new Map<number, TileId | null>();
  const loop = async (a: PlayerActor, seat: number): Promise<void> => {
    await r.clock.wait(seat * 350, signal);
    while (!signal.aborted) {
      const at = a.tile ?? starts[0]!;
      const path = randomPath(def, at, prev.get(seat) ?? null, 1 + Math.floor(rand() * 6), rand);
      if (path.length < 2) break;
      await a.walk(path, { signal });
      prev.set(seat, path[path.length - 2] ?? null);
      r.board.spreadActors();
      if (signal.aborted) break;
      a.setPose(rand() < 0.5 ? 'cheer' : 'idle0');
      await r.clock.wait(500 + rand() * 700, signal);
      a.setPose('idle0');
    }
  };
  await Promise.all(actors.map((a, i) => loop(a, i)));
}
