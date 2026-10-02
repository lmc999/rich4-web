import { BinReader, fromHex } from '../bin/reader';
import { ExitCode, ExtractError } from '../context';
import { type FieldClass, type FieldValue, hex2, LAYOUTS, readFieldValue, TABLE_ORDER } from './layout';
import type { MapDataRaw, RawSourceId, TableName } from './rawTypes';

export type DiffBucket = 'rule' | 'presentation';

export interface DiffItem {
  table: TableName | 'header' | 'resource';
  /** 记录编号（1 基）；头部/资源级为 null */
  id: number | null;
  field: string;
  /** 字段在记录内的偏移 */
  offset: string;
  size: number;
  cls: FieldClass;
  /** 记录内有差异的字节偏移 */
  byteOffsets: string[];
  values: Partial<Record<RawSourceId, FieldValue>>;
}

export interface DiffSummaryRow {
  table: DiffItem['table'];
  field: string;
  offset: string;
  cls: FieldClass;
  bucket: DiffBucket;
  records: number;
  byteOffsets: string[];
}

export interface MapRawDiff {
  schema: 'rich4.map-diff/1';
  globalMapId: number;
  baseline: RawSourceId;
  sources: {
    id: RawSourceId;
    edition: string;
    file: string;
    resource: number;
    byteLength: number;
    resourceSha256: string;
  }[];
  /** 资源字节完全相同的来源分组 */
  identicalGroups: RawSourceId[][];
  identical: boolean;
  counts: Record<DiffBucket, number>;
  summary: DiffSummaryRow[];
  rule: DiffItem[];
  presentation: DiffItem[];
}

