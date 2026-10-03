// 调试（获释位置）：打印 fixture test-industries 关押格附近的邻格与 forwardCandidates（只读）
// 用法：npx tsx test/jail-fixture-links.ts
import { buildMapIndex } from '../packages/shared/src/data/maps/mapIndex';
import { buildTestMapIndustries } from '../packages/shared/src/data/maps/fixtures/testMap';

const def = buildTestMapIndustries();
const ix = buildMapIndex(def);
for (const id of [16, 19, 20, 21, 25, 26]) {
  console.log(id, JSON.stringify(ix.tile(id).links), 'cands(self)=', ix.forwardCandidates(id, id));
}
console.log('jailHold', ix.jailHold, 'jailGate', ix.jailGate, 'hospHold', ix.hospitalHold, 'hospGate', ix.hospitalGate);
console.log('16 from 25', ix.forwardCandidates(16, 25));
