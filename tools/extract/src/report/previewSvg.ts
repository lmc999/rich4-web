import type { Cell, MapDef, TileKind } from '@rich4/shared/data';
import type { ClassifiedIssue } from '../map/build';
import type { GeometryResult } from '../map/geometry/normalize';
import type { MapSemantic } from '../map/semantic';

/**
 * 预览 SVG（data-pipeline.md §8.2 第 10 步）：左栏为世界坐标下的点与线，右栏为网格结果，问题处画红圈。
 * 完全是我们自己画的示意图（色块、线段、编号），不含任何原版图像。输出只取决于输入，便于比对。
 */

const PANEL = 620;
const PAD = 24;
const HEADER = 56;

const KIND_COLOR: Record<TileKind, string> = {
  property: '#ffffff',
  plain: '#e8e8e8',
  park: '#7cc576',
  news: '#6fa8dc',
  fate: '#b4a7d6',
  jail: '#666666',
  hospital: '#e06666',
  penguin: '#76d7ea',
  balloon: '#f6b26b',
  xicong: '#ffd966',
  lottery: '#c27ba0',
  points50: '#93c47d',
  points30: '#b6d7a8',
  points10: '#d9ead3',
  card: '#8e7cc3',
  bank: '#3d85c6',
  shop: '#e69138',
  magic: '#a64d79',
};
const TERRAIN_COLOR: Record<string, string> = {
  g: '#e3f0d4',
  w: '#cfe3f7',
  s: '#f3ead0',
  m: '#d9cdb8',
  p: '#e6e6e6',
};

const f1 = (v: number): string => {
  const s = (Math.round(v * 10) / 10).toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
};
const esc = (s: string): string =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

export interface PreviewInput {
  def: MapDef;
  semantic: MapSemantic;
  geometry: GeometryResult;
  classified: readonly ClassifiedIssue[];
}

