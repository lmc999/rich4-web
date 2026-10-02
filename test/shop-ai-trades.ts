// 调研：电脑（原版 AI）在百货公司买道具的实际行为——与 golden 同一套驱动（四座位都是 OriginalAiPolicy，
// 座位视角 projectState + makeAiContext），跑 golden 的 4 局（可加种子），统计 SHOP_TRADE：
//   buyItem 的 qty 是否都为 1、同一次进店里同一道具是否买过两次、sellItem 的 qty 分布。
// 用来判断「按原版改成每次进店每种道具只能买 1 个」会不会改变电脑的购买行为（从而改变 golden）。只读，不写任何文件。
// 用法：RICH4_DATA_DIR=./rich4-data npx tsx test/shop-ai-trades.ts [taiwan,china,japan,usa] [--extra=8]
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeAiContext, OriginalAiPolicy } from '../packages/shared/src/ai';
import { buildFixtureMaps, createRegistry, parseMapDef, TABLES } from '../packages/shared/src/data';
import { internal } from '../packages/shared/src/engine/api';
import { isIntentAllowed } from '../packages/shared/src/engine/decisions/allowed';
import { EngineRuleError } from '../packages/shared/src/engine/errors';
import { DEFAULT_CHARACTERS, decisionForSeat, makeConfig } from '../packages/shared/src/engine/testing';
import type { GameEvent } from '../packages/shared/src/engine/types/events';
import type { SeatIndex, TimeLimitDays } from '../packages/shared/src/engine/types/ids';
import { type GameAction, type PlayerIntent, PlayerIntentSchema } from '../packages/shared/src/engine/types/intent';
import type { GameState } from '../packages/shared/src/engine/types/state';
import { projectState } from '../packages/shared/src/view';

const dataDir = resolve(process.env.RICH4_DATA_DIR ?? './rich4-data');
const args = process.argv.slice(2);
const maps = (args.find((a) => !a.startsWith('--')) ?? 'taiwan,china,japan,usa').split(',');
const extra = Number(args.find((a) => a.startsWith('--extra='))?.slice(8) ?? 0);

const GAMES: { seed: string; days: TimeLimitDays; chars: readonly number[] }[] = [
  { seed: '7a1a0001', days: 30, chars: DEFAULT_CHARACTERS },
  { seed: '7a1a0002', days: 91, chars: [0, 5, 7, 11] },
  { seed: '7a1a0003', days: 182, chars: [1, 2, 6, 10] },
  { seed: '7a1a0004', days: 365, chars: [3, 4, 8, 9] },
];
for (let i = 0; i < extra; i++) {
  GAMES.push({ seed: `5b0b${String(i).padStart(4, '0')}`, days: 182, chars: [i % 12, (i + 3) % 12, (i + 6) % 12, (i + 9) % 12] });
}

const manifest = JSON.parse(readFileSync(resolve(dataDir, 'manifest.json'), 'utf8')) as {
  maps: { id: string; file: string }[];
};

const total = { visits: 0, buyItem: 0, buyItemQtyGt1: 0, dupInVisit: 0, sellItem: 0, sellItemQtyGt1: 0, rejects: 0 };
for (const id of maps) {
  const entry = manifest.maps.find((m) => m.id === id);
  if (!entry || !existsSync(resolve(dataDir, entry.file))) {
    console.log(`${id}: 数据包里没有，跳过`);
    continue;
  }
  const def = parseMapDef(JSON.parse(readFileSync(resolve(dataDir, entry.file), 'utf8')));
  const registry = createRegistry([...buildFixtureMaps().filter((x) => x.id !== def.id), def], { tables: TABLES });
  const map = registry.getMap(id as never);
  for (const g of GAMES) {
    const engine = internal.createEngine(registry, { devChecks: false });
    const config = makeConfig({ map: id as never, config: { timeLimitDays: g.days }, debug: false });
    const setups = g.chars.map((c, i) => ({ seat: i as SeatIndex, character: c as never, controller: 'ai' as const }));
    const created = engine.createGameWithEvents(config, setups, g.seed);
    let s: GameState = created.state;
    const all: GameEvent[] = [...created.events];
    let actions = 0;
    while (s.status === 'playing' && actions < 200_000) {
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
      } else total.rejects++;
      let r: ReturnType<typeof engine.applyAction>;
      try {
        r = engine.applyAction(s, action);
      } catch (e) {
        if (!(e instanceof EngineRuleError) || action === fallback) throw e;
        total.rejects++;
        r = engine.applyAction(s, fallback);
      }
      s = r.state;
      all.push(...r.events);
      actions++;
    }
    // 按进店分组：SHOP_OPENED 开一段，之后同座位的 SHOP_TRADE 属于这一段
    const visit = new Map<number, Set<number>>();
    const g0 = { ...total };
    for (const e of all) {
      if (e.type === 'SHOP_OPENED') {
        visit.set(e.seat, new Set());
        total.visits++;
      } else if (e.type === 'SHOP_TRADE') {
        if (e.op === 'buyItem' && e.item !== null) {
          total.buyItem++;
          if (e.qty > 1) total.buyItemQtyGt1++;
          const set = visit.get(e.seat) ?? new Set<number>();
          if (set.has(e.item)) total.dupInVisit++;
          set.add(e.item);
          visit.set(e.seat, set);
        } else if (e.op === 'sellItem') {
          total.sellItem++;
          if (e.qty > 1) total.sellItemQtyGt1++;
        }
      }
    }
    console.log(
      `${id} ${g.seed} ${g.days}天：进店 ${total.visits - g0.visits}，买道具 ${total.buyItem - g0.buyItem}` +
        `（qty>1 ${total.buyItemQtyGt1 - g0.buyItemQtyGt1}，同店重复 ${total.dupInVisit - g0.dupInVisit}），` +
        `卖道具 ${total.sellItem - g0.sellItem}（qty>1 ${total.sellItemQtyGt1 - g0.sellItemQtyGt1}）`,
    );
  }
}
console.log(`合计 ${JSON.stringify(total)}`);
