// 临时调试：检查 rich4-data 下的台湾 MapDef 能否被 shared 的 parse/validate/registry/mapIndex 接受
// 只打印摘要，不写任何文件。用法：npx tsx test/smoke-taiwan-registry.ts
import { readFileSync } from 'node:fs';
import {
  buildMapIndex,
  computeMapDataHash,
  createRegistry,
  type MapDef,
  parseMapDef,
  validateMap,
} from '../packages/shared/src/data/index';

const raw: unknown = JSON.parse(readFileSync('rich4-data/maps/taiwan.map.json', 'utf8'));
const def: MapDef = parseMapDef(raw);
console.log('parse ok', def.id, 'hash ok', computeMapDataHash(def) === def.meta.dataHash);
const r = validateMap(def, {
  strict4: true,
  expect: { nodes: 103, lands: 50, facilities: 4, companies: 3, landscapes: 21 },
});
const tally: Record<string, number> = {};
for (const i of r.issues) tally[`${i.severity}:${i.code}`] = (tally[`${i.severity}:${i.code}`] ?? 0) + 1;
console.log('validate strict4 ok=', r.ok, tally);
const reg = createRegistry([def]);
const idx = reg.getMap(def.id, def.meta.dataHash);
console.log('gates', {
  jailGate: idx.jailGate,
  hospitalGate: idx.hospitalGate,
  jailHold: idx.jailHold,
  hospitalHold: idx.hospitalHold,
});
let forks = 0;
let dead = 0;
for (const t of def.tiles) {
  for (const l of t.links) {
    const c = idx.forwardCandidates(t.id, l.to);
    if (c.length > 1) forks++;
    if (c.length === 0) dead++;
  }
}
console.log('forward: forks', forks, 'deadends', dead, 'placeable', idx.placeableTiles().length);
const center = def.tiles[0]!.world;
console.log('lotsInWindow(tile1)', idx.lotsInWindow(center, 220).length);
console.log('same index cached', buildMapIndex(def) === idx);