export function renderPreviewSvg({ def, semantic, geometry, classified }: PreviewInput): string {
  const out: string[] = [];
  const width = PAD * 3 + PANEL * 2;

  // ── 左栏：世界坐标 ──
  const pts = [
    ...semantic.tiles.map((t) => t.world),
    ...semantic.lands.map((l) => l.world),
    ...semantic.facilities.map((l) => l.world),
    ...semantic.companies.map((l) => l.world),
    ...semantic.landmarks.map((l) => l.world),
  ];
  const minX = Math.min(...pts.map((p) => p.x));
  const maxX = Math.max(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y));
  const maxY = Math.max(...pts.map((p) => p.y));
  const ws = PANEL / Math.max(1, maxX - minX, maxY - minY);
  const wx = (x: number) => PAD + (x - minX) * ws;
  const wy = (y: number) => HEADER + PAD + (y - minY) * ws;

  // ── 右栏：网格 ──
  const cs = Math.max(4, Math.floor(PANEL / Math.max(def.grid.w, def.grid.h)));
  const gx0 = PAD * 2 + PANEL;
  const gy0 = HEADER + PAD;
  const gx = (x: number) => gx0 + x * cs;
  const gy = (y: number) => gy0 + y * cs;
  const cx = (c: Cell) => gx(c.x) + cs / 2;
  const cy = (c: Cell) => gy(c.y) + cs / 2;
  const height = HEADER + PAD * 2 + Math.max(PANEL, def.grid.h * cs, (maxY - minY) * ws) + 28;

  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${f1(height)}" viewBox="0 0 ${width} ${f1(height)}" font-family="sans-serif">`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    `<text x="${PAD}" y="24" font-size="16" font-weight="bold">${esc(`${def.id} 预览（自绘示意，不含原版图像）`)}</text>`,
    `<text x="${PAD}" y="44" font-size="12" fill="#555">${esc(
      `左：世界坐标（节点 ${semantic.tiles.length}、住宅 ${semantic.lands.length}、设施 ${semantic.facilities.length}、企业 ${semantic.companies.length}、景观 ${semantic.landmarks.length}）；` +
        `右：网格 ${def.grid.w}×${def.grid.h}，T=${geometry.lattice.tile}（${geometry.lattice.mode}），红圈=问题`,
    )}</text>`,
  );

  // 左栏
  out.push(`<g id="world">`);
  out.push(
    `<rect x="${PAD - 4}" y="${HEADER + PAD - 4}" width="${PANEL + 8}" height="${f1((maxY - minY) * ws + 8)}" fill="#fafafa" stroke="#ddd"/>`,
  );
  const tileWorld = new Map(semantic.tiles.map((t) => [t.id, t.world]));
  for (const t of semantic.tiles) {
    for (const l of t.links) {
      if (l.to < t.id && !l.blocked) continue;
      const b = tileWorld.get(l.to);
      if (!b) continue;
      const style = l.blocked ? 'stroke="#d00" stroke-dasharray="4 3"' : 'stroke="#888"';
      out.push(
        `<line x1="${f1(wx(t.world.x))}" y1="${f1(wy(t.world.y))}" x2="${f1(wx(b.x))}" y2="${f1(wy(b.y))}" ${style}/>`,
      );
    }
  }
  const lotSq = (p: { x: number; y: number }, fill: string, size: number) =>
    `<rect x="${f1(wx(p.x) - size / 2)}" y="${f1(wy(p.y) - size / 2)}" width="${size}" height="${size}" fill="${fill}" stroke="#555" stroke-width="0.5"/>`;
  for (const l of semantic.lands) out.push(lotSq(l.world, '#f4b183', 5));
  for (const l of semantic.facilities) out.push(lotSq(l.world, '#c9a0dc', 9));
  for (const l of semantic.companies) out.push(lotSq(l.world, '#8fb3de', 9));
  for (const m of semantic.landmarks) {
    const x = wx(m.world.x);
    const y = wy(m.world.y);
    const fill = m.kind === 'hospital' ? '#e06666' : m.kind === 'jail' ? '#666' : '#a3d9a5';
    out.push(
      `<path d="M${f1(x)} ${f1(y - 6)}L${f1(x + 6)} ${f1(y + 5)}L${f1(x - 6)} ${f1(y + 5)}Z" fill="${fill}" stroke="#555" stroke-width="0.5"/>`,
    );
  }
  for (const t of semantic.tiles) {
    out.push(
      `<circle cx="${f1(wx(t.world.x))}" cy="${f1(wy(t.world.y))}" r="4" fill="${KIND_COLOR[t.kind]}" stroke="#333" stroke-width="0.7"/>`,
      `<text x="${f1(wx(t.world.x) + 5)}" y="${f1(wy(t.world.y) - 4)}" font-size="7" fill="#333">${t.id}</text>`,
    );
  }
  out.push(`</g>`);

  // 右栏
  out.push(`<g id="grid">`);
  // 先铺一层水，再按行合并同类格绘制其余地形（避免细缝）
  out.push(
    `<rect x="${gx(0)}" y="${gy(0)}" width="${def.grid.w * cs}" height="${def.grid.h * cs}" fill="${TERRAIN_COLOR.w}"/>`,
  );
  def.terrain.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x]!;
      let run = 1;
      while (x + run < row.length && row[x + run] === ch) run++;
      if (ch !== 'w') {
        out.push(
          `<rect x="${gx(x)}" y="${gy(y)}" width="${run * cs}" height="${cs}" fill="${TERRAIN_COLOR[ch] ?? '#fff'}"/>`,
        );
      }
      x += run;
    }
  });
  for (const c of def.roadCells)
    out.push(`<rect x="${gx(c.x)}" y="${gy(c.y)}" width="${cs}" height="${cs}" fill="#c8c8c8"/>`);
  const rectEl = (r: { x: number; y: number; w: number; h: number }, fill: string, label: string) => [
    `<rect x="${gx(r.x) + 0.5}" y="${gy(r.y) + 0.5}" width="${r.w * cs - 1}" height="${r.h * cs - 1}" fill="${fill}" stroke="#555" stroke-width="0.5"/>`,
    `<text x="${f1(gx(r.x) + (r.w * cs) / 2)}" y="${f1(gy(r.y) + (r.h * cs) / 2 + 2)}" font-size="${Math.max(5, cs / 2.6)}" text-anchor="middle" fill="#333">${esc(label)}</text>`,
  ];
  for (const l of def.lots) out.push(...rectEl(l.rect, l.kind === 'land' ? '#f4b183' : '#c9a0dc', l.id));
  for (const c of def.companies) out.push(...rectEl(c.rect, '#8fb3de', c.id));
  for (const m of def.landmarks) {
    const fill = m.kind === 'hospital' ? '#e06666' : m.kind === 'jail' ? '#999' : '#a3d9a5';
    out.push(...rectEl(m.rect, fill, `S${m.id}`));
  }
  const tileCell = new Map(def.tiles.map((t) => [t.id, t.cell]));
  for (const t of def.tiles) {
    for (const l of t.links) {
      if (l.to < t.id && !l.blocked) continue;
      const b = tileCell.get(l.to);
      if (!b) continue;
      const chain = [t.cell, ...(l.via ?? []), b];
      const d = chain.map((c, i) => `${i === 0 ? 'M' : 'L'}${f1(cx(c))} ${f1(cy(c))}`).join('');
      const style = l.blocked ? 'stroke="#d00" stroke-dasharray="3 2"' : 'stroke="#555"';
      out.push(`<path d="${d}" fill="none" ${style} stroke-width="1"/>`);
    }
  }
  for (const t of def.tiles) {
    out.push(
      `<rect x="${gx(t.cell.x) + 1}" y="${gy(t.cell.y) + 1}" width="${cs - 2}" height="${cs - 2}" fill="${KIND_COLOR[t.kind]}" stroke="#222" stroke-width="0.6"/>`,
      `<text x="${f1(cx(t.cell))}" y="${f1(cy(t.cell) + 2)}" font-size="${Math.max(5, cs / 2.4)}" text-anchor="middle" fill="#000">${t.id}</text>`,
    );
  }
  // 问题标记：几何问题的格/节点、validateMap 的 error/pending/contract 所涉节点
  const marks = new Map<string, Cell>();
  const mark = (c: Cell | undefined) => {
    if (c) marks.set(`${c.x},${c.y}`, c);
  };
  for (const i of geometry.report.issues) {
    if (i.severity === 'info') continue;
    for (const c of i.cells ?? []) mark(c);
    for (const id of i.tiles ?? []) mark(tileCell.get(id));
  }
  for (const i of classified) {
    if (i.class === 'warn') continue;
    for (const c of i.cells ?? []) mark(c);
    for (const id of i.tiles ?? []) mark(tileCell.get(id));
  }
  for (const c of [...marks.values()].sort((a, b) => a.y - b.y || a.x - b.x)) {
    out.push(
      `<circle cx="${f1(cx(c))}" cy="${f1(cy(c))}" r="${f1(cs * 0.9)}" fill="none" stroke="#e00" stroke-width="1.5"/>`,
    );
  }
  out.push(`</g>`);

  // 图例
  const ly = height - 12;
  const legend: [string, string][] = [
    ['#ffffff', '地产'],
    ['#e8e8e8', '普通'],
    ['#c8c8c8', '连接格 via'],
    ['#f4b183', '住宅地'],
    ['#c9a0dc', '设施'],
    ['#8fb3de', '企业'],
    ['#a3d9a5', '风景'],
    ['#e06666', '医院'],
    ['#999999', '监狱'],
  ];
  legend.forEach(([fill, label], i) => {
    const x = PAD + i * 96;
    out.push(
      `<rect x="${x}" y="${f1(ly - 9)}" width="10" height="10" fill="${fill}" stroke="#555" stroke-width="0.5"/>`,
      `<text x="${x + 14}" y="${f1(ly)}" font-size="11">${esc(label)}</text>`,
    );
  });
  out.push('</svg>');
  return `${out.join('\n')}\n`;
}
