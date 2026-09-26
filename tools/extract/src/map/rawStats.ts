import { TABLE_ORDER } from './layout';
import { blockedSlots, FLAG_NO_ITEMS, landingCode, resolveNodeType } from './parseRaw';
import type { MapDataRaw, TableName } from './rawTypes';

/** 统计的模数：32 为 exe 的 >>5；另给 16/24/48 供格点检测参考（实测边长多为 48、72）。 */
export const RESIDUE_MODULI: readonly number[] = [16, 24, 32, 48];

export interface AxisStats {
  min: number;
  max: number;
  /** 模数 → （残差 → 个数） */
  mod: Record<string, Record<string, number>>;
}

export interface CoordStats {
  count: number;
  x: AxisStats;
  y: AxisStats;
}

export interface BlockedEdge {
  node: number;
  name: string | null;
  slot: number;
  target: number;
}

export interface RawStats {
  schema: 'rich4.map-raw-stats/1';
  source: string;
  globalMapId: number;
  counts: Record<TableName, number>;
  /** 落点码 → { count, names: 出现过的节点名（去重） } */
  landingCodes: Record<string, { count: number; names: string[] }>;
  /** 节点 type 归类 */
  nodeTypeKinds: Record<string, number>;
  noItems: { count: number; nodes: number[] };
  blocked: BlockedEdge[];
  /** 度数 → 节点数 */
  degree: Record<string, number>;
  coords: Record<TableName, CoordStats>;
  edges: {
    count: number;
    /** 世界坐标差 "dx,dy"（取 a<b 方向）→ 条数 */
    worldDelta: Record<string, number>;
    /** 32 单位格差 "dx,dy"（x>>5 之差）→ 条数 */
    cellDelta: Record<string, number>;
  };
  /** 落在同一个 32×32 格里的节点组 */
  sameCell32: number[][];
}

function bump(map: Record<string, number>, key: string | number): void {
  map[String(key)] = (map[String(key)] ?? 0) + 1;
}

function sortedRecord<V>(rec: Record<string, V>, numeric: boolean): Record<string, V> {
  const keys = Object.keys(rec).sort((a, b) => (numeric ? Number(a) - Number(b) : a < b ? -1 : a > b ? 1 : 0));
  const out: Record<string, V> = {};
  for (const k of keys) out[k] = rec[k]!;
  return out;
}

function axis(values: readonly number[]): AxisStats {
  const mod: Record<string, Record<string, number>> = {};
  for (const m of RESIDUE_MODULI) {
    const hist: Record<string, number> = {};
    for (const v of values) bump(hist, ((v % m) + m) % m);
    mod[String(m)] = sortedRecord(hist, true);
  }
  return {
    min: values.length > 0 ? Math.min(...values) : 0,
    max: values.length > 0 ? Math.max(...values) : 0,
    mod,
  };
}

function coordStats(list: readonly { x: number; y: number }[]): CoordStats {
  return { count: list.length, x: axis(list.map((p) => p.x)), y: axis(list.map((p) => p.y)) };
}

/** 供几何归一化与人工核对使用的统计（不改变 raw 数据）。 */
export function computeRawStats(raw: MapDataRaw): RawStats {
  const landing: Record<string, { count: number; names: string[] }> = {};
  const kinds: Record<string, number> = {};
  const degree: Record<string, number> = {};
  const blocked: BlockedEdge[] = [];
  const noItems: number[] = [];
  for (const n of raw.nodes) {
    const code = String(landingCode(n.flags));
    const slot = landing[code] ?? { count: 0, names: [] };
    slot.count++;
    const nm = n.name.text ?? `<${n.name.hex}>`;
    if (!slot.names.includes(nm)) slot.names.push(nm);
    landing[code] = slot;
    const ref = resolveNodeType(n.type);
    bump(kinds, ref.kind === 'ref' ? ref.table : ref.kind);
    bump(degree, n.adj.filter((a) => a !== 0).length);
    if ((n.flags & FLAG_NO_ITEMS) !== 0) noItems.push(n.id);
    for (const k of blockedSlots(n.flags)) blocked.push({ node: n.id, name: n.name.text, slot: k, target: n.adj[k] });
  }

  const worldDelta: Record<string, number> = {};
  const cellDelta: Record<string, number> = {};
  let edgeCount = 0;
  for (const a of raw.nodes) {
    for (const bId of a.adj) {
      if (bId <= a.id) continue;
      const b = raw.nodes[bId - 1];
      if (!b) continue;
      edgeCount++;
      bump(worldDelta, `${b.x - a.x},${b.y - a.y}`);
      bump(cellDelta, `${(b.x >> 5) - (a.x >> 5)},${(b.y >> 5) - (a.y >> 5)}`);
    }
  }

  const cells = new Map<string, number[]>();
  for (const n of raw.nodes) {
    const key = `${n.x >> 5},${n.y >> 5}`;
    cells.set(key, [...(cells.get(key) ?? []), n.id]);
  }

  const coords = {} as Record<TableName, CoordStats>;
  const counts = {} as Record<TableName, number>;
  for (const t of TABLE_ORDER) {
    coords[t] = coordStats(raw[t]);
    counts[t] = raw.header[t].count;
  }

  const byCount = (rec: Record<string, number>): Record<string, number> => {
    const keys = Object.keys(rec).sort((a, b) => rec[b]! - rec[a]! || (a < b ? -1 : a > b ? 1 : 0));
    const out: Record<string, number> = {};
    for (const k of keys) out[k] = rec[k]!;
    return out;
  };

  return {
    schema: 'rich4.map-raw-stats/1',
    source: raw.source.id,
    globalMapId: raw.globalMapId,
    counts,
    landingCodes: sortedRecord(landing, true),
    nodeTypeKinds: sortedRecord(kinds, false),
    noItems: { count: noItems.length, nodes: noItems },
    blocked,
    degree: sortedRecord(degree, true),
    coords,
    edges: { count: edgeCount, worldDelta: byCount(worldDelta), cellDelta: byCount(cellDelta) },
    sameCell32: [...cells.values()].filter((g) => g.length > 1),
  };
}
