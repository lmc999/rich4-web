/**
 * 地图皮肤 MapSkinV1（schema 'rich4.mapskin/1'；docs/design/original-skin.md §3 修正 9、design-draft §2.5「skin.json」、render.md）。
 *
 * 原版皮肤直接用原版世界坐标（2304×2304 正射底图的像素坐标）+ 每视角一个仿射矩阵，支持 8 个视角；
 * 皮肤绑定 MapDef.meta.source.resourceSha256 与一份几何摘要（tiles[].world、lots[].world/facing、companies[].world/facing），
 * 不绑定 meta.dataHash（后者覆盖整个 MapDef，map-build 任何改动都会让它变化）。不匹配时前端回退程序化棋盘，并在设置页显示原因。
 */
import { z } from 'zod';
import { canonicalJson } from '../util/canonicalJson';
import { sha256Hex } from '../util/sha256';
import {
  ASSET_SCHEMA,
  type AssetParseResult,
  ConfidenceSchema,
  type ContractIssue,
  EvidenceSchema,
  isStrictlySorted,
  LogicalKeySchema,
  LotIdSchema,
  MapIdSchema,
  NonNegIntSchema,
  PackPathSchema,
  PointSchema,
  PosIntSchema,
  reportIssues,
  runParse,
  runSafeParse,
  Sha256HexSchema,
  SizeSchema,
} from './common';

// ───────────────────────── 绑定与几何摘要 ─────────────────────────

/** 计算几何摘要需要的 MapDef 子集（结构类型：直接传 MapDef 即可；shared/assets 不依赖 shared/data） */
export interface MapGeometryInput {
  tiles: ReadonlyArray<{ id: number; world: { x: number; y: number } }>;
  lots: ReadonlyArray<{ id: string; world: { x: number; y: number }; facing?: number }>;
  companies: ReadonlyArray<{ id: string; world: { x: number; y: number }; facing?: number }>;
}

/** 与 MapDef.meta.source 同形：原版地图带 resourceSha256，fixture 为 { fixture: true } */
export type MapSourceLike = { resourceSha256: string } | { fixture: true };

export interface MapBindingInput extends MapGeometryInput {
  id: string;
  meta: { source: MapSourceLike };
}

const byNum = (a: number, b: number): number => a - b;
const byStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** 几何摘要的规范化形态（v1）：按 id 排序后逐项取 [id, x, y(, facing)]，facing 缺省记 null */
export function mapGeometryCanonical(map: MapGeometryInput): string {
  const tiles = [...map.tiles].sort((a, b) => byNum(a.id, b.id)).map((t) => [t.id, t.world.x, t.world.y]);
  const lotRow = (l: MapGeometryInput['lots'][number]) => [l.id, l.world.x, l.world.y, l.facing ?? null];
  const lots = [...map.lots].sort((a, b) => byStr(a.id, b.id)).map(lotRow);
  const companies = [...map.companies].sort((a, b) => byStr(a.id, b.id)).map(lotRow);
  return canonicalJson({ v: 1, tiles, lots, companies });
}

/** 几何摘要：sha256(mapGeometryCanonical(map)) */
export function mapGeometryDigest(map: MapGeometryInput): string {
  return sha256Hex(mapGeometryCanonical(map));
}

export const MapSkinBindingSchema = z.strictObject({
  /** MapDef.meta.source.resourceSha256；null 表示绑定 fixture 地图（source = { fixture: true }，CI 合成包用） */
  resourceSha256: Sha256HexSchema.nullable(),
  /** mapGeometryDigest(MapDef) */
  geometry: Sha256HexSchema,
  /** 仅供诊断显示 */
  counts: z.strictObject({ tiles: NonNegIntSchema, lots: NonNegIntSchema, companies: NonNegIntSchema }),
});
export type MapSkinBinding = z.output<typeof MapSkinBindingSchema>;

/** 由 MapDef 计算绑定（extract 生成 skin 时用；前端也可用它复算后比较） */
export function mapSkinBindingOf(map: MapBindingInput): MapSkinBinding {
  const src = map.meta.source;
  return {
    resourceSha256: 'resourceSha256' in src ? src.resourceSha256 : null,
    geometry: mapGeometryDigest(map),
    counts: { tiles: map.tiles.length, lots: map.lots.length, companies: map.companies.length },
  };
}

export type MapSkinMismatchCode = 'map-id' | 'source' | 'geometry';

export interface MapSkinMismatch {
  code: MapSkinMismatchCode;
  expected: string | null;
  actual: string | null;
}

/**
 * 皮肤与当前 MapDef 是否匹配；返回空数组表示匹配。设置页按 code 显示原因：
 * map-id = 地图 id 不同；source = 原始资源哈希不同（或 fixture/原版混用）；geometry = 节点、地块、企业的坐标或朝向有变化。
 */
