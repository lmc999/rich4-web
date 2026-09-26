import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { ExitCode, ExtractError } from '../context';
import type { Cell, Rect } from './geometry/types';
import type { MapSemantic } from './semantic';

/**
 * 几何 overrides（data-pipeline.md §8.3）：只含我们自己的几何决定与原版编号引用，不含原版数值。
 * 坐标一律是「格点坐标」：量化 + transform 之后、平移到原点与紧凑之前的整数格（报告与预览中标注的同一坐标系）。
 */
const Int = z.number().int();
const Pair = z.tuple([Int, Int]);
/** [x, y, w, h] */
const RectTuple = z.tuple([Int, Int, Int.min(1), Int.min(1)]);

export const TransformSchema = z.enum(['identity', 'rot90', 'rot180', 'rot270', 'flipX', 'flipY']);
export const SourceIdSchema = z.enum(['v206-mapdat', 'v206-mapmkf', 'v311-mapmkf']);

export const MapOverridesSchema = z.strictObject({
  /** 编辑器用：指向 overrides.schema.json */
  $schema: z.string().optional(),
  mapKey: z.string().min(1),
  source: z.strictObject({
    id: SourceIdSchema,
    expectResourceSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  }),
  /** 省略 tile 时按 §8.1 自动检测；省略 origin 时自动搜索 */
  lattice: z
    .strictObject({
      tile: Int.min(4).max(256).optional(),
      origin: Pair.optional(),
      transform: TransformSchema.optional(),
    })
    .default({}),
  compact: z.boolean().default(false),
  /** 节点号 → 格 */
  nodeCell: z.record(z.string().regex(/^[1-9]\d*$/), Pair).default({}),
  /** "a-b"（a<b）→ 从 a 到 b 的连接格（不含两端） */
  edgeRoute: z.record(z.string().regex(/^[1-9]\d*-[1-9]\d*$/), z.array(Pair)).default({}),
  lot: z
    .record(
      z.string().regex(/^[LFC][1-9]\d*$/),
      z.strictObject({ cell: Pair.optional(), side: z.enum(['a', 'b']).optional(), rect: RectTuple.optional() }),
    )
    .default({}),
  landmark: z
    .record(
      z.string().regex(/^[1-9]\d*$/),
      z.strictObject({
        kind: z.enum(['hospital', 'jail', 'scenery']).optional(),
        rect: RectTuple.optional(),
        hidden: z.boolean().optional(),
      }),
    )
    .default({}),
  terrain: z
    .strictObject({
      /** 包围盒四周留白（默认 2，§8.2 第 9 步）；规格外扩展 */
      margin: Int.min(0).max(32).optional(),
      paint: z.array(z.strictObject({ rect: RectTuple, t: z.enum(['g', 'w', 's', 'p', 'm']) })).optional(),
    })
    .default({}),
  expect: z
    .strictObject({ nodes: Int, lands: Int, facilities: Int, companies: Int, landscapes: Int })
    .partial()
    .optional(),
  /** 人工备注（不参与计算） */
  notes: z.array(z.string()).optional(),
});

export type MapOverrides = z.output<typeof MapOverridesSchema>;
export type MapOverridesInput = z.input<typeof MapOverridesSchema>;

export function parseOverrides(json: unknown, where = 'overrides'): MapOverrides {
  const r = MapOverridesSchema.safeParse(json);
  if (!r.success) {
    const msg = r.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
      .join('；');
    throw new ExtractError('E_OVERRIDES_SCHEMA', `${where} 不符合 schema：${msg}`, ExitCode.OVERRIDE);
  }
  return r.data;
}

export async function loadOverrides(file: string, where = file): Promise<MapOverrides> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new ExtractError('E_MISSING_INPUT', `找不到 overrides：${where}`, ExitCode.MISSING_INPUT);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new ExtractError(
      'E_OVERRIDES_SCHEMA',
      `${where} 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`,
      ExitCode.OVERRIDE,
    );
  }
  return parseOverrides(json, where);
}

/** 空 overrides（测试与没有 override 文件时使用）。 */
export function emptyOverrides(mapKey: string, sourceId: MapOverrides['source']['id']): MapOverrides {
  return parseOverrides({ mapKey, source: { id: sourceId } });
}

