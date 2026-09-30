// 调试（只读调研）：在 test/maps-engine-probe-build.ts 产出的探针数据包（.cache/maps/engine-probe）上，
// 用原版电脑 AI 自对弈，统计台湾图从未走到的引擎路径是否被覆盖：各行业企业收费、航空「消失」、关押格在环路上
// （大陆 / 日本 / 美国医院、美国监狱）时的停留与路过、支线（监狱支线）上的物件 / 跳伞、节日命中（美国 kind 2）。
//
//   npx tsx test/maps-engine-probe-events.ts [games=12] [maps=china,japan,usa]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AiContext, AiRng } from '@rich4/shared/ai';
import { OriginalAiPolicy } from '@rich4/shared/ai';
import { buildFixtureMaps, createRegistry, type DataRegistry, type MapDef, parseMapDef, TABLES } from '@rich4/shared/data';
import {
  type GameAction,
  type GameState,
  internal,
  isIntentAllowed,
  PlayerIntentSchema,
  type PlayerSetup,
  type SeatIndex,
} from '@rich4/shared/engine';
import { DEFAULT_CHARACTERS, decisionForSeat, makeConfig, simpleView } from '@rich4/shared/engine-testing';
import { fnv1a32, mix32, WatcomRng } from '@rich4/shared/util';
import type { DecisionForYou, GameView } from '@rich4/shared/view';

const DIR = '.cache/maps/engine-probe';
const games = Number(process.argv[2] ?? 12);
const maps = (process.argv[3] ?? 'china,japan,usa').split(',');

function loadRegistry(): DataRegistry {
  const manifest = JSON.parse(readFileSync(resolve(DIR, 'manifest.json'), 'utf8')) as {
    maps: { id: string; file: string }[];
  };
  const defs: MapDef[] = buildFixtureMaps();
  for (const m of manifest.maps) defs.push(parseMapDef(JSON.parse(readFileSync(resolve(DIR, m.file), 'utf8'))));
  return createRegistry(defs, { tables: TABLES });
}

function aiRng(seed: number): AiRng {
  const w = WatcomRng.fromSeed(seed);
  return { next15: () => w.rand15(), mod: (n) => w.int(n), bit: () => (w.rand15() & 1) as 0 | 1, scale: (n) => w.scale(n) };
}

