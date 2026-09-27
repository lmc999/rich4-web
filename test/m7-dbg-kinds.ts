import { fixtureRegistry } from '../packages/shared/src/data/maps/registry';
import { newGame } from '../packages/shared/src/engine/testing/builders';
import { decisionForSeat, simpleView } from '../packages/shared/src/engine/testing/view';
import { OriginalAiPolicy } from '../packages/shared/src/ai/policy';
import { makeAiContext } from '../packages/shared/src/ai/rng';
import type { GameAction } from '../packages/shared/src/engine/types/index';
const kinds = new Map<string, number>();
const ev = new Map<string, number>();
for (const map of ['test', 'test-allkinds']) for (const seed of ['f1', 'f2', 'f3']) {
  const g = newGame({ map, seed, players: ['ai', 'human', 'ai', 'human'], config: { timeLimitDays: 182 }, devChecks: false });
  let s = g.state;
  for (let n = 0; n < 6000 && s.status === 'playing'; n++) {
    const d = s.pending[0]!;
    kinds.set(d.kind, (kinds.get(d.kind) ?? 0) + 1);
    const ctx = makeAiContext({ aiSeed: s.secret.aiSeed, seat: d.seat, decisionId: d.id, turnNo: s.clock.turnNo, traits: s.players.find((p) => p.seat === d.seat)!.aiTraits, map: fixtureRegistry.getMap(s.dataRef.mapId), handVisibility: 'public' });
    const intent = OriginalAiPolicy.decide(simpleView(s) as never, decisionForSeat(d) as never, ctx);
    const r = g.engine.applyAction(s, { ...intent, seat: d.seat, decisionId: d.id } as GameAction);
    for (const e of r.events) ev.set(e.type, (ev.get(e.type) ?? 0) + 1);
    s = r.state;
  }
}
console.log([...kinds.entries()].sort().map(([k, v]) => `${k}:${v}`).join(' '));
console.log(['NEWS','FATE','MAGIC_CAST','AUCTION_STARTED','AUCTION_ENDED','VILLAIN_HIRED','VILLAIN_ACTION','VILLAIN_HOME','LISTING_ADDED','LISTING_SOLD','TIME_REWOUND','SURRENDERED','BEGGAR_ALMS','BANKRUPT'].map((k) => `${k}:${ev.get(k) ?? 0}`).join(' '));
