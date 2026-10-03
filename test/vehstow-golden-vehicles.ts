// 调试（座驾按原版，architecture §34）：按 golden（packages/shared/src/engine/golden/maps.test.ts）的同一组对局重放四张图，
// 统计座驾切换：梦游卡停放（VEHICLE via sleepwalk）、梦游结束装回（via wake）与醒来时背包里已经没有（停放了但没装回）、
// 冬眠卡取消梦游、工程车到期（via expire）、魔法屋卖光（via sold）、命运失车（VEHICLE_DESTROYED via fate）、
// 开着工程车时用机车 / 汽车道具（原版电脑不会，应为 0）。输出到 .cache/vehstow/golden/vehicles-<标签>.json。
// 用法：RICH4_DATA_DIR=./rich4-data npx tsx test/vehstow-golden-vehicles.ts <标签> [taiwan,china,japan,usa] [局数]
// 给了局数时不跑 golden 那 4 局，改跑这么多局一年局（种子 7a1b0000 起、角色轮换），只看统计（与自对弈互相印证）
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeAiContext, OriginalAiPolicy } from '@rich4/shared/ai';
import { buildFixtureMaps, createRegistry, type DataRegistry, parseMapDef, TABLES } from '@rich4/shared/data';
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
const extra = Number(process.argv[4] ?? 0);
const GOLDEN_GAMES: { name: string; seed: string; timeLimitDays: TimeLimitDays; characters: readonly number[] }[] = [
  { name: '一个月（默认角色）', seed: '7a1a0001', timeLimitDays: 30, characters: DEFAULT_CHARACTERS },
  { name: '三个月', seed: '7a1a0002', timeLimitDays: 91, characters: [0, 5, 7, 11] },
  { name: '半年', seed: '7a1a0003', timeLimitDays: 182, characters: [1, 2, 6, 10] },
  { name: '一年', seed: '7a1a0004', timeLimitDays: 365, characters: [3, 4, 8, 9] },
];
const GAMES =
  extra > 0
    ? Array.from({ length: extra }, (_, i) => ({
        name: `一年 #${i}`,
        seed: (0x7a1b0000 + i).toString(16),
        timeLimitDays: 365 as TimeLimitDays,
        characters: [0, 1, 2, 3].map((k) => (i + k * 3) % 12),
      }))
    : GOLDEN_GAMES;

function loadMap(id: string): DataRegistry {
  const m = JSON.parse(readFileSync(resolve(dataDir, 'manifest.json'), 'utf8')) as { maps: { id: string; file: string }[] };
  const entry = m.maps.find((x) => x.id === id)!;
  const def = parseMapDef(JSON.parse(readFileSync(resolve(dataDir, entry.file), 'utf8')));
  return createRegistry([...buildFixtureMaps().filter((x) => x.id !== def.id), def], { tables: TABLES });
}

type Counts = Record<string, number>;
const bump = (c: Counts, k: string): void => {
  c[k] = (c[k] ?? 0) + 1;
};

const out: Record<string, { games: { name: string; final: string; days: number; reason: string; rejects: number; counts: Counts; log: string[] }[] }> = {};
for (const id of maps) {
  const registry = loadMap(id);
  const map = registry.getMap(id);
  const games: (typeof out)[string]['games'] = [];
  for (const g of GAMES) {
    const counts: Counts = {};
    const log: string[] = [];
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
      const pre = s.players.map((p) => ({ seat: p.seat, vehicle: p.vehicle, parked: p.parked ?? null }));
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
      const before = new Map(pre.map((p) => [p.seat as number, p]));
      for (const e of events) {
        if (e.type === 'VEHICLE') {
          const was = before.get(e.seat);
          const key = e.via ? `VEHICLE.${e.via}.${e.via === 'wake' || e.via === 'expire' ? e.vehicle : e.from}` : e.stowed ? 'VEHICLE.stowed' : `VEHICLE.item.${was?.vehicle}->${e.vehicle}`;
          bump(counts, key);
          if (e.via || was?.vehicle === 'engineer') log.push(`d${day} s${e.seat} ${key} dice=${e.dice}`);
        } else if (e.type === 'VEHICLE_DESTROYED') {
          bump(counts, `VEHICLE_DESTROYED.${e.via ?? 'wreck'}.${e.vehicle}`);
        } else if (e.type === 'CARD_USED' && e.card === 16) bump(counts, 'CARD_USED.sleepwalk');
      }
      // 停放了、梦游结束却没有装回（背包里已经没有）；冬眠卡取消梦游
      for (const p of s.players) {
        const was = before.get(p.seat);
        if (!was?.parked || p.parked !== null) continue;
        const woke = events.some((e) => e.type === 'VEHICLE' && e.seat === p.seat && e.via === 'wake');
        const hib = events.some((e) => e.type === 'CARD_USED' && e.card === 15);
        const k = woke ? null : hib ? `parked.cancelledByHibernate.${was.parked.vehicle}` : `parked.notRestored.${was.parked.vehicle}`;
        if (k) {
          bump(counts, k);
          log.push(`d${day} s${p.seat} ${k}`);
        }
      }
    }
    games.push({ name: g.name, final: stateHash(s), days: s.clock.elapsedDays, reason: s.result?.reason ?? 'unfinished', rejects, counts, log });
  }
  out[id] = { games };
  if (extra > 0) {
    const sum: Counts = {};
    for (const x of games) for (const [k, n] of Object.entries(x.counts)) sum[k] = (sum[k] ?? 0) + n;
    const rejects = games.reduce((a, x) => a + x.rejects, 0);
    console.log(`${id} ${games.length} 局 rejects=${rejects} ${JSON.stringify(Object.fromEntries(Object.entries(sum).sort()))}`);
  } else {
    for (const x of games)
      console.log(`${id} ${x.name}: ${x.final.slice(0, 12)} ${x.days}d ${x.reason} rejects=${x.rejects} ${JSON.stringify(x.counts)}`);
  }
}
mkdirSync('.cache/vehstow/golden', { recursive: true });
writeFileSync(`.cache/vehstow/golden/vehicles-${label}.json`, `${JSON.stringify(out, null, 1)}\n`);
console.log(`写入 .cache/vehstow/golden/vehicles-${label}.json`);
