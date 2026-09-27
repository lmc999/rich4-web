// M6 调试：统计随机自对弈中各类事件出现的次数（确认对抗系统被覆盖到）。
// 用法：npx tsx test/m6-event-stats.ts [--map test-allkinds] [--games 20]
import { OriginalAiPolicy } from '../packages/shared/src/ai/index';
import { makeAiContext } from '../packages/shared/src/ai/rng';
import { fixtureRegistry } from '../packages/shared/src/data/maps/registry';
import { internal } from '../packages/shared/src/engine/api';
import {
  DEFAULT_CHARACTERS,
  decisionForSeat,
  intentRng,
  makeConfig,
  randomAction,
  simpleView,
} from '../packages/shared/src/engine/testing/index';
import type { GameAction, GameState, SeatIndex } from '../packages/shared/src/engine/types/index';
import type { DecisionForYou, GameView } from '../packages/shared/src/view/types';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1]! : d;
};
const map = opt('map', 'test-allkinds');
const games = Number(opt('games', '20'));
const policy = opt('policy', 'random');
const counts: Record<string, number> = {};
const cards: Record<string, number> = {};
const items: Record<string, number> = {};
for (let g = 0; g < games; g++) {
  const engine = internal.createEngine(fixtureRegistry);
  const config = makeConfig({ map, config: { timeLimitDays: 365 }, debug: false });
  const setups = [0, 1, 2, 3].map((i) => ({
    seat: i as SeatIndex,
    character: DEFAULT_CHARACTERS[i]!,
    controller: 'ai' as const,
  }));
  let s: GameState = engine.createGame(config, setups, (0x1000 + g).toString(16));
  const rng = intentRng((0x77 + g).toString(16));
  for (let n = 0; n < 20000 && s.status === 'playing'; n++) {
    let a: GameAction;
    if (policy === 'random') a = randomAction(s, rng)!;
    else {
      const d = s.pending[0]!;
      const p = s.players.find((x) => x.seat === d.seat)!;
      const ctx = makeAiContext({
        aiSeed: s.secret.aiSeed,
        seat: d.seat,
        decisionId: d.id,
        turnNo: s.clock.turnNo,
        traits: p.aiTraits,
        map: fixtureRegistry.getMap(map),
        handVisibility: 'public',
      });
      const intent = OriginalAiPolicy.decide(simpleView(s) as GameView, decisionForSeat(d) as DecisionForYou, ctx);
      a = { ...intent, seat: d.seat, decisionId: d.id } as GameAction;
    }
    const r = engine.applyAction(s, a);
    for (const e of r.events) {
      counts[e.type] = (counts[e.type] ?? 0) + 1;
      if (e.type === 'CARD_USED') cards[e.card] = (cards[e.card] ?? 0) + 1;
      if (e.type === 'ITEM_USED') items[e.item] = (items[e.item] ?? 0) + 1;
    }
    s = r.state;
  }
}
const keys = [
  'CARD_USED',
  'ITEM_USED',
  'PASSIVE',
  'CONFINED',
  'BAIL',
  'GOD_ATTACHED',
  'GOD_POWER',
  'GOD_LEFT',
  'GOD_SPAWNED',
  'GOD_MANIFEST',
  'DOG_BITE',
  'DOG_KNOCKED',
  'BOMB_ATTACHED',
  'BOMB_TRANSFERRED',
  'BOMB_EXPLODED',
  'STRIKE',
  'DOLL_WALK',
  'TELEPORTED',
  'ROADBLOCK_HIT',
  'OBJECT_PLACED',
  'OBJECT_REMOVED',
  'OBJECTS_RESPAWNED',
  'BEGGAR_ALMS',
  'ALLIANCE_FORMED',
  'ALLIANCE_BROKEN',
  'ALLIANCE_EXPIRED',
  'STATUS_SET',
  'VEHICLE',
  'VEHICLE_DESTROYED',
  'STOCK_FLAG',
  'MARK_SET',
  'REVERSED',
  'CARD_NO_EFFECT',
];
for (const k of keys) console.log(k.padEnd(20), counts[k] ?? 0);
console.log('cards', JSON.stringify(cards));
console.log('items', JSON.stringify(items));
