// 调试脚本（architecture §34）：复仇卡反弹时双方的座驾停放情况
// 用法：npx tsx test/vehstow-dbg-revenge.ts
import { CARD } from '../packages/shared/src/data/tables/ids';
import { scenario } from '../packages/shared/src/engine/testing/scenario';

const sc = scenario({ players: ['human', 'human'], config: { vehicle: 'car' } })
  .untilMenu(0)
  .teleport(0, 5, 4)
  .teleport(1, 6, 5);
sc.give(1, { cards: [CARD.REVENGE] });
sc.give(0, { cards: [CARD.SLEEPWALK] }).useCard(0, CARD.SLEEPWALK, { t: 'actor', actor: { t: 'seat', seat: 1 } });
console.log(sc.events.map((e) => `${e.type} ${JSON.stringify({ ...e, post: undefined })}`).join('\n'));
console.log(sc.state.players.map((p) => ({ seat: p.seat, v: p.vehicle, parked: p.parked, sw: p.st.sleepwalk })));