const reg = loadRegistry();
for (const mapId of maps) {
  const idx = reg.getMap(mapId);
  const def = idx.def;
  // 监狱 / 医院支线：从关押格沿唯一出路走到保释格（不含保释格）
  const spur = new Set<number>();
  for (const hold of [idx.jailHold, idx.hospitalHold]) {
    if (hold === idx.jailGate || hold === idx.hospitalGate) continue;
    let prev = -1;
    let cur = hold;
    while (cur !== idx.jailGate && cur !== idx.hospitalGate && spur.size < 64) {
      spur.add(cur);
      const nx = idx.tile(cur).links.map((l) => l.to).filter((t) => t !== prev);
      if (nx.length !== 1) break;
      prev = cur;
      cur = nx[0]!;
    }
  }
  const industryOf = new Map(def.companies.map((c) => [c.id, c.industry]));
  const tally: Record<string, number> = {};
  const inc = (k: string, n = 1) => {
    tally[k] = (tally[k] ?? 0) + n;
  };
  const holidayHits: Record<string, number> = {};
  const onLoopHolds = [idx.jailHold, idx.hospitalHold].filter((h) => h === idx.jailGate || h === idx.hospitalGate);
  for (let g = 0; g < games; g++) {
    const engine = internal.createEngine(reg);
    const seed = mix32(fnv1a32(`probe-${mapId}`), g).toString(16);
    const config = makeConfig({ map: mapId, config: { timeLimitDays: 730 }, debug: false });
    const setups: PlayerSetup[] = Array.from({ length: 4 }, (_, i) => ({
      seat: i as SeatIndex,
      character: DEFAULT_CHARACTERS[i]!,
      controller: 'ai',
    }));
    const s: GameState = engine.createGame(config, setups, seed);
    let n = 0;
    while (s.status === 'playing' && n < 200000) {
      const d = s.pending[0]!;
      const view = simpleView(s) as GameView;
      const p = s.players.find((x) => x.seat === d.seat)!;
      const ctx: AiContext = {
        seat: d.seat,
        traits: p.aiTraits,
        rng: aiRng(mix32(s.secret.aiSeed, d.seat, fnv1a32(d.id))),
        turnRng: (salt) => aiRng(mix32(s.secret.aiSeed, d.seat, view.clock.turnNo, fnv1a32(salt))),
        map: idx,
        handVisibility: 'public',
      };
      const intent = OriginalAiPolicy.decide(view, decisionForSeat(d) as DecisionForYou, ctx);
      let action: GameAction =
        PlayerIntentSchema.safeParse(intent).success && isIntentAllowed(d.kind, intent.type)
          ? ({ ...intent, seat: d.seat, decisionId: d.id } as GameAction)
          : ({ ...d.defaultIntent, seat: d.seat, decisionId: d.id } as GameAction);
      let events;
      try {
        events = engine.applyInPlace(s, action);
      } catch {
        inc('reject');
        action = { ...d.defaultIntent, seat: d.seat, decisionId: d.id } as GameAction;
        events = engine.applyInPlace(s, action);
      }
      n++;
      for (const e of events) {
        const x = e as { type: string; [k: string]: unknown };
        if (x.type === 'COMPANY_FEE') inc(`COMPANY_FEE industry=${x.industry}`);
        else if (x.type === 'CONFINED') inc(`CONFINED ${x.where} cause=${(x.cause as { k: string }).k}`);
        else if (x.type === 'RELEASED') inc(`RELEASED ${x.from}`);
        else if (x.type === 'HOLIDAY') holidayHits[x.key as string] = (holidayHits[x.key as string] ?? 0) + 1;
        else if (x.type === 'PARACHUTE' && spur.has(x.node as number)) inc('PARACHUTE onto spur');
        else if (x.type === 'LANDED' && (x.actor as { t: string }).t === 'seat') {
          const k = idx.tile(x.node as number).kind;
          if (['penguin', 'balloon', 'xicong', 'lottery', 'magic', 'bank'].includes(k)) inc(`LANDED ${k}`);
          if (spur.has(x.node as number)) inc('LANDED on spur');
        } else if (x.type === 'MINIGAME_STARTED' || x.type === 'MINIGAME_ENDED' || x.type === 'MAGIC_CAST') inc(x.type);
        else if (x.type === 'OBJECT_PLACED' && spur.has((x.obj as { node: number }).node)) inc('OBJECT on spur');
      }
      // 在环路上的关押格：有人被关着时，别的玩家停在 / 路过同一格
      for (const h of onLoopHolds) {
        const held = s.players.filter((q) => q.alive && q.node === h && (q.st.jail !== 0 || q.st.hospital !== 0));
        const free = s.players.filter((q) => q.alive && q.node === h && q.st.jail === 0 && q.st.hospital === 0);
        if (held.length > 0 && free.length > 0) inc(`free player shares on-loop hold ${h} with held player (per action)`);
      }
    }
    inc(`end ${s.status}`);
  }
  console.log(`== ${mapId}  jailGate ${idx.jailGate} jailHold ${idx.jailHold}  hospitalGate ${idx.hospitalGate} hospitalHold ${idx.hospitalHold}  spur ${[...spur].sort((a, b) => a - b).join(',') || '-'}`);
  console.log('  companies', def.companies.map((c) => `${c.id}:${industryOf.get(c.id)}`).join(' '));
  for (const k of Object.keys(tally).sort()) console.log(`  ${k}: ${tally[k]}`);
  console.log('  holidays hit', JSON.stringify(holidayHits));
}
