import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ExtractError, PACKAGE_DIR } from '../context';

/** anchors/tables.json（入库）：exe 固定表的定位签名与参考 VA（data-pipeline.md §6.2）。 */

const Va = z.string().regex(/^0x[0-9a-f]+$/);
const Hint = z.strictObject({ v311: Va.optional(), v206: Va.optional() });
const Six = z.array(z.number().int()).length(6);

export const TableAnchorsSchema = z.strictObject({
  schema: z.literal('rich4.anchors-tables/1'),
  note: z.string(),
  reference: z.literal('v311'),
  tables: z.strictObject({
    cards: z.strictObject({
      count: z.literal(30),
      stride: z.literal(8),
      names: z.array(z.string()).length(2),
      hint: Hint,
      source: z.string(),
    }),
    tools: z.strictObject({
      count: z.literal(13),
      stride: z.literal(8),
      names: z.array(z.string()).length(2),
      follows: z.literal('cards'),
      hint: Hint,
      source: z.string(),
    }),
    holidays: z.strictObject({
      perMap: z.literal(24),
      stride: z.literal(12),
      follows: z.literal('tools'),
      hint: Hint,
      source: z.string(),
    }),
    characters: z.strictObject({
      count: z.literal(12),
      stride: z.literal(104),
      names: z.array(z.string()).length(2),
      hint: Hint,
      source: z.string(),
    }),
    stocks: z.strictObject({
      perMap: z.literal(12),
      stride: z.literal(36),
      names: z.array(z.string()).length(2),
      hint: Hint,
      source: z.string(),
    }),
    setup: z.strictObject({
      funds: Six,
      days: Six,
      wealthMultipliers: Six,
      hint: z.strictObject({
        v311: z.strictObject({ funds: Va, days: Va, wealthMultipliers: Va }).optional(),
        v206: z.strictObject({ funds: Va, days: Va, wealthMultipliers: Va }).optional(),
      }),
      source: z.string(),
    }),
    facilityLevels: z.strictObject({
      count: z.literal(5),
      types: z.array(z.string()).length(5),
      expect: z.array(z.number().int()).length(5),
      hint: Hint,
      source: z.string(),
    }),
    lunar: z.strictObject({
      firstSolar: z.literal('1998-01-01'),
      hint: Hint,
      source: z.string(),
    }),
  }),
});

export type TableAnchors = z.infer<typeof TableAnchorsSchema>;

export const ANCHORS_FILE = path.join(PACKAGE_DIR, 'anchors', 'tables.json');

let cached: TableAnchors | null = null;

export function loadTableAnchors(file = ANCHORS_FILE): TableAnchors {
  if (file === ANCHORS_FILE && cached) return cached;
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new ExtractError('E_ANCHORS', `读取 ${file} 失败：${e instanceof Error ? e.message : String(e)}`);
  }
  const r = TableAnchorsSchema.safeParse(json);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new ExtractError(
      'E_ANCHORS',
      `anchors/tables.json 结构不符：${i ? `${i.path.join('.')}: ${i.message}` : ''}`,
    );
  }
  if (file === ANCHORS_FILE) cached = r.data;
  return r.data;
}

export const parseVa = (s: string): number => Number.parseInt(s, 16);
