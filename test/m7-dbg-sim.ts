// M7 调试：复现 simulate.ts 的某一局（--policy original），出错时打印最后几步的事件与调用栈。
// 用法：npx tsx test/m7-dbg-sim.ts <gameIdx> [timeLimit=365] [map=test-allkinds]
import { OriginalAiPolicy } from '../packages/shared/src/ai/index';
import { fixtureRegistry } from '../packages/shared/src/data/index';
import { internal, type GameAction, type GameState, type SeatIndex } from '../packages/shared/src/engine/index';
import {
  DEFAULT_CHARACTERS,
  decisionForSeat,
  makeConfig,
  simpleView,
} from '../packages/shared/src/engine/testing/index';
import { fnv1a32, mix32, WatcomRng } from '../packages/shared/src/util/index';

const gameIdx = Number(process.argv[2] ?? 0);
const timeLimit = Number(process.argv[3] ?? 365);
const map = process.argv[4] ?? 'test-allkinds';
const reg = fixtureRegistry;
const engine = internal.createEngine(reg);
const seedHex = mix32(fnv1a32('5eed'), gameIdx).toString(16);
const config = makeConfig({ map, config: { timeLimitDays: timeLimit as 365 }, debug: false });
const setups = Array.from({ length: 4 }, (_, i) => ({
  seat: i as SeatIndex,
  character: DEFAULT_CHARACTERS[i]!,
  controller: 'ai' as const,
}));
function aiRng(seed: number) {
  const w = WatcomRng.fromSeed(seed);
  return { next15: () => w.rand15(), mod: (n: number) => w.int(n), bit: () => (w.rand15() & 1) as 0 | 1, scale: (n: number) => w.scale(n) };
}
let s: GameState = engine.createGame(config, setups, seedHex);
const hist: string[] = [];
for (let n = 1; n <= 400 && s.status === 'playing'; n++) {
  const d = s.pending[0]!;
  const view = simpleView(s) as never;
  const p = s.players.find((x) => x.seat === d.seat)!;
  const ctx = {
    seat: d.seat,
    traits: p.aiTraits,
    rng: aiRng(mix32(s.secret.aiSeed, d.seat, fnv1a32(d.id))),
    turnRng: (salt: string) => aiRng(mix32(s.secret.aiSeed, d.seat, s.clock.turnNo, fnv1a32(salt))),
    map: reg.getMap(s.dataRef.mapId),
    handVisibility: 'public' as const,
  };
  const intent = OriginalAiPolicy.decide(view, decisionForSeat(d) as never, ctx as never);
  const action = { ...intent, seat: d.seat, decisionId: d.id } as GameAction;
  hist.push(`#${n} ${d.kind} seat${d.seat} -> ${JSON.stringify(intent)}`);
  try {
    const r = engine.applyAction(s, action);
    s = r.state;
    hist.push(`   events: ${r.events.map((e) => (e.type === 'POST' || e.type === 'SYNC' ? e.type : JSON.stringify(e))).join('\n     ')}`);
  } catch (e) {
    console.log(hist.slice(-12).join('\n'));
    console.log('ERROR', e);
    process.exit(1);
  }
  const bad = engine.checkInvariants(s);
  if (bad.length > 0) {
    console.log(hist.slice(-12).join('\n'));
    console.log('INVARIANT', bad);
    console.log(JSON.stringify(s.players.map((q) => ({ seat: q.seat, node: q.node, st: q.st })), null, 0));
    process.exit(1);
  }
}
console.log('ok', s.status, s.clock.elapsedDays);
