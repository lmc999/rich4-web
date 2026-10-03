// 调试（获释位置整体验证）：按 simulate.ts 的同一套种子与 original 策略重放 [start, end) 局，统计
//   - 坐牢 / 住院获释（RETURNED）的落点、获释后第一次移动的第一步（支线图：是否走进支线；环路图：两个方向的分布）；
//   - 小游戏次数（MINIGAME_ENDED）；RETURNED 落在保释格 / 出院格大圆盘（≠ 关押格）的次数（应为 0）。
// 每局输出一行 JSON（含终局 stateHash），合并后可与 `npm run sim` 的 finalHash 对照，证明统的就是同一批对局。
// 用法：RICH4_DATA_DIR=./rich4-data npx tsx test/jail-verify-sim.ts --map taiwan --start 0 --end 500 [--time-limit 730]
//       node test/jail-verify-sim-merge.mjs <各分片输出…>
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AiContext, AiRng } from '@rich4/shared/ai';
import { OriginalAiPolicy } from '@rich4/shared/ai';
import { buildFixtureMaps, createRegistry, type DataRegistry, type MapDef, parseMapDef, TABLES } from '@rich4/shared/data';
import {
  EngineRuleError,
  type GameAction,
  type GameConfig,
  type GameState,
  internal,
  isIntentAllowed,
  PlayerIntentSchema,
  type PlayerSetup,
  type SeatIndex,
  type TimeLimitDays,
} from '@rich4/shared/engine';
import {
  DEFAULT_CHARACTERS,
  decisionForSeat,
  makeConfig,
  simpleView,
  stateHash,
} from '@rich4/shared/engine-testing';
import { fnv1a32, fnv1a64, mix32, WatcomRng } from '@rich4/shared/util';
import type { DecisionForYou, GameView } from '@rich4/shared/view';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1]! : d;
};
const mapId = opt('--map', 'taiwan');
const start = Number(opt('--start', '0'));
const end = Number(opt('--end', '10'));
const timeLimit = Number(opt('--time-limit', '730')) as TimeLimitDays;
const seed = opt('--seed', '5eed');
const dataDir = resolve(opt('--data-dir', process.env.RICH4_DATA_DIR ?? './rich4-data'));

function loadRegistry(): DataRegistry {
  const manifest = JSON.parse(readFileSync(resolve(dataDir, 'manifest.json'), 'utf8')) as {
    maps: { id: string; file: string }[];
  };
  const maps: MapDef[] = buildFixtureMaps();
  for (const m of manifest.maps) {
    const def = parseMapDef(JSON.parse(readFileSync(resolve(dataDir, m.file), 'utf8')));
    if (!maps.some((x) => x.id === def.id)) maps.push(def);
  }
  return createRegistry(maps, { tables: TABLES });
}

function aiRng(s: number): AiRng {
  const w = WatcomRng.fromSeed(s);
  return { next15: () => w.rand15(), mod: (n) => w.int(n), bit: () => (w.rand15() & 1) as 0 | 1, scale: (n) => w.scale(n) };
}

function aiContext(reg: DataRegistry, s: GameState, view: GameView, seat: SeatIndex, decisionId: string): AiContext {
  const p = s.players.find((x) => x.seat === seat)!;
  return {
    seat,
    traits: p.aiTraits,
    rng: aiRng(mix32(s.secret.aiSeed, seat, fnv1a32(decisionId))),
    turnRng: (salt) => aiRng(mix32(s.secret.aiSeed, seat, view.clock.turnNo, fnv1a32(salt))),
    map: reg.getMap(s.dataRef.mapId),
    handVisibility: 'public',
  };
}

const reg = loadRegistry();
const ix = reg.getMap(mapId);
/** 关押格出发、单候选一路走到有 2 个以上候选的格为止经过的格（不含关押格本身） */
function branchFrom(hold: number): number[] {
  const out: number[] = [];
  let at = hold;
  let prev = hold;
  for (let i = 0; i < 40; i++) {
    const c = ix.forwardCandidates(at, prev);
    if (c.length !== 1) break;
    prev = at;
    at = c[0]!;
    out.push(at);
  }
  return out;
}
const holds = { jail: ix.jailHold, hospital: ix.hospitalHold } as const;
const gates = { jail: ix.jailGate, hospital: ix.hospitalGate } as const;
const branch = { jail: branchFrom(ix.jailHold), hospital: branchFrom(ix.hospitalHold) };

