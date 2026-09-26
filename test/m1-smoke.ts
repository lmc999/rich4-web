// 临时调试脚本：跑一局 M1 引擎，打印事件统计
import { fixtureRegistry } from '../packages/shared/src/data/maps/registry';
import { internal } from '../packages/shared/src/engine/api';
import { defaultGameConfig } from '../packages/shared/src/engine/types/config';

const e = internal.createEngine(fixtureRegistry, { devChecks: true });
const cfg = defaultGameConfig('test', 20260927);
cfg.timeLimitDays = 30;
const r = e.createGameWithEvents(
  cfg,
  [
    { seat: 0, character: 9, controller: 'human' },
    { seat: 1, character: 4, controller: 'ai' },
    { seat: 2, character: 0, controller: 'ai' },
  ],
  'c0ffee',
);
let s = r.state;
console.log(r.events.map((x) => x.type).join(' '));
const counts: Record<string, number> = {};
let n = 0;
while (s.status === 'playing' && n < 5000) {
  const [d] = e.getPendingDecisions(s);
  const intent =
    d.kind === 'TURN_MENU'
      ? { type: 'ROLL' as const }
      : d.kind === 'BUY_LAND' || d.kind === 'UPGRADE_LAND'
        ? { type: 'CONFIRM' as const }
        : d.defaultIntent;
  const out = e.applyAction(s, { ...intent, seat: d.seat, decisionId: d.id } as never);
  s = out.state;
  for (const ev of out.events) counts[ev.type] = (counts[ev.type] ?? 0) + 1;
  n++;
  const bad = e.explainState(s);
  if (bad.length) {
    console.log('INVARIANT', n, bad);
    break;
  }
}
console.log(n, s.status, s.result, counts);
console.log(s.players.map((p) => [p.seat, p.cash, p.deposit, p.points, p.cards.length, p.alive]));
