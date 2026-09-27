import { scenario } from '../packages/shared/src/engine/testing/scenario';
const sc = scenario({ players: ['human', 'human'] })
  .untilMenu(0)
  .bench(1)
  .edit((s) => {
    Object.assign(s.facilities[0]!, { owner: 0, level: 2, type: 'lab' });
  });
sc.teleport(0, 16, 15).force('dice', 1).roll(0).expectAsk(0, 'UPGRADE_FACILITY').decline(0);
sc.act(0, { type: 'RESEARCH', project: 2 });
const n = sc.log.length;
sc.until((s) => s.players[0]!.items[10] === 1, 2000);
console.log(sc.log.slice(n).filter(e=>!['MARKET_TICK','DAY_END','DAY_ADVANCED','TURN_ENDED'].includes(e.type)).map((e) => e.type + ' ' + JSON.stringify({ ...e, post: undefined })).join('\n'));
