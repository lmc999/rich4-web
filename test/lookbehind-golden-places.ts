// 调试（AI lookbehind 按原版改动）：按 golden（packages/shared/src/engine/golden/maps.test.ts）的同一组对局重放四张图，
// 记下每一次放置物件（OBJECT_PLACED：路障 / 地雷 / 定时炸弹）的天数、座位、格，以及放置时该座位的节点 / 来路，
// 并标出目标格在「来路方向往回第几格」（不走岔路时的沿线距离；岔路上标 ?）与「前进方向第几格」。
// 改动前后各跑一遍，输出到 .cache/lookbehind/places-<标签>.json，再用 test/lookbehind-golden-diff.ts 比较。
// 用法：RICH4_DATA_DIR=./rich4-data npx tsx test/lookbehind-golden-places.ts <标签> [taiwan,china,japan,usa]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeAiContext, OriginalAiPolicy } from '@rich4/shared/ai';
import { buildFixtureMaps, createRegistry, type DataRegistry, parseMapDef, TABLES } from '@rich4/shared/data';
import type { MapIndex } from '@rich4/shared/data';
import {
  EngineRuleError,
  type GameAction,
  type GameEvent,
  type GameState,
  internal,
  isIntentAllowed,
  type PlayerIntent,
  PlayerIntentSchema,
  type SeatIndex,
  type TimeLimitDays,
} from '@rich4/shared/engine';
import { DEFAULT_CHARACTERS, decisionForSeat, makeConfig, stateHash } from '@rich4/shared/engine-testing';
import { projectState } from '@rich4/shared/view';

const label = process.argv[2] ?? 'run';
const maps = (process.argv[3] ?? 'taiwan,china,japan,usa').split(',');
const dataDir = resolve(process.env.RICH4_DATA_DIR ?? './rich4-data');

/** 与 maps.test.ts 的 GAMES 相同 */
const GAMES: { name: string; seed: string; timeLimitDays: TimeLimitDays; characters: readonly number[] }[] = [
  { name: '一个月（默认角色）', seed: '7a1a0001', timeLimitDays: 30, characters: DEFAULT_CHARACTERS },
  { name: '三个月', seed: '7a1a0002', timeLimitDays: 91, characters: [0, 5, 7, 11] },
  { name: '半年', seed: '7a1a0003', timeLimitDays: 182, characters: [1, 2, 6, 10] },
  { name: '一年', seed: '7a1a0004', timeLimitDays: 365, characters: [3, 4, 8, 9] },
];

function loadMap(id: string): DataRegistry {
  const m = JSON.parse(readFileSync(resolve(dataDir, 'manifest.json'), 'utf8')) as { maps: { id: string; file: string }[] };
  const entry = m.maps.find((x) => x.id === id)!;
  const def = parseMapDef(JSON.parse(readFileSync(resolve(dataDir, entry.file), 'utf8')));
  return createRegistry([...buildFixtureMaps().filter((x) => x.id !== def.id), def], { tables: TABLES });
}

/** 从 at 出发、排除 excl，沿单候选一路走 8 格；遇到岔路停。返回目标格在第几格（1 起），找不到返回 null */
function distAlong(ix: MapIndex, at: number, excl: number, target: number): number | '?' | null {
  for (let k = 1; k <= 8; k++) {
    const c = at === 0 ? [] : ix.forwardCandidates(at, excl);
    let next: number;
    if (c.length === 0) next = excl;
    else if (c.length === 1) next = c[0]!;
    else return c.includes(target) ? k : '?';
    excl = at;
    at = next;
    if (at === target) return k;
  }
  return null;
}

/** 往回第几格：来路格本身 = 1，来路格再往后一格 = 2 … */
function backDist(ix: MapIndex, node: number, prev: number, target: number): number | '?' | null {
  if (target === prev) return 1;
  const d = distAlong(ix, prev, node, target);
  return typeof d === 'number' ? d + 1 : d;
}