for (let g = start; g < end; g++) {
  const engine = internal.createEngine(reg);
  const seedHex = mix32(fnv1a32(seed), g).toString(16);
  const config: GameConfig = makeConfig({ map: mapId, config: { timeLimitDays: timeLimit }, debug: false });
  const setups: PlayerSetup[] = Array.from({ length: 4 }, (_, i) => ({
    seat: i as SeatIndex,
    character: DEFAULT_CHARACTERS[i]!,
    controller: 'ai',
  }));
  let s = engine.createGame(config, setups, seedHex);
  let actions = 0;
  let rejects = 0;
  let minigames = 0;
  let gateReturns = 0;
  const releases: { from: string; node: number; first: number | null; how: string }[] = [];
  const lastFrom = new Map<number, string>();
  const armed = new Map<number, { idx: number; hold: number; from: 'jail' | 'hospital' }>();
  while (s.status === 'playing' && actions < 200_000) {
    const d = s.pending[0]!;
    const view = simpleView(s) as GameView;
    const intent = OriginalAiPolicy.decide(view, decisionForSeat(d) as DecisionForYou, aiContext(reg, s, view, d.seat, d.id));
    let fallback: GameAction | null = { ...d.defaultIntent, seat: d.seat, decisionId: d.id } as GameAction;
    let action: GameAction;
    if (!PlayerIntentSchema.safeParse(intent).success || !isIntentAllowed(d.kind, intent.type)) {
      rejects++;
      action = fallback;
      fallback = null;
    } else action = { ...intent, seat: d.seat, decisionId: d.id } as GameAction;
    const nodeBefore = new Map(s.players.map((p) => [p.seat as number, p.node]));
    let events: ReturnType<typeof engine.applyInPlace>;
    try {
      const r = engine.applyAction(s, action);
      s = r.state;
      events = r.events;
    } catch (e) {
      if (!(e instanceof EngineRuleError) || fallback === null) throw e;
      rejects++;
      events = engine.applyInPlace(s, fallback);
    }
    actions++;
    for (const e of events) {
      if (e.type === 'MINIGAME_ENDED') minigames++;
      else if (e.type === 'RELEASED' && e.actor.t === 'seat') lastFrom.set(e.actor.seat, e.from);
      else if (e.type === 'RETURNED') {
        const from = lastFrom.get(e.seat) ?? '?';
        if (from === 'jail' || from === 'hospital') {
          if (e.node !== holds[from]) gateReturns++;
          releases.push({ from, node: e.node, first: null, how: 'pending' });
          armed.set(e.seat, { idx: releases.length - 1, hold: holds[from], from });
        }
      } else if (e.type === 'CONFINED' && e.actor.t === 'seat') {
        const a = armed.get(e.actor.seat);
        if (a) {
          releases[a.idx]!.how = 'reconfined';
          armed.delete(e.actor.seat);
        }
      } else if (e.type === 'MOVE_SEGMENT' && e.actor.t === 'seat') {
        const a = armed.get(e.actor.seat);
        if (a) {
          const r = releases[a.idx]!;
          if (nodeBefore.get(e.actor.seat) === a.hold) {
            r.first = e.path[0] ?? null;
            const br = branch[a.from];
            // 支线图：第一步在支线上；环路图（关押格就有 2 个以上候选）：记方向
            r.how = br.length > 0 ? (br[0] === r.first ? 'branch' : 'offbranch') : 'loop';
          } else r.how = 'displaced';
          armed.delete(e.actor.seat);
        }
      }
    }
  }
  for (const a of armed.values()) releases[a.idx]!.how = 'gameover';
  console.log(
    JSON.stringify({
      g,
      map: mapId,
      hash: stateHash(s),
      actions,
      rejects,
      days: s.clock.elapsedDays,
      minigames,
      gateReturns,
      releases,
      holds,
      gates,
      branch,
    }),
  );
}
