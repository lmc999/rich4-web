import { scenario } from '../packages/shared/src/engine/testing/scenario';
const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
sc.edit((s) => { const v = s.villains.find((x) => x.kind === 'robber')!; Object.assign(v, { onBoard: true, employer: 1, node: 17, prevNode: 16, leftHome: true }); });
sc.teleport(0, 3, 2).force('dice', 1).roll(0);
sc.teleport(0, 18, 17).give(0, { cards: [13] }).setCash(0, 1000, 50001).setCash(1, 0, 0);
sc.force('villainSteps', 0);
sc.teleport(1, 3, 2).force('dice', 1).roll(1);
console.log(sc.events.map((e) => e.type + ' ' + JSON.stringify({ ...e, post: undefined })).join('\n'));
console.log(JSON.stringify(sc.player(0).cards), sc.player(0).deposit, sc.player(0).cash, sc.player(1).cash);