interface Place {
  game: string;
  day: number;
  seat: number;
  kind: string;
  node: number;
  me: number;
  prev: number;
  /** 往回第几格（来路格本身 = 1） */
  back: number | '?' | null;
  /** 往前：从当前格起算（下一格 = 1） */
  ahead: number | '?' | null;
}

const out: Record<string, { games: { name: string; final: string; days: number; reason: string; rejects: number }[]; places: Place[] }> = {};
for (const id of maps) {
  const registry = loadMap(id);
  const map = registry.getMap(id);
  const places: Place[] = [];
  const games: (typeof out)[string]['games'] = [];
  for (const g of GAMES) {
    const engine = internal.createEngine(registry, { devChecks: false });
    const config = makeConfig({ map: id, config: { timeLimitDays: g.timeLimitDays }, debug: false });
    const setups = g.characters.map((character, i) => ({ seat: i as SeatIndex, character: character as never, controller: 'ai' as const }));
    let s: GameState = engine.createGameWithEvents(config, setups, g.seed).state;
    let actions = 0;
    let rejects = 0;
    while (s.status === 'playing' && actions < 60_000) {
      const d = s.pending[0]!;
      const player = s.players.find((p) => p.seat === d.seat)!;
      const view = structuredClone(projectState(s, { kind: 'seat', seat: d.seat }, { handVisibility: 'public' }));
      const ctx = makeAiContext({
        aiSeed: s.secret.aiSeed,
        seat: d.seat,
        decisionId: d.id,
        turnNo: s.clock.turnNo,
        traits: { ...player.aiTraits },
        map,
        handVisibility: 'public',
      });
      const fallback = { ...d.defaultIntent, seat: d.seat, decisionId: d.id } as GameAction;
      const raw = OriginalAiPolicy.decide(view, decisionForSeat(d) as never, ctx) as PlayerIntent;
      let action = fallback;
      if (PlayerIntentSchema.safeParse(raw).success && isIntentAllowed(d.kind, raw.type)) {
        action = { ...raw, seat: d.seat, decisionId: d.id } as GameAction;
      } else rejects++;
      const pos = new Map(s.players.map((p) => [p.seat as number, { node: p.node, prev: p.prevNode }]));
      const day = s.clock.elapsedDays;
      let events: GameEvent[];
      try {
        const r = engine.applyAction(s, action);
        s = r.state;
        events = r.events;
      } catch (e) {
        if (!(e instanceof EngineRuleError) || action === fallback) throw e;
        rejects++;
        const r = engine.applyAction(s, fallback);
        s = r.state;
        events = r.events;
      }
      actions++;
      for (const e of events) {
        if (e.type !== 'OBJECT_PLACED') continue;
        const o = e.obj;
        // 不是座位放的（placedBy 为空，例如事件放置）只记格
        const at = o.placedBy === null || o.placedBy === undefined ? null : pos.get(o.placedBy)!;
        places.push({
          game: g.name,
          day,
          seat: o.placedBy ?? -1,
          kind: o.kind,
          node: o.node,
          me: at?.node ?? 0,
          prev: at?.prev ?? 0,
          back: at ? backDist(map, at.node, at.prev, o.node) : null,
          ahead: at ? distAlong(map, at.node, at.prev, o.node) : null,
        });
      }
    }
    games.push({ name: g.name, final: stateHash(s), days: s.clock.elapsedDays, reason: s.result?.reason ?? 'unfinished', rejects });
  }
  out[id] = { games, places };
  console.log(`${id}: ${places.length} 次放置；${games.map((x) => `${x.name} ${x.final.slice(0, 12)} ${x.days}d ${x.reason} rejects=${x.rejects}`).join(' | ')}`);
}
mkdirSync('.cache/lookbehind', { recursive: true });
writeFileSync(`.cache/lookbehind/places-${label}.json`, `${JSON.stringify(out, null, 1)}\n`);
console.log(`写入 .cache/lookbehind/places-${label}.json`);
