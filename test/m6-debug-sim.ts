// M6 调试：随机 / 原版 AI 自对弈，逐步检查 SYNC、fold 与不变量，出错时打印最近的事件与 action。
// 用法：npx tsx test/m6-debug-sim.ts [--map test-allkinds] [--games 20] [--policy random|original] [--seed 5eed]
import { OriginalAiPolicy } from '../packages/shared/src/ai/index';
import { makeAiContext } from '../packages/shared/src/ai/rng';
import { fixtureRegistry } from '../packages/shared/src/data/maps/registry';
import { internal } from '../packages/shared/src/engine/api';
import { foldPosts, publicWorld } from '../packages/shared/src/engine/core/postPatch';
import { EngineRuleError } from '../packages/shared/src/engine/errors';
import {
  DEFAULT_CHARACTERS,
  decisionForSeat,
  intentRng,
  makeConfig,
  randomAction,
  simpleView,
} from '../packages/shared/src/engine/testing/index';
import type { GameAction, GameState, SeatIndex } from '../packages/shared/src/engine/types/index';
import { fnv1a32, mix32 } from '../packages/shared/src/util/hash';
import type { DecisionForYou, GameView } from '../packages/shared/src/view/types';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1]! : d;
};
const map = opt('map', 'test-allkinds');
const games = Number(opt('games', '20'));
const policy = opt('policy', 'random');
const seed = opt('seed', '5eed');
const maxActions = Number(opt('max', '20000'));
const reg = fixtureRegistry;

let bad = 0;
for (let g = 0; g < games; g++) {
  const engine = internal.createEngine(reg, { devChecks: false });
  const seedHex = mix32(fnv1a32(seed), g).toString(16);
  const config = makeConfig({ map, config: { timeLimitDays: 365 }, debug: false });
  const setups = [0, 1, 2, 3].map((i) => ({
    seat: i as SeatIndex,
    character: DEFAULT_CHARACTERS[i]!,
    controller: 'ai' as const,
  }));
  let s: GameState = engine.createGame(config, setups, seedHex);
  const rng = intentRng(mix32(fnv1a32(seed), g, 0x1f).toString(16));
  const recent: string[] = [];
  let n = 0;
  try {
    while (s.status === 'playing' && n < maxActions) {
      let action: GameAction;
      if (policy === 'random') action = randomAction(s, rng)!;
      else {
        const d = s.pending[0]!;
        const view = simpleView(s) as GameView;
        const p = s.players.find((x) => x.seat === d.seat)!;
        const ctx = makeAiContext({
          aiSeed: s.secret.aiSeed,
          seat: d.seat,
          decisionId: d.id,
          turnNo: s.clock.turnNo,
          traits: p.aiTraits,
          map: reg.getMap(map),
          handVisibility: 'public',
        });
        const intent = OriginalAiPolicy.decide(view, decisionForSeat(d) as DecisionForYou, ctx);
        action = { ...intent, seat: d.seat, decisionId: d.id } as GameAction;
      }
      const before = JSON.parse(JSON.stringify(publicWorld(s)));
      let r: ReturnType<typeof engine.applyAction>;
      try {
        r = engine.applyAction(s, action);
      } catch (e) {
        if (e instanceof EngineRuleError) {
          console.log(`game ${g} action ${n}: REJECT ${e.rule} ${e.message} ${JSON.stringify(action).slice(0, 300)}`);
          bad++;
          const d = s.pending[0]!;
          r = engine.applyAction(s, { ...d.defaultIntent, seat: d.seat, decisionId: d.id } as GameAction);
        } else throw e;
      }
      n++;
      recent.push(`${JSON.stringify(action).slice(0, 160)} => ${r.events.map((e) => e.type).join(',')}`);
      if (recent.length > 6) recent.shift();
      const sync = r.events.find((e) => e.type === 'SYNC');
      if (sync) {
        console.log(`game ${g} action ${n}: SYNC post=${JSON.stringify(sync.post).slice(0, 600)}`);
        console.log(recent.join('\n'));
        bad++;
        break;
      }
      const folded = JSON.stringify(foldPosts(before, r.events));
      if (folded !== JSON.stringify(publicWorld(r.state))) {
        console.log(`game ${g} action ${n}: fold mismatch`);
        bad++;
        break;
      }
      const inv = engine.checkInvariants(r.state);
      if (inv.length > 0) {
        console.log(`game ${g} action ${n}: ${inv.slice(0, 3).join('; ')}`);
        console.log(recent.join('\n'));
        bad++;
        break;
      }
      s = r.state;
    }
  } catch (e) {
    console.log(`game ${g} action ${n}: ERROR ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    console.log(recent.join('\n'));
    bad++;
  }
}
console.log(`done bad=${bad}`);
