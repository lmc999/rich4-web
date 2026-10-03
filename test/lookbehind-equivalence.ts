// 调试（AI lookbehind 按原版改动）：在四张原版图与 fixture 图的每个 (节点, 来路) 组合上，用同一组 rng 种子比较
//   - 新 lookahead 与改动前的实现完全相同（共用循环重构不改前瞻）；
//   - 新 lookbehind(6) 一般情形 = 旧 lookbehind(7) 去掉第一格（来路格），即整体往后挪一格；
//     来路 = 节点（获释）时 = 旧 lookbehind(6)（[关押格, 邻格…] 不变）。
// 用法：RICH4_DATA_DIR=./rich4-data npx tsx test/lookbehind-equivalence.ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AiView, aiRngFromSeed } from '@rich4/shared/ai';
import type { AiRng } from '@rich4/shared/ai';
import { buildFixtureMaps, createRegistry, type MapDef, type MapIndex, parseMapDef, TABLES } from '@rich4/shared/data';
import type { GameView } from '@rich4/shared/view';

const dataDir = resolve(process.env.RICH4_DATA_DIR ?? './rich4-data');
const manifest = JSON.parse(readFileSync(resolve(dataDir, 'manifest.json'), 'utf8')) as { maps: { id: string; file: string }[] };
const defs: MapDef[] = buildFixtureMaps();
for (const m of manifest.maps) defs.push(parseMapDef(JSON.parse(readFileSync(resolve(dataDir, m.file), 'utf8'))));
const reg = createRegistry(defs, { tables: TABLES });

/** 改动前的实现（原样复制） */
function oldLookahead(map: MapIndex, node: number, prevNode: number, n: number, rng: AiRng) {
  let at = node;
  let prev = prevNode;
  const nodes: number[] = [];
  let forked = false;
  for (let i = 0; i < n; i++) {
    const cands = map.forwardCandidates(at, prev);
    let next: number;
    if (cands.length === 0) next = prev;
    else if (cands.length === 1) next = cands[0]!;
    else {
      forked = true;
      next = cands[rng.mod(cands.length)]!;
    }
    prev = at;
    at = next;
    nodes.push(at);
  }
  return { nodes, forked };
}

function oldLookbehind(map: MapIndex, node: number, prevNode: number, n: number, rng: AiRng) {
  const nodes: number[] = [];
  let forked = false;
  if (prevNode === 0) return { nodes, forked };
  let prev = node;
  let at = prevNode;
  nodes.push(at);
  for (let i = 1; i < n; i++) {
    const cands = map.forwardCandidates(at, prev);
    let next: number;
    if (cands.length === 0) next = prev;
    else if (cands.length === 1) next = cands[0]!;
    else {
      forked = true;
      next = cands[rng.mod(cands.length)]!;
    }
    prev = at;
    at = next;
    nodes.push(at);
  }
  return { nodes, forked };
}

function view(node: number, prevNode: number): GameView {
  return { players: [{ seat: 0, placed: true, node, prevNode }] } as unknown as GameView;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
let fail = 0;
for (const def of defs) {
  const map = reg.getMap(def.id);
  let pairs = 0;
  let forks = 0;
  for (const t of def.tiles) {
    const prevs = [...new Set([...t.links.map((l) => l.to), t.id])];
    for (const prev of prevs) {
      pairs++;
      for (let seed = 1; seed <= 25; seed++) {
        const v = new AiView(view(t.id, prev), 0, map);
        const la = v.lookahead(6, aiRngFromSeed(seed));
        const lo = oldLookahead(map, t.id, prev, 6, aiRngFromSeed(seed));
        if (!same(la, lo)) {
          fail++;
          if (fail < 10) console.log(`lookahead ${def.id} ${t.id}<-${prev} seed ${seed}`, la, lo);
        }
        const lb = v.lookbehind(6, aiRngFromSeed(seed));
        if (lb.forked) forks++;
        const want =
          prev === t.id
            ? oldLookbehind(map, t.id, prev, 6, aiRngFromSeed(seed))
            : (() => {
                const o = oldLookbehind(map, t.id, prev, 7, aiRngFromSeed(seed));
                // 旧实现第一格（来路格）不经过岔路判定，所以 forked 只看后 6 格的判定——两者的随机数序列相同
                return { nodes: o.nodes.slice(1), forked: o.forked };
              })();
        if (!same(lb, want)) {
          fail++;
          if (fail < 10) console.log(`lookbehind ${def.id} ${t.id}<-${prev} seed ${seed}`, lb, want);
        }
      }
    }
  }
  console.log(`${def.id}: ${pairs} 个 (节点, 来路) 组合 × 25 个种子，lookbehind 遇岔 ${forks} 次`);
}
console.log(fail === 0 ? '全部一致' : `不一致 ${fail} 处`);
process.exit(fail === 0 ? 0 : 1);
