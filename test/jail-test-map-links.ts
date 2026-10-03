// 调试（获释位置 E2E）：fixture 'test' 关押格 14 / 15 附近的邻格与候选（只读）
// 用法：npx tsx test/jail-test-map-links.ts
import { fixtureRegistry } from '../packages/shared/src/data/maps/registry';

const ix = fixtureRegistry.getMap('test');
for (const id of [7, 8, 9, 11, 12, 13, 14, 15, 16]) {
  console.log(id, ix.tile(id).landingCode, JSON.stringify(ix.tile(id).links), 'cands(self)', ix.forwardCandidates(id, id));
}
console.log('jail', ix.jailHold, ix.jailGate, 'hosp', ix.hospitalHold, ix.hospitalGate);
console.log('12 from 11', ix.forwardCandidates(12, 11), '13 from 12', ix.forwardCandidates(13, 12));