/** 只有 presentation 类归表现相关；runtime/unknown 保守地并入规则相关（需要人工裁决）。 */
export function bucketOf(cls: FieldClass): DiffBucket {
  return cls === 'presentation' ? 'presentation' : 'rule';
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function recordHex(raw: MapDataRaw, table: TableName, id: number): string | null {
  const list: readonly { id: number; hex: string }[] = raw[table];
  return list.find((r) => r.id === id)?.hex ?? null;
}

/** 多来源逐字段比较（data-pipeline.md §5.5）。第一个来源为基线。 */
export function diffRaw(raws: readonly MapDataRaw[]): MapRawDiff {
  if (raws.length < 2)
    throw new ExtractError('E_DIFF_SOURCES', `至少需要 2 个来源，实际 ${raws.length}`, ExitCode.MISSING_INPUT);
  const gm = raws[0]!.globalMapId;
  if (raws.some((r) => r.globalMapId !== gm)) throw new ExtractError('E_DIFF_MAP', '来源的 globalMapId 不一致');
  const ids = raws.map((r) => r.source.id);
  const items: DiffItem[] = [];
  const valuesOf = (get: (r: MapDataRaw) => FieldValue): Partial<Record<RawSourceId, FieldValue>> => {
    const v: Partial<Record<RawSourceId, FieldValue>> = {};
    for (const r of raws) v[r.source.id] = get(r);
    return v;
  };

  // 资源长度
  if (new Set(raws.map((r) => r.source.byteLength)).size > 1) {
    items.push({
      table: 'resource',
      id: null,
      field: 'byteLength',
      offset: hex2(0),
      size: 0,
      cls: 'rule',
      byteOffsets: [],
      values: valuesOf((r) => r.source.byteLength),
    });
  }

  // 头部：计数与偏移
  TABLE_ORDER.forEach((t, i) => {
    for (const [k, off] of [
      ['count', i * 8],
      ['offset', i * 8 + 4],
    ] as const) {
      if (new Set(raws.map((r) => r.header[t][k])).size > 1) {
        items.push({
          table: 'header',
          id: null,
          field: `${t}.${k}`,
          offset: hex2(off),
          size: 4,
          cls: 'rule',
          byteOffsets: [],
          values: valuesOf((r) => r.header[t][k]),
        });
      }
    }
  });

  // 逐记录、逐字段
  for (const t of TABLE_ORDER) {
    const maxCount = Math.max(...raws.map((r) => r.header[t].count));
    for (let id = 1; id <= maxCount; id++) {
      const hexes = raws.map((r) => recordHex(r, t, id));
      if (hexes.some((h) => h === null)) {
        items.push({
          table: t,
          id,
          field: '<record>',
          offset: hex2(0),
          size: 0,
          cls: 'rule',
          byteOffsets: [],
          values: valuesOf((r) => (recordHex(r, t, id) === null ? 'absent' : 'present')),
        });
        continue;
      }
      if (new Set(hexes).size === 1) continue;
      const bufs = hexes.map((h) => fromHex(h!));
      const readers = bufs.map((b, i) => new BinReader(b, `${ids[i]}/${t}#${id}`));
      for (const spec of LAYOUTS[t]) {
        const slices = bufs.map((b) => b.subarray(spec.off, spec.off + spec.size));
        if (slices.every((s) => bytesEqual(s, slices[0]!))) continue;
        const byteOffsets: string[] = [];
        for (let k = 0; k < spec.size; k++) {
          if (slices.some((s) => s[k] !== slices[0]![k])) byteOffsets.push(hex2(spec.off + k));
        }
        const values: Partial<Record<RawSourceId, FieldValue>> = {};
        readers.forEach((r, i) => {
          values[ids[i]!] = readFieldValue(r, 0, spec);
        });
        items.push({
          table: t,
          id,
          field: spec.name,
          offset: hex2(spec.off),
          size: spec.size,
          cls: spec.cls,
          byteOffsets,
          values,
        });
      }
    }
  }

  const summaryMap = new Map<string, DiffSummaryRow>();
  for (const it of items) {
    const key = `${it.table}|${it.field}`;
    const row = summaryMap.get(key) ?? {
      table: it.table,
      field: it.field,
      offset: it.offset,
      cls: it.cls,
      bucket: bucketOf(it.cls),
      records: 0,
      byteOffsets: [],
    };
    row.records++;
    for (const b of it.byteOffsets) if (!row.byteOffsets.includes(b)) row.byteOffsets.push(b);
    row.byteOffsets.sort();
    summaryMap.set(key, row);
  }

  const groups = new Map<string, RawSourceId[]>();
  for (const r of raws)
    groups.set(r.source.resourceSha256, [...(groups.get(r.source.resourceSha256) ?? []), r.source.id]);

  const rule = items.filter((it) => bucketOf(it.cls) === 'rule');
  const presentation = items.filter((it) => bucketOf(it.cls) === 'presentation');
  return {
    schema: 'rich4.map-diff/1',
    globalMapId: gm,
    baseline: ids[0]!,
    sources: raws.map((r) => ({
      id: r.source.id,
      edition: r.source.edition,
      file: r.source.file,
      resource: r.source.resource,
      byteLength: r.source.byteLength,
      resourceSha256: r.source.resourceSha256,
    })),
    identicalGroups: [...groups.values()],
    identical: groups.size === 1,
    counts: { rule: rule.length, presentation: presentation.length },
    summary: [...summaryMap.values()],
    rule,
    presentation,
  };
}

/** 只有表现相关差异（或完全一致）→ 0；存在规则相关差异 → 4。 */
export function diffExitCode(diff: MapRawDiff): number {
  return diff.rule.length > 0 ? ExitCode.RULE_DIFF : ExitCode.OK;
}

/** 规则差异项的键：`<表>#<记录号>.<字段>`（头部 / 资源级没有记录号，写 -），例如 companies#4.name。 */
export function ruleDiffKey(it: Pick<DiffItem, 'table' | 'id' | 'field'>): string {
  return `${it.table}#${it.id ?? '-'}.${it.field}`;
}

export interface AcceptedRuleDiffs {
  /** 选定的基线（该图 overrides 的 source.id 必须与之相同） */
  baseline: RawSourceId;
  /** 已知的规则差异键（ruleDiffKey） */
  keys: readonly string[];
  /** 人读说明 */
  note: string;
}

/**
 * 已知、并已选定基线的 map diff 规则差异（按 gm）。`all` 子命令只在某图的规则差异**正好等于**这里的清单、
 * 且该图 overrides 的 source.id 与清单的基线相同时，把 map diff 的 exit 4 视为已处理；其余一律按 exit 4 停下。
 * 两处都以 v206-mapdat 为基线：与 v3.11 一致，v2.06 exe 先读 MapDat（VERIFY V-M1、data-pipeline.md §3）。
 */
export const ACCEPTED_RULE_DIFFS: Readonly<Record<number, AcceptedRuleDiffs>> = {
  1: {
    baseline: 'v206-mapdat',
    keys: ['companies#4.name'],
    note: '大陆 C4 名称：v206-mapdat / v3.11「王井府百貨」，v206-mapmkf「玉井府百貨」',
  },
  2: {
    baseline: 'v206-mapdat',
    keys: ['lands#17.rent'],
    note: '日本 L17 二级过路费：v206-mapdat / v3.11 750，v206-mapmkf 7500',
  },
};

export interface RuleDiffAcceptance {
  ok: boolean;
  /** 清单之外的规则差异 */
  unexpected: string[];
  /** 清单里有、这次没出现的差异 */
  missing: string[];
  /** 基线不符时的说明（overrides 未选基线或选的不是清单的基线） */
  baselineProblem: string | null;
}

/**
 * 某图的规则差异能否视为已处理：规则差异键的集合与 ACCEPTED_RULE_DIFFS[gm].keys 完全相同，
 * 且 overrides 选定的基线（chosen，读不到时为 null）与清单一致。没有清单的图一律不放行。
 */
export function acceptRuleDiffs(
  diff: Pick<MapRawDiff, 'globalMapId' | 'rule'>,
  chosen: RawSourceId | null,
  accepted: Readonly<Record<number, AcceptedRuleDiffs>> = ACCEPTED_RULE_DIFFS,
): RuleDiffAcceptance {
  const spec = accepted[diff.globalMapId];
  const got = [...new Set(diff.rule.map(ruleDiffKey))].sort();
  const want = [...(spec?.keys ?? [])].sort();
  const unexpected = got.filter((k) => !want.includes(k));
  const missing = want.filter((k) => !got.includes(k));
  let baselineProblem: string | null = null;
  if (!spec) baselineProblem = `gm ${diff.globalMapId} 没有已知规则差异清单`;
  else if (chosen === null) baselineProblem = `overrides 没有选定基线（清单要求 ${spec.baseline}）`;
  else if (chosen !== spec.baseline) baselineProblem = `overrides 的基线是 ${chosen}，清单要求 ${spec.baseline}`;
  return {
    ok: unexpected.length === 0 && missing.length === 0 && baselineProblem === null,
    unexpected,
    missing,
    baselineProblem,
  };
}