export function checkMapSkinBinding(
  skin: { mapId: string; binding: MapSkinBinding },
  map: MapBindingInput,
): MapSkinMismatch[] {
  const out: MapSkinMismatch[] = [];
  if (skin.mapId !== map.id) out.push({ code: 'map-id', expected: skin.mapId, actual: map.id });
  const actual = mapSkinBindingOf(map);
  if (skin.binding.resourceSha256 !== actual.resourceSha256) {
    out.push({ code: 'source', expected: skin.binding.resourceSha256, actual: actual.resourceSha256 });
  }
  if (skin.binding.geometry !== actual.geometry) {
    out.push({ code: 'geometry', expected: skin.binding.geometry, actual: actual.geometry });
  }
  return out;
}

// ───────────────────────── 投影 ─────────────────────────

/**
 * 每视角的仿射（与 Pixi Matrix 同一约定）。Δ = 世界点 − 镜头世界点（世界像素），屏幕 = origin + (x', y')：
 *   x' = a·Δx + c·Δy + tx，y' = b·Δx + d·Δy + ty。
 * 原版视角 0 约为 a=36.012/32、c=14.864/32、b=−10.527/32、d=25.524/32、(tx,ty)=(−1.608,−1.117)（projection-fit.v206.json）。
 */
export const AffineSchema = z.strictObject({
  a: z.number(),
  b: z.number(),
  c: z.number(),
  d: z.number(),
  tx: z.number(),
  ty: z.number(),
  /** 拟合对原版格点的最大误差（px）；非拟合来源为 null */
  maxErrPx: z.number().nonnegative().nullable(),
});
export type Affine = z.output<typeof AffineSchema>;

export const VIEW_COUNT = 8;
/** 原版逐格表的格差范围 ±14（29×29） */
export const EXACT_TABLE_SPAN = 29;

/**
 * 原版精确表（可选画质项）：
 * cellScreen 为 [view][dy+14][dx+14] → (sy, sx) 的 int16，按此顺序展平，长度 8×29×29×2；**dy 在外层、先 sy 后 sx**。
 * subcell 为 [view] → m0..m3 的 int8，长度 32；亚格偏移 o1=(m0·fx>>5)+(m2·fy>>5)、o2=(m1·fx>>5)+(m3·fy>>5)，是负偏移（做减法）。
 */
export const ExactTablesSchema = z.strictObject({
  cellScreen: z.array(z.int().min(-32768).max(32767)).length(VIEW_COUNT * EXACT_TABLE_SPAN * EXACT_TABLE_SPAN * 2),
  subcell: z.array(z.int().min(-128).max(127)).length(VIEW_COUNT * 4),
  src: EvidenceSchema,
});
export type ExactTables = z.output<typeof ExactTablesSchema>;

export const ProjectionSchema = z.strictObject({
  /** 投影中心在原版 640×480 画面中的位置：(220,260)，即棋盘视窗 (0,40)–(440,480) 的中心 */
  origin: PointSchema,
  /** 原版棋盘视窗（640×480 画面坐标）：(0,40) 440×440 */
  viewport: z.strictObject({ x: z.int(), y: z.int(), w: PosIntSchema, h: PosIntSchema }),
  /** 8 个视角的仿射；view+1 画面顺时针转 45°（θ = −22.5° + 45°·view） */
  views: z.array(AffineSchema).length(VIEW_COUNT),
  /** 载入地图时的视角（原版 0x407a8c 置 0） */
  initialView: z
    .int()
    .min(0)
    .max(VIEW_COUNT - 1),
  /** 镜头中心夹取范围（世界像素）；oama 对 v3.11 的结论为 [220,2084]²，v2.06 未读，置信度 guess */
  cameraClamp: z.strictObject({ min: PointSchema, max: PointSchema, confidence: ConfidenceSchema }).nullable(),
  exact: ExactTablesSchema.nullable(),
});
export type Projection = z.output<typeof ProjectionSchema>;

// ───────────────────────── 地面、装饰、建筑、景观 ─────────────────────────

export const GroundChunkSchema = z.strictObject({
  /** 逻辑路径（manifest.files 的键），不透明位图 */
  file: PackPathSchema,
  /** 在世界坐标中的放置矩形（含重叠像素） */
  x: NonNegIntSchema,
  y: NonNegIntSchema,
  w: PosIntSchema,
  h: PosIntSchema,
});
export type GroundChunk = z.output<typeof GroundChunkSchema>;

/** 设施类型；与 shared/data 的 FACILITY_TYPES 同序（0 公园、1 旅馆、2 购物中心、3 加油站、4 研究所），由测试对拍 */
export const SKIN_FACILITY_TYPES = ['park', 'hotel', 'mall', 'gas', 'lab'] as const;
export type SkinFacilityType = (typeof SKIN_FACILITY_TYPES)[number];

