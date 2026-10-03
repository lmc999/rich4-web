// 调试（获释位置整体验证）：合并 test/jail-verify-sim.ts 各分片的逐局输出（只读）。
// 用法：npx tsx test/jail-verify-sim-merge.ts <分片文件…>
// 输出：局数、finalHash（与 `npm run sim` 同算法：fnv1a64(各局 stateHash 以逗号连接)，局号须从 0 连续）、
//       每局小游戏次数、坐牢 / 住院获释次数与 RETURNED 落点、获释后第一步的分布（支线 / 环路两个方向 / 被打断）
import { readFileSync } from 'node:fs';
import { fnv1a64 } from '@rich4/shared/util';

interface Rel {
  from: string;
  node: number;
  first: number | null;
  how: string;
}
interface Row {
  g: number;
  map: string;
  hash: string;
  rejects: number;
  minigames: number;
  gateReturns: number;
  releases: Rel[];
  holds: Record<string, number>;
  gates: Record<string, number>;
}

const rows: Row[] = [];
for (const f of process.argv.slice(2)) {
  for (const line of readFileSync(f, 'utf8').split('\n')) if (line.trim().startsWith('{')) rows.push(JSON.parse(line));
}
rows.sort((a, b) => a.g - b.g);
const contiguous = rows.every((r, i) => r.g === i);
const n = rows.length;
const sum = (f: (r: Row) => number): number => rows.reduce((a, r) => a + f(r), 0);
const out: Record<string, unknown> = {
  map: rows[0]?.map,
  games: n,
  contiguous,
  finalHash: contiguous ? fnv1a64(rows.map((r) => r.hash).join(',')) : null,
  rejects: sum((r) => r.rejects),
  holds: rows[0]?.holds,
  gates: rows[0]?.gates,
  minigamesPerGame: Math.round((sum((r) => r.minigames) / n) * 100) / 100,
  gamesWithMinigame: rows.filter((r) => r.minigames > 0).length,
  gateReturns: sum((r) => r.gateReturns),
};
for (const from of ['jail', 'hospital']) {
  const rel = rows.flatMap((r) => r.releases.filter((x) => x.from === from));
  const nodes: Record<string, number> = {};
  const how: Record<string, number> = {};
  const first: Record<string, number> = {};
  for (const x of rel) {
    nodes[x.node] = (nodes[x.node] ?? 0) + 1;
    how[x.how] = (how[x.how] ?? 0) + 1;
    if (x.first !== null) first[x.first] = (first[x.first] ?? 0) + 1;
  }
  out[from] = {
    releases: rel.length,
    perGame: Math.round((rel.length / n) * 100) / 100,
    returnedNode: nodes,
    afterRelease: how,
    firstStep: first,
  };
}
console.log(JSON.stringify(out, null, 1));
