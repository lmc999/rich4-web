import type { Cell, IndustryKey, Slot, TileKind } from './types';

export const TILE_KINDS: readonly TileKind[] = [
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
];

/**
 * 落点码 1..16 → TileKind（码 0 视有无 ref.lot 分为 property / plain）。
 * @source docs/research/g_map.md §3.1（跳表 0x4197e9 共 17 项）
 */
export const LANDING_CODE_KINDS: readonly (TileKind | null)[] = [
  null,
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
];

export const LANDING_CODE_MAX = 16;
export const LANDING_JAIL = 4;
export const LANDING_HOSPITAL = 5;

/** 落点码非法时返回 null */
export function kindForLandingCode(code: number, hasLotRef: boolean): TileKind | null {
  if (!Number.isInteger(code) || code < 0 || code > LANDING_CODE_MAX) return null;
  if (code === 0) return hasLotRef ? 'property' : 'plain';
  return LANDING_CODE_KINDS[code] ?? null;
}

/**
 * 企业行业码 → IndustryKey（8、9 等未解明的码为 unknown）。
 * @source docs/research/g_map.md §2.6「行业码」
 */
export const INDUSTRY_KEYS: Readonly<Record<number, IndustryKey>> = {
  1: 'airline',
  2: 'hotel',
  3: 'electronics',
  4: 'insurance',
  5: 'auto',
  6: 'oil',
  7: 'bank',
  10: 'dept',
  11: 'construction',
  12: 'sect',
};

export function industryKeyOf(industry: number): IndustryKey {
  return INDUSTRY_KEYS[industry] ?? 'unknown';
}

/** fixture 的槽号与网格方向：N=0（-y）、E=1（+x）、S=2（+y）、W=3（-x） */
export const SLOT_DIRS: readonly Readonly<Cell>[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

/** 单位轴向一步对应的槽号；不是单位轴向时返回 null */
export function slotOfStep(from: Cell, to: Cell): Slot | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === -1) return 0;
  if (dx === 1 && dy === 0) return 1;
  if (dx === 0 && dy === 1) return 2;
  if (dx === -1 && dy === 0) return 3;
  return null;
}

export function cellKey(c: Cell): string {
  return `${c.x},${c.y}`;
}
