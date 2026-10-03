// 调试（获释位置）：从各图关押格出发（来路 = 关押格），列出每一步的候选，直到走到有 2 个以上候选的格或 30 步（只读）
// 用法：RICH4_DATA_DIR=./rich4-data npx tsx test/jail-branch-walk.ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseMapDef } from '../packages/shared/src/data';
import { buildMapIndex } from '../packages/shared/src/data/maps/mapIndex';

const dir = process.env.RICH4_DATA_DIR ?? './rich4-data';
for (const id of ['taiwan', 'china', 'japan', 'usa']) {
  const def = parseMapDef(JSON.parse(readFileSync(resolve(dir, `maps/${id}.map.json`), 'utf8')));
  const ix = buildMapIndex(def);
  for (const [kind, hold] of [
    ['jail', ix.jailHold],
    ['hospital', ix.hospitalHold],
  ] as const) {
    let at = hold;
    let prev = hold;
    const steps: string[] = [];
    for (let i = 0; i < 30; i++) {
      const c = ix.forwardCandidates(at, prev);
      const t = ix.tile(at);
      steps.push(`${at}(code ${t.landingCode}${c.length > 1 ? ` cands ${c.join('/')}` : ''})`);
      if (c.length !== 1) break;
      prev = at;
      at = c[0]!;
    }
    console.log(id, kind, 'gate', kind === 'jail' ? ix.jailGate : ix.hospitalGate, ':', steps.join(' → '));
  }
}
