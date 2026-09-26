import { z } from 'zod';
import { DataError } from '../errors';
import type { MapDef } from './types';

/**
 * MapDef 的 zod 4 结构校验（与 types.ts 一一对应，未知键一律拒绝）。
 * 只做结构与类型检查；数值范围、引用一致性、几何等语义检查由 validateMap 负责，便于给出精确的 issue code。
 */
const int = () => z.number().int();

export const CellSchema = z.strictObject({ x: int(), y: int() });
export const WorldSchema = z.strictObject({ x: z.number(), y: z.number() });
export const RectSchema = z.strictObject({ x: int(), y: int(), w: int(), h: int() });

export const TileKindSchema = z.enum([
  'property',
  'plain',
  'park',
  'news',
  'fate',
  'jail',
  'hospital',
  'penguin',
  'balloon',
  'xicong',
  'lottery',
  'points50',
  'points30',
  'points10',
  'card',
  'bank',
  'shop',
  'magic',
]);

export const LotIdSchema = z
  .templateLiteral([z.enum(['L', 'F', 'C']), z.number().int()])
  .refine((s) => /^[LFC][1-9]\d*$/.test(s), 'lot id must look like L1 / F1 / C1');

export const TileLinkSchema = z.strictObject({
  to: int(),
  slot: z.literal([0, 1, 2, 3]),
  blocked: z.boolean(),
  via: z.array(CellSchema).optional(),
});

export const TileDefSchema = z.strictObject({
  id: int(),
  cell: CellSchema,
  world: WorldSchema,
  kind: TileKindSchema,
  landingCode: int(),
  ref: z.strictObject({ lot: LotIdSchema.optional(), landmark: z.string().optional() }).optional(),
  links: z.array(TileLinkSchema),
  noItems: z.boolean(),
  holdFor: z.enum(['hospital', 'jail']).optional(),
  nameKey: z.string().optional(),
  src: z.strictObject({ flags: int() }).optional(),
});

const Rent6Schema = z.tuple([int(), int(), int(), int(), int(), int()]);

const lotBase = {
  id: LotIdSchema,
  world: WorldSchema,
  rect: RectSchema,
  frontTiles: z.array(int()),
  facing: int().optional(),
  nameKey: z.string(),
};

export const LandLotSchema = z.strictObject({
  ...lotBase,
  kind: z.literal('land'),
  streetId: z.string(),
  landPrice: int(),
  housePrice: int(),
  rent: Rent6Schema,
});

export const FacilityLotSchema = z.strictObject({
  ...lotBase,
  kind: z.literal('facility'),
  landPrice: int(),
  housePrice: int(),
  rateWindow: Rent6Schema,
});

export const IndustryKeySchema = z.enum([
  'airline',
  'hotel',
  'electronics',
  'insurance',
  'auto',
  'oil',
  'bank',
  'dept',
  'construction',
  'sect',
  'unknown',
]);

export const CompanyDefSchema = z.strictObject({
  ...lotBase,
  kind: z.literal('company'),
  industry: int(),
  industryKey: IndustryKeySchema,
  stockIndex: int(),
  tollBase: int(),
  assetValue: int(),
});

export const LandmarkDefSchema = z.strictObject({
  id: z.string(),
  kind: z.enum(['hospital', 'jail', 'scenery']),
  rect: RectSchema,
  nameKey: z.string(),
  holdTile: int().optional(),
});

export const StreetDefSchema = z.strictObject({ id: z.string(), nameKey: z.string(), lots: z.array(LotIdSchema) });

export const StockDefSchema = z.strictObject({
  index: int(),
  nameKey: z.string(),
  hasCompany: z.boolean(),
  float: int(),
  initPriceCents: int(),
  volatility: z.number(),
  volatilityF32: z.string().regex(/^[0-9a-f]{8}$/),
});

export const HolidayDefSchema = z.strictObject({
  slot: int(),
  month: int().min(1).max(12),
  day: int().min(1).max(31),
  kind: int(),
  flagsRaw: int(),
  closed: z.boolean().optional(),
  giveCard: z.boolean().optional(),
  bgm: z.boolean().optional(),
  lunar: z.boolean().optional(),
});

export const MapCountsSchema = z.strictObject({
  nodes: int(),
  lands: int(),
  facilities: int(),
  companies: int(),
  landscapes: int(),
});

const StringTableSchema = z.record(z.string(), z.string());

export const MapDefSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  globalMapId: int().nullable(),
  nameKey: z.string(),
  grid: z.strictObject({ w: int(), h: int() }),
  terrain: z.array(z.string()),
  tiles: z.array(TileDefSchema),
  roadCells: z.array(CellSchema),
  lots: z.array(z.discriminatedUnion('kind', [LandLotSchema, FacilityLotSchema])),
  companies: z.array(CompanyDefSchema),
  landmarks: z.array(LandmarkDefSchema),
  streets: z.array(StreetDefSchema),
  stocks: z.array(StockDefSchema),
  holidays: z.array(HolidayDefSchema),
  decorations: z.array(z.strictObject({ kind: z.enum(['tree', 'rock', 'flower']), cell: CellSchema, variant: int() })),
  strings: z.strictObject({ 'zh-TW': StringTableSchema, 'zh-CN': StringTableSchema }),
  meta: z.strictObject({
    source: z.union([
      z.strictObject({ id: z.string(), fileSha256: z.string(), resourceSha256: z.string() }),
      z.strictObject({ fixture: z.literal(true) }),
    ]),
    counts: MapCountsSchema,
    dataHash: z.string().regex(/^[0-9a-f]{64}$/),
    generator: z.string(),
  }),
});

// 编译期保证 schema 与 types.ts 互相可赋值
type SchemaOut = z.output<typeof MapDefSchema>;
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const schemaMatchesTypes: Mutual<SchemaOut, MapDef> = true;
void schemaMatchesTypes;

/** 结构校验并返回 MapDef；失败抛 DataError('MAP_INVALID')（语义检查另调 validateMap） */
export function parseMapDef(json: unknown): MapDef {
  const r = MapDefSchema.safeParse(json);
  if (!r.success) {
    const first = r.error.issues[0];
    const where = first ? `${first.path.map(String).join('.')}: ${first.message}` : 'unknown';
    throw new DataError('MAP_INVALID', `MapDef schema check failed at ${where}`, {
      issues: r.error.issues.length,
    });
  }
  return r.data;
}
