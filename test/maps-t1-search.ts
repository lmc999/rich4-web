/**
 * T1 调试脚本：在指定路格附近枚举 nodeCell（以及可选的 edgeRoute 候选），跑真实的 buildMapDef，
 * 按「几何 error、偏侧住宅地、W_TILES_TOUCH、位移」打分，打印最好的几组 overrides。
 * 只读 original/ 与 tools/extract/maps/<key>.overrides.json，不写任何文件。
 *
 * 用法（仓库根）：npx tsx test/maps-t1-search.ts <key> --tiles 76,77,78 [--r 1] [--top 8] [--focus L36,L37]
 *   --r：每个路格在当前格点周围 ±r 的范围内枚举（包括不动）
 *   --focus：只关心这些地块是否偏侧（缺省看全图）
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ExtractContext } from '../tools/extract/src/context';
import { loadKnownFiles } from '../tools/extract/src/fingerprint/identify';
import { buildMapDef } from '../tools/extract/src/map/build';
import { facingDirs } from '../tools/extract/src/map/geometry/placeLands';
import { dirIndex } from '../tools/extract/src/map/geometry/types';
import { parseOverrides } from '../tools/extract/src/map/overrides';
import { MAP_KEYS } from '../tools/extract/src/map/pack';
import { loadRawSource, sourceDef } from '../tools/extract/src/map/sources';

const { values: v, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    tiles: { type: 'string' },
    r: { type: 'string' },
    top: { type: 'string' },
    focus: { type: 'string' },
    ov: { type: 'string' },
  },
});
const key = positionals[0]!;
const gm = MAP_KEYS[key]!;
const tiles = (v.tiles ?? '').split(',').filter(Boolean).map(Number);
const R = Number(v.r ?? 1);
const TOP = Number(v.top ?? 8);
const focus = v.focus ? new Set(v.focus.split(',')) : null;
const ctx = new ExtractContext({ logger: { out: () => {}, err: () => {} } });
const ovFile = v.ov ?? `tools/extract/maps/${key}.overrides.json`;
const baseOv = JSON.parse(readFileSync(ovFile, 'utf8'));
const known = await loadKnownFiles(ctx.packageDir);
const { raw } = await loadRawSource(ctx, sourceDef(baseOv.source.id), gm, known);

type Score = { score: number; desc: string; nodeCell: Record<string, [number, number]> };
function evaluate(nodeCell: Record<string, [number, number]>): Score | null {
  const ov = parseOverrides({ ...baseOv, nodeCell: { ...baseOv.nodeCell, ...nodeCell } });
  let r: ReturnType<typeof buildMapDef>;
  try {
    r = buildMapDef(raw, ov, { mapKey: key, strict4: true });
  } catch {
    return null;
  }
  const g = r.geometry.report;
  const geoErr = g.issues.filter((i) => i.severity === 'error').length;
  const valErr = r.classified.filter((i) => i.class === 'error').length;
  // 偏侧自己算（报告里的 landsOffSide 只在 facing 假设启用时才算，不能拿来打分）
  const offSide: string[] = [];
  const cellOf = new Map(r.def.tiles.map((t) => [t.id, t.cell]));
  for (const l of r.def.lots) {
    if (l.kind !== 'land' || l.rect.w !== 1 || l.rect.h !== 1) continue;
    const fc = cellOf.get(l.frontTiles[0]!)!;
    if (!facingDirs(l.facing, r.geometry.lattice.transform).includes(dirIndex(fc, { x: l.rect.x, y: l.rect.y })))
      offSide.push(l.id);
  }
  const off = offSide.filter((id) => !focus || focus.has(id));
  const touch = g.unlinkedAdjacent.length;
  const offAll = offSide.length;
  const facingOff = g.facing.enabled ? 0 : 1;
  // 位移：被改动的路格离世界坐标（格点浮点）的距离之和，作并列时的次序
  let disp = 0;
  for (const [id, c] of Object.entries(nodeCell)) {
    const w = r.geometry.toLattice(raw.nodes.find((n) => n.id === Number(id))!);
    disp += Math.hypot(c[0] - w.x, c[1] - w.y);
  }
  // 企业小于 2×2（只能退到 1×1）视觉上偏小：每个 +30
  const small = r.def.companies.filter((c) => c.rect.w * c.rect.h < 4).map((c) => c.id);
  const score =
    geoErr * 10000 + valErr * 1000 + facingOff * 500 + off.length * 100 + offAll * 20 + touch * 50 + small.length * 30 + disp;
  return {
    score,
    desc: `disp ${disp.toFixed(2)} small ${small.join(',') || '-'} geoErr ${geoErr} valErr ${valErr} facing ${g.facing.enabled ? 'on' : 'OFF'} ${g.facing.consistent}/${g.facing.samples} offSide ${offSide.join(',') || '-'} touch ${JSON.stringify(g.unlinkedAdjacent)} viaCells ${g.routes.viaCells}`,
    nodeCell,
  };
}

// 当前格点：先跑一遍基线
const base = buildMapDef(raw, parseOverrides(baseOv), { mapKey: key, strict4: true });
const sh = base.geometry.report.bounds.shift;
const cur = new Map<number, [number, number]>();
for (const t of tiles) {
  const c = base.geometry.tileCells.get(t)!;
  cur.set(t, [c.x - sh.x, c.y - sh.y]);
}
const b0 = evaluate({})!;
console.log(`基线 score ${b0.score}  ${b0.desc}`);
const results: Score[] = [];
const offsets: [number, number][] = [];
for (let dx = -R; dx <= R; dx++) for (let dy = -R; dy <= R; dy++) offsets.push([dx, dy]);
const t0 = Date.now();
function rec(i: number, acc: Record<string, [number, number]>): void {
  if (i === tiles.length) {
    const s = evaluate(acc);
    if (s) results.push(s);
    return;
  }
  const t = tiles[i]!;
  const [x, y] = cur.get(t)!;
  for (const [dx, dy] of offsets) {
    const next = { ...acc };
    if (dx !== 0 || dy !== 0) next[String(t)] = [x + dx, y + dy];
    rec(i + 1, next);
  }
}
rec(0, {});
results.sort((a, b) => a.score - b.score || Object.keys(a.nodeCell).length - Object.keys(b.nodeCell).length);
console.log(`枚举 ${results.length} 组，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
for (const r of results.slice(0, TOP)) console.log(`score ${r.score.toFixed(2)}  nodeCell ${JSON.stringify(r.nodeCell)}\n   ${r.desc}`);
