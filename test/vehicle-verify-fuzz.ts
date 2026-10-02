// 验证（收起交通工具 STOW_VEHICLE）：随机对局里把 STOW_VEHICLE 加进真人 TURN_MENU 的候选（options.vehicle.canStow 时），
// 机车 / 汽车 / 步行开局各跑若干局，每一步之后跑 explainState（道具池守恒、背包上限等全部不变量），
// 并逐次核对收起的效果：步行、1 颗骰子、背包同种车 +1（或满 10 台时回库存）、回合菜单重发且 vehicle.canStow=false。
// testing/randomIntent.ts 的 candidateIntents 已含 STOW_VEHICLE（修复轮加入）；这里另外按 35% 概率直接收起，并核对 VEHICLE.stowed。
// 用法：npx tsx test/vehicle-verify-fuzz.ts [局数=60]
import { newGame } from '../packages/shared/src/engine/testing/builders';
import { candidateIntents, intentHint } from '../packages/shared/src/engine/testing/randomIntent';
import type { TurnMenuOptions } from '../packages/shared/src/engine/types/decision';
import type { GameAction, PlayerIntent } from '../packages/shared/src/engine/types/intent';
import type { GameState } from '../packages/shared/src/engine/types/state';

const RUNS = Number(process.argv[2] ?? 60);
let stows = 0;
let rejected = 0;
let steps = 0;
let reequips = 0;

function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0x100000000;
  };
}

for (let run = 0; run < RUNS; run++) {
  const vehicle = (['moto', 'car', 'walk'] as const)[run % 3];
  const map = run % 2 === 0 ? 'test' : 'test-allkinds';
  const r = rng(0x9e3779b9 ^ (run * 2654435761));
  const g = newGame({
    map,
    seed: (run * 7919).toString(16).padStart(2, '0'),
    players: ['human', 'ai', 'human'],
    config: { timeLimitDays: 30, vehicle },
  });
  let s: GameState = g.state;
  for (let i = 0; i < 400 && s.status === 'playing'; i++) {
    const d = s.pending[Math.floor(r() * s.pending.length)]!;
    let cands: PlayerIntent[] = candidateIntents(d, intentHint(s));
    let stowNow = false;
    if (d.kind === 'TURN_MENU') {
      const o = d.options as TurnMenuOptions;
      const p = s.players.find((x) => x.seat === d.seat)!;
      if (o.vehicle === undefined) throw new Error('TURN_MENU 缺 vehicle 字段');
      const expectCan = p.vehicle === 'moto' || p.vehicle === 'car';
      if (o.vehicle.canStow !== expectCan || o.vehicle.current !== p.vehicle) {
        throw new Error(`run ${run}: options.vehicle ${JSON.stringify(o.vehicle)} 与玩家 ${p.vehicle} 不符`);
      }
      // 偶尔对不能收起的也提交一次，确认被拒且状态不变
      if (!o.vehicle.canStow && r() < 0.05) {
        let threw = false;
        try {
          g.engine.applyAction(s, { type: 'STOW_VEHICLE', seat: d.seat, decisionId: d.id } as GameAction);
        } catch (e) {
          threw = /NOT_USABLE|MENU_LIMIT/.test(String(e));
        }
        if (!threw) throw new Error(`run ${run}: 不能收起时没有被拒`);
        rejected++;
      }
      if (o.vehicle.canStow && o.menuActions.used < o.menuActions.limit && r() < 0.35) stowNow = true;
      else if (o.vehicle.canStow && !cands.some((c) => c.type === 'STOW_VEHICLE')) cands = [...cands, { type: 'STOW_VEHICLE' }];
    }
    const intent: PlayerIntent = stowNow ? { type: 'STOW_VEHICLE' } : cands[Math.floor(r() * cands.length)]!;
    const before = s.players.find((x) => x.seat === d.seat)!;
    const res = g.engine.applyAction(s, { ...intent, seat: d.seat, decisionId: d.id } as GameAction);
    const after = res.state.players.find((x) => x.seat === d.seat)!;
    if (intent.type === 'STOW_VEHICLE') {
      stows++;
      const item = before.vehicle === 'moto' ? 5 : 6;
      const b0 = before.items[item] ?? 0;
      const b1 = after.items[item] ?? 0;
      const pool0 = s.pools.items[item] ?? 0;
      const pool1 = res.state.pools.items[item] ?? 0;
      const okBag = b0 < 10 ? b1 === b0 + 1 && pool1 === pool0 : b1 === b0 && pool1 === pool0 + 1;
      if (after.vehicle !== 'walk' || after.diceCount !== 1 || !okBag) {
        throw new Error(`run ${run}: 收起结果不对 ${JSON.stringify({ before: before.vehicle, after, b0, b1 })}`);
      }
      const ev = res.events.map((e) => e.type);
      if (ev.join(',') !== 'VEHICLE') throw new Error(`run ${run}: 收起的事件 ${ev.join(',')}`);
      const stowed = (res.events[0] as { stowed?: string }).stowed;
      if (stowed !== before.vehicle) throw new Error(`run ${run}: VEHICLE.stowed=${stowed}，应为 ${before.vehicle}`);
      const nd = res.state.pending.find((x) => x.seat === d.seat);
      if (nd?.kind !== 'TURN_MENU' || (nd.options as TurnMenuOptions).vehicle?.canStow !== false) {
        throw new Error(`run ${run}: 收起后没有重发 TURN_MENU（canStow=false）`);
      }
    }
    if (intent.type === 'USE_ITEM' && (intent.item === 5 || intent.item === 6) && before.vehicle === 'walk') reequips++;
    s = res.state;
    steps++;
    const bad = g.engine.explainState(s);
    if (bad.length > 0) throw new Error(`run ${run} step ${i} (${intent.type}): ${bad.join('; ')}`);
  }
}
console.log(JSON.stringify({ runs: RUNS, steps, stows, rejected, reequipsFromWalk: reequips }));