/** 建筑帧选择规则：facing-view-8 为原版 `(8−(facing+view))&7`（见 frames.ts buildingFrame）；static 为单帧素材 */
export const BuildingFrameRuleSchema = z.enum(['facing-view-8', 'static']);
export type BuildingFrameRule = z.output<typeof BuildingFrameRuleSchema>;

const levelKeys = z.array(LogicalKeySchema).min(1).max(5);

export const BuildingsSchema = z.strictObject({
  frameRule: BuildingFrameRuleSchema,
  /** 住宅：levels[L−1] 为等级 L（1..5）的精灵条目；chain 为连锁店 */
  house: z.strictObject({ levels: z.array(LogicalKeySchema).length(5), chain: LogicalKeySchema.nullable() }),
  /**
   * 设施（设施类型由玩家建造时选择，属于对局状态）：park 为公园（等级 0）；其余为等级 1..n 的精灵条目，
   * 超出数组长度的等级取最后一项（v3.11 加油站只有 1 级）。
   */
  facilities: z.strictObject({
    park: LogicalKeySchema,
    hotel: levelKeys,
    mall: levelKeys,
    gas: levelKeys,
    lab: levelKeys,
  }),
  /** 企业：每家企业的精灵（原版 spriteId+26，spriteId 仅作证据） */
  companies: z.array(
    z.strictObject({ lot: LotIdSchema, sprite: LogicalKeySchema, spriteId: NonNegIntSchema.nullable() }),
  ),
  /** 空地已有主时的角色标记（帧 = 角色号 0..11） */
  ownerMark: LogicalKeySchema.nullable(),
  /** 涨价 / 查封高亮（帧语义与混色未解码，置信度通常为 guess） */
  lotHighlight: z.strictObject({ sprite: LogicalKeySchema, confidence: ConfidenceSchema }).nullable(),
});
export type Buildings = z.output<typeof BuildingsSchema>;

export const ScenerySchema = z.strictObject({
  /** 景观序号（皮肤内唯一），例如 `S1` */
  id: z.string().min(1).max(32),
  world: PointSchema,
  sprite: LogicalKeySchema,
  /** 0..7；景观不改主人色 */
  facing: z.int().min(0).max(7),
  /** 原版 spriteId（证据） */
  spriteId: NonNegIntSchema.nullable(),
  /** 对应的 MapDef.landmarks[].id（医院、监狱等）；纯景观为 null */
  landmark: z.string().min(1).max(64).nullable(),
});
export type Scenery = z.output<typeof ScenerySchema>;

export const MapSkinV1BaseSchema = z.strictObject({
  schema: z.literal(ASSET_SCHEMA.mapSkin),
  mapId: MapIdSchema,
  binding: MapSkinBindingSchema,
  /** 世界尺寸（原版 2304×2304；fixture 为 cell×32 的外接） */
  world: SizeSchema,
  /** 地面切块：放在同一个容器里套视角仿射（原版 2×2 张 1152²，每块多带 1px 重叠） */
  ground: z.strictObject({ chunks: z.array(GroundChunkSchema).min(1), overlap: NonNegIntSchema }),
  /** 缩小地图（原版 map#8+gm：帧 small 为 200²、large 为 400²） */
  minimap: z
    .strictObject({ sprite: LogicalKeySchema, small: NonNegIntSchema, large: NonNegIntSchema.nullable() })
    .nullable(),
  projection: ProjectionSchema,
  /** 节点装饰圆盘：帧 = 原版 decor − 1，锚点在图心，画在地面之上、排序层之下（不参与深度排序） */
  decor: z.strictObject({
    sprite: LogicalKeySchema.nullable(),
    nodes: z.array(z.strictObject({ tile: PosIntSchema, frame: NonNegIntSchema })),
  }),
  buildings: BuildingsSchema,
  scenery: z.array(ScenerySchema),
  /** 原版节点 flags bit31：换快艇姿态（台湾图 17 个），升序 */
  boatTiles: z.array(PosIntSchema),
  src: EvidenceSchema,
});

