// 临时调试：找出出局玩家总资产为负的原因
import { makeAiContext, OriginalAiPolicy } from '@rich4/shared/ai';
import { fixtureRegistry } from '@rich4/shared/data';
import { type GameAction, internal, type SeatIndex } from '@rich4/shared/engine';
import { DEFAULT_CHARACTERS, decisionForSeat, makeConfig, simpleView } from '@rich4/shared/engine-testing';
import type { DecisionForYou, GameView } from '@rich4/shared/view';

const engine = internal.createEngine(fixtureRegistry);
const map = 'test-allkinds';
const config = makeConfig({ map, config: { timeLimitDays: 365 }, debug: false });
const setups = [0, 1, 2, 3].map((i) => ({
  seat: i as SeatIndex,
  character: DEFAULT_CHARACTERS[i]!,
  controller: 'ai' as const,
}));
let s = engine.createGame(config, setups, (0x1000).toString(16));
while (s.status === 'playing') {
  const d = s.pending[0]!;
  const view = simpleView(s) as GameView;
  const p = s.players.find((x) => x.seat === d.seat)!;
  const ctx = makeAiContext({
    aiSeed: s.secret.aiSeed,
    seat: d.seat,
    decisionId: d.id,
    turnNo: view.clock.turnNo,
    traits: p.aiTraits,
    map: fixtureRegistry.getMap(map),
    handVisibility: 'public',
  });
  const intent = OriginalAiPolicy.decide(view, decisionForSeat(d) as DecisionForYou, ctx);
  const r = engine.applyAction(s, { ...intent, seat: d.seat, decisionId: d.id } as GameAction);
  for (const e of r.events)
    if (e.type === 'BANKRUPT' || e.type === 'LIQUIDATION') console.log(s.clock.date, JSON.stringify(e).slice(0, 300));
  s = r.state;
}
for (const p of s.players)
  console.log(
    p.seat,
    p.alive,
    p.cash,
    p.deposit,
    p.loan,
    p.finance,
    JSON.stringify(p.holdings.filter((h) => h.shares > 0)),
  );
console.log(
  s.lands.map((l) => `${l.id}:${l.owner}`).join(' '),
  s.facilities.map((l) => `${l.id}:${l.owner}`).join(' '),
);