export const toCell = (p: readonly [number, number]): Cell => ({ x: p[0], y: p[1] });
export const toRect = (r: readonly [number, number, number, number]): Rect => ({ x: r[0], y: r[1], w: r[2], h: r[3] });

/** 统计 override 条数（报告用）。 */
export function countOverrides(ov: MapOverrides): number {
  let n = 0;
  if (ov.lattice.tile !== undefined) n++;
  if (ov.lattice.origin !== undefined) n++;
  if (ov.lattice.transform !== undefined && ov.lattice.transform !== 'identity') n++;
  if (ov.compact) n++;
  n += Object.keys(ov.nodeCell).length + Object.keys(ov.edgeRoute).length;
  for (const v of Object.values(ov.lot)) n += Object.keys(v).length;
  for (const v of Object.values(ov.landmark)) n += Object.keys(v).length;
  if (ov.terrain.margin !== undefined) n++;
  n += ov.terrain.paint?.length ?? 0;
  return n;
}

/**
 * 核对 override 引用的编号确实存在、输入资源没有变化；不成立时抛 exit 5。
 * 几何冲突（指定的格被占用等）在 normalize 中检查。
 */
export function checkOverrideRefs(ov: MapOverrides, sem: MapSemantic): void {
  const bad: string[] = [];
  if (ov.mapKey !== sem.mapKey) bad.push(`mapKey ${ov.mapKey} ≠ ${sem.mapKey}`);
  if (ov.source.id !== sem.source.id) bad.push(`source.id ${ov.source.id} ≠ 实际来源 ${sem.source.id}`);
  if (ov.source.expectResourceSha256 !== undefined && ov.source.expectResourceSha256 !== sem.source.resourceSha256) {
    bad.push(`输入资源已变化（expectResourceSha256 不符，旧 override 作废，请重新审阅）`);
  }
  const tileIds = new Set(sem.tiles.map((t) => t.id));
  for (const k of Object.keys(ov.nodeCell)) if (!tileIds.has(Number(k))) bad.push(`nodeCell 引用不存在的节点 ${k}`);
  const byId = new Map(sem.tiles.map((t) => [t.id, t]));
  for (const k of Object.keys(ov.edgeRoute)) {
    const [a, b] = k.split('-').map(Number) as [number, number];
    if (!(a < b)) bad.push(`edgeRoute 键 ${k} 必须写成 小号-大号`);
    const ta = byId.get(a);
    const tb = byId.get(b);
    if (!ta || !tb || !(ta.links.some((l) => l.to === b) || tb.links.some((l) => l.to === a))) {
      bad.push(`edgeRoute 引用不存在的边 ${k}`);
    }
  }
  const lotIds = new Set<string>([
    ...sem.lands.map((l) => l.id),
    ...sem.facilities.map((f) => f.id),
    ...sem.companies.map((c) => c.id),
  ]);
  for (const [k, v] of Object.entries(ov.lot)) {
    if (!lotIds.has(k)) bad.push(`lot 引用不存在的地块 ${k}`);
    if (v.cell && !k.startsWith('L')) bad.push(`lot.${k}.cell 只适用于住宅地`);
    if (v.side && !k.startsWith('F')) bad.push(`lot.${k}.side 只适用于设施`);
  }
  const lmIds = new Set(sem.landmarks.map((m) => m.id));
  for (const [k, v] of Object.entries(ov.landmark)) {
    if (!lmIds.has(k)) bad.push(`landmark 引用不存在的景观 ${k}`);
    const lm = sem.landmarks.find((m) => m.id === k);
    if (lm?.holdTile !== undefined && (v.hidden || (v.kind !== undefined && v.kind !== lm.kind))) {
      bad.push(`landmark.${k} 是关押地标（${lm.kind}），不能隐藏或改 kind`);
    }
  }
  if (bad.length > 0) throw new ExtractError('E_OVERRIDE_REF', bad.join('；'), ExitCode.OVERRIDE);
}

/** overrides 的 JSON Schema（由 zod 导出，入库为 tools/extract/maps/overrides.schema.json，供编辑器提示）。 */
export function overridesJsonSchema(): unknown {
  return z.toJSONSchema(MapOverridesSchema, { io: 'input' });
}

export const OVERRIDES_SCHEMA_FILE = 'overrides.schema.json';