/** MapSkinV1 的一致性检查（结构之外）：切块覆盖世界、各列表唯一、矩阵可逆 */
export function checkMapSkin(s: z.output<typeof MapSkinV1BaseSchema>): ContractIssue[] {
  const issues: ContractIssue[] = [];
  const { w, h } = s.world;
  s.ground.chunks.forEach((c, i) => {
    if (c.x + c.w > w || c.y + c.h > h) issues.push({ path: ['ground', 'chunks', i], message: '切块超出世界范围' });
  });
  if (!chunksCover(s.ground.chunks, w, h)) issues.push({ path: ['ground', 'chunks'], message: '切块没有完整覆盖世界' });
  s.projection.views.forEach((v, i) => {
    const det = v.a * v.d - v.b * v.c;
    if (!(Math.abs(det) > 1e-9)) issues.push({ path: ['projection', 'views', i], message: '仿射矩阵不可逆' });
  });
  const clamp = s.projection.cameraClamp;
  if (clamp && (clamp.min.x > clamp.max.x || clamp.min.y > clamp.max.y)) {
    issues.push({ path: ['projection', 'cameraClamp'], message: 'min 不能大于 max' });
  }
  const decorTiles = s.decor.nodes.map((n) => n.tile);
  if (!isStrictlySorted(decorTiles))
    issues.push({ path: ['decor', 'nodes'], message: '装饰节点必须按 tile 升序且唯一' });
  if (s.decor.nodes.length > 0 && s.decor.sprite === null) {
    issues.push({ path: ['decor', 'sprite'], message: '有装饰节点时必须给出装饰精灵' });
  }
  if (!isStrictlySorted(s.boatTiles)) issues.push({ path: ['boatTiles'], message: 'boatTiles 必须升序且唯一' });
  const companyLots = s.buildings.companies.map((c) => c.lot);
  if (new Set(companyLots).size !== companyLots.length) {
    issues.push({ path: ['buildings', 'companies'], message: '企业 lot 重复' });
  }
  s.buildings.companies.forEach((c, i) => {
    if (!c.lot.startsWith('C'))
      issues.push({ path: ['buildings', 'companies', i, 'lot'], message: '企业 lot 必须形如 C1' });
  });
  const sceneryIds = s.scenery.map((x) => x.id);
  if (new Set(sceneryIds).size !== sceneryIds.length) issues.push({ path: ['scenery'], message: '景观 id 重复' });
  if (s.binding.counts.companies !== s.buildings.companies.length) {
    issues.push({ path: ['buildings', 'companies'], message: '企业数量与 binding.counts.companies 不一致' });
  }
  return issues;
}

/** 切块并集是否覆盖 [0,w)×[0,h)：按全部切块边界切成基本矩形逐个检查 */
function chunksCover(chunks: readonly { x: number; y: number; w: number; h: number }[], w: number, h: number): boolean {
  const xs = [...new Set([0, w, ...chunks.flatMap((c) => [c.x, c.x + c.w])])].filter((v) => v <= w).sort(byNum);
  const ys = [...new Set([0, h, ...chunks.flatMap((c) => [c.y, c.y + c.h])])].filter((v) => v <= h).sort(byNum);
  for (let i = 0; i + 1 < xs.length; i++) {
    for (let j = 0; j + 1 < ys.length; j++) {
      const x0 = xs[i]!;
      const x1 = xs[i + 1]!;
      const y0 = ys[j]!;
      const y1 = ys[j + 1]!;
      const covered = chunks.some((c) => c.x <= x0 && c.x + c.w >= x1 && c.y <= y0 && c.y + c.h >= y1);
      if (!covered) return false;
    }
  }
  return true;
}

export const MapSkinV1Schema = MapSkinV1BaseSchema.superRefine((s, ctx) => reportIssues(ctx, checkMapSkin(s)));
export type MapSkinV1 = z.output<typeof MapSkinV1Schema>;

export function safeParseMapSkin(json: unknown): AssetParseResult<MapSkinV1> {
  return runSafeParse(MapSkinV1Schema, json);
}

/** 结构与一致性校验；失败抛 AssetContractError */
export function parseMapSkin(json: unknown): MapSkinV1 {
  return runParse(ASSET_SCHEMA.mapSkin, MapSkinV1Schema, json);
}

/** 世界点 → 屏幕点（相对镜头；返回浮点，调用方按源像素取整） */
export function projectWorld(
  view: Affine,
  origin: { x: number; y: number },
  camera: { x: number; y: number },
  world: { x: number; y: number },
): { x: number; y: number } {
  const dx = world.x - camera.x;
  const dy = world.y - camera.y;
  return { x: origin.x + view.a * dx + view.c * dy + view.tx, y: origin.y + view.b * dx + view.d * dy + view.ty };
}

/** 屏幕点 → 世界点（projectWorld 的逆） */
export function unprojectScreen(
  view: Affine,
  origin: { x: number; y: number },
  camera: { x: number; y: number },
  screen: { x: number; y: number },
): { x: number; y: number } {
  const sx = screen.x - origin.x - view.tx;
  const sy = screen.y - origin.y - view.ty;
  const det = view.a * view.d - view.b * view.c;
  return { x: camera.x + (view.d * sx - view.c * sy) / det, y: camera.y + (-view.b * sx + view.a * sy) / det };
}
