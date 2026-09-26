// 临时调试：统计 OriginalAiPolicy 自对弈的破产原因、事件分布（M4）
import { makeAiContext, OriginalAiPolicy } from '@rich4/shared/ai';
import { fixtureRegistry } from '@rich4/shared/data';
import { type GameAction, internal, type SeatIndex } from '@rich4/shared/engine';
import { DEFAULT_CHARACTERS, decisionForSeat, makeConfig, simpleView } from '@rich4/shared/engine-testing';
import type { DecisionForYou, GameView } from '@rich4/shared/view';

const map = process.argv[2] ?? 'test-allkinds';
const games = Number(process.argv[3] ?? 10);
const engine = internal.createEngine(fixtureRegistry);
const causes: Record<string, number> = {};
const kinds: Record<string, number> = {};
const evs: Record<string, number> = {};
for (let g = 0; g < games; g++) {
  const config = makeConfig({ map, config: { timeLimitDays: 365 }, debug: false });
  const setups = [0, 1, 2, 3].map((i) => ({
    seat: i as SeatIndex,
    character: DEFAULT_CHARACTERS[i]!,
    controller: 'ai' as const,
  }));
  let s = engine.createGame(config, setups, (0x1000 + g).toString(16));
  let n = 0;
  while (s.status === 'playing' && n < 100000) {
    const d = s.pending[0]!;
    kinds[d.kind] = (kinds[d.kind] ?? 0) + 1;
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
    for (const e of r.events) {
      evs[e.type] = (evs[e.type] ?? 0) + 1;
      if (e.type === 'BANKRUPT') {
        const k = `${e.cause.k}:${String(e.cause.ref)}`;
        causes[k] = (causes[k] ?? 0) + 1;
      }
    }
    s = r.state;
    n++;
  }
  console.log(
    `game ${g}: ${s.result?.reason} day ${s.clock.elapsedDays} PI ${s.econ.priceIndex} pool ${s.econ.pool} worth ${s.result?.ranking.map((x) => x.netWorth).join(',')}`,
  );
}
console.log('bankrupt causes', causes);
console.log('decisions', kinds);
console.log('events', Object.fromEntries(Object.entries(evs).sort((a, b) => b[1] - a[1])));
