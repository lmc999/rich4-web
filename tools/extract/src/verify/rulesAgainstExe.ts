import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExeEdition, ExtractedTables } from '../exe/types';

/**
 * verify --tables（data-pipeline.md §10.1、§10.2）：手录规则表（packages/shared/src/data/tables/*.ts）与 exe 抽取值对照。
 * 手录表由引擎侧并行编写，这里按运行时路径动态加载、按字段鸭子类型读取：
 * 文件缺失、导出名不符或结构不完整时，该表记为「待对照」，只输出 exe 值与对照清单，不算失败。
 */

export const MANUAL_TABLES_DIR = 'packages/shared/src/data/tables';

export interface ManualCard {
  id: number;
  price: number;
  deckCount: number;
  f7: number;
}
export interface ManualItem {
  id: number;
  price: number;
  poolInit: number;
}
export interface ManualCharacter {
  id: number;
  gender: string;
  personality: number;
  loanRatio: number;
  cashRatio: number;
  stockRatio: number;
  color: string;
}
export interface ManualSetupTable {
  options: number[];
  defaultIndex: number;
}
export interface ManualTables {
  cards: ManualCard[] | null;
  items: ManualItem[] | null;
  characters: ManualCharacter[] | null;
  setup: { funds: ManualSetupTable | null; days: ManualSetupTable | null; wealth: ManualSetupTable | null };
  facilityMax: number[] | null;
  /** 全部手录记录的 @verify 引用（extract:…） */
  verifyRefs: { table: string; ref: string }[];
  notes: string[];
}

type Rec = Record<string, unknown>;
const isRec = (x: unknown): x is Rec => typeof x === 'object' && x !== null && !Array.isArray(x);
const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

function rowsOf<T>(x: unknown, n: number, pick: (r: Rec) => T | null): T[] | null {
  if (!Array.isArray(x) || x.length !== n) return null;
  const out: T[] = [];
  for (const r of x) {
    if (!isRec(r)) return null;
    const v = pick(r);
    if (v === null) return null;
    out.push(v);
  }
  return out;
}

function setupOf(x: unknown): ManualSetupTable | null {
  if (!isRec(x) || !Array.isArray(x.options) || !num(x.defaultIndex)) return null;
  const options = x.options.filter(num);
  return options.length === x.options.length ? { options, defaultIndex: x.defaultIndex } : null;
}

function verifyRefsOf(table: string, x: unknown): { table: string; ref: string }[] {
  const out: { table: string; ref: string }[] = [];
  const visit = (r: unknown) => {
    if (!isRec(r) || !Array.isArray(r.src)) return;
    for (const s of r.src) if (isRec(s) && typeof s.verify === 'string') out.push({ table, ref: s.verify });
  };
  if (Array.isArray(x)) x.forEach(visit);
  else visit(x);
  return out;
}

async function tryImport(file: string, notes: string[]): Promise<Rec | null> {
  if (!existsSync(file)) {
    notes.push(`${path.basename(file)} 不存在`);
    return null;
  }
  try {
    return (await import(pathToFileURL(file).href)) as Rec;
  } catch (e) {
    notes.push(`${path.basename(file)} 加载失败：${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    return null;
  }
}

/** 动态加载手录表（逐文件，互不影响） */
export async function loadManualTables(root: string): Promise<ManualTables> {
  const dir = path.join(root, MANUAL_TABLES_DIR);
  const notes: string[] = [];
  const m = async (name: string) => tryImport(path.join(dir, `${name}.ts`), notes);
  const [cardsM, itemsM, charsM, setupM, facM] = [
    await m('cards'),
    await m('items'),
    await m('characters'),
    await m('setup'),
    await m('facilities'),
  ];
  const cards = rowsOf(cardsM?.CARDS, 30, (r) =>
    num(r.id) && num(r.price) && num(r.deckCount) && num(r.f7)
      ? { id: r.id, price: r.price, deckCount: r.deckCount, f7: r.f7 }
      : null,
  );
  if (cardsM && !cards) notes.push('cards.ts 没有 30 项 {id,price,deckCount,f7} 的 CARDS');
  const items = rowsOf(itemsM?.ITEMS, 13, (r) =>
    num(r.id) && num(r.price) && num(r.poolInit) ? { id: r.id, price: r.price, poolInit: r.poolInit } : null,
  );
  if (itemsM && !items) notes.push('items.ts 没有 13 项 {id,price,poolInit} 的 ITEMS');
  const characters = rowsOf(charsM?.CHARACTERS, 12, (r) =>
    num(r.id) &&
    typeof r.gender === 'string' &&
    num(r.personality) &&
    num(r.loanRatio) &&
    num(r.cashRatio) &&
    num(r.stockRatio) &&
    typeof r.color === 'string'
      ? {
          id: r.id,
          gender: r.gender,
          personality: r.personality,
          loanRatio: r.loanRatio,
          cashRatio: r.cashRatio,
          stockRatio: r.stockRatio,
          color: r.color,
        }
      : null,
  );
  if (charsM && !characters) notes.push('characters.ts 没有 12 项完整字段的 CHARACTERS');
  const setup = {
    funds: setupOf(setupM?.INITIAL_FUND_TABLE),
    days: setupOf(setupM?.TIME_LIMIT_TABLE),
    wealth: setupOf(setupM?.WIN_MULTIPLE_TABLE),
  };
  if (setupM && (!setup.funds || !setup.days || !setup.wealth)) {
    notes.push('setup.ts 缺少 INITIAL_FUND_TABLE / TIME_LIMIT_TABLE / WIN_MULTIPLE_TABLE 之一');
  }
  let facilityMax: number[] | null = null;
  const facList = facM?.FACILITIES;
  if (Array.isArray(facList) && facList.length === 5 && facList.every((f) => isRec(f) && num(f.maxLevel))) {
    facilityMax = facList.map((f) => (f as Rec).maxLevel as number);
  } else if (isRec(facM?.FACILITY_MAX_LEVEL)) {
    const r = facM.FACILITY_MAX_LEVEL as Rec;
    const order = ['park', 'hotel', 'mall', 'gas', 'lab'];
    if (order.every((k) => num(r[k]))) facilityMax = order.map((k) => r[k] as number);
  } else if (Array.isArray(facM?.FACILITY_MAX_LEVEL) && (facM.FACILITY_MAX_LEVEL as unknown[]).every(num)) {
    facilityMax = [...(facM.FACILITY_MAX_LEVEL as number[])];
  }
  if (facM && !facilityMax)
    notes.push('facilities.ts 没有可识别的设施等级上限（FACILITIES[].maxLevel 或 FACILITY_MAX_LEVEL）');
  const verifyRefs = [
    ...verifyRefsOf('cards', cardsM?.CARDS),
    ...verifyRefsOf('items', itemsM?.ITEMS),
    ...verifyRefsOf('characters', charsM?.CHARACTERS),
    ...verifyRefsOf('setup', setupM?.INITIAL_FUND_TABLE),
    ...verifyRefsOf('setup', setupM?.TIME_LIMIT_TABLE),
    ...verifyRefsOf('setup', setupM?.WIN_MULTIPLE_TABLE),
  ];
  return { cards, items, characters, setup, facilityMax, verifyRefs, notes };
}

// ───────────────────────── 对照 ─────────────────────────

export type CompareStatus = 'match' | 'mismatch' | 'pending' | 'exeOnly';

export interface CompareRow {
  table: string;
  key: string;
  manual: string | null;
  v206: string | null;
  v311: string | null;
  status: CompareStatus;
  /** 两版 exe 是否不同 */
  editionDiff: boolean;
}

export interface TableVerdict {
  table: string;
  items: number;
  manual: 'ok' | 'mismatch' | 'missing';
  editions: 'same' | 'diff' | 'single';
  mismatches: number;
  conclusion: string;
}

export interface RulesReport {
  schema: 'rich4.verify-tables/1';
  editions: ExeEdition[];
  rows: CompareRow[];
  verdicts: TableVerdict[];
  verifyRefs: { table: string; ref: string; ok: boolean; detail: string }[];
  checklist: string[];
  notes: string[];
}

type Getter = (t: ExtractedTables) => string | null;

function cmp(
  rows: CompareRow[],
  table: string,
  key: string,
  manual: string | null,
  exe: Partial<Record<ExeEdition, ExtractedTables>>,
  get: Getter,
): void {
  const v206 = exe.v206 ? get(exe.v206) : null;
  const v311 = exe.v311 ? get(exe.v311) : null;
  const exeVals = [v206, v311].filter((v): v is string => v !== null);
  const editionDiff = v206 !== null && v311 !== null && v206 !== v311;
  let status: CompareStatus;
  if (manual === null) status = exeVals.length > 0 ? 'exeOnly' : 'pending';
  else if (exeVals.length === 0) status = 'pending';
  else status = exeVals.every((v) => v === manual) ? 'match' : 'mismatch';
  rows.push({ table, key, manual, v206, v311, status, editionDiff });
}

const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export function compareRules(manual: ManualTables, exe: Partial<Record<ExeEdition, ExtractedTables>>): RulesReport {
  const rows: CompareRow[] = [];
  for (let i = 0; i < 30; i++) {
    const m = manual.cards?.[i] ?? null;
    const id = i + 1;
    cmp(rows, 'cards', `${id}.price`, s(m?.price), exe, (t) => s(t.cards[i]?.price));
    cmp(rows, 'cards', `${id}.initCount`, s(m?.deckCount), exe, (t) => s(t.cards[i]?.initCount));
    cmp(rows, 'cards', `${id}.f7`, s(m?.f7), exe, (t) => s(t.cards[i]?.f7));
    cmp(rows, 'cards', `${id}.f6`, null, exe, (t) => s(t.cards[i]?.f6));
  }
  for (let i = 0; i < 13; i++) {
    const m = manual.items?.[i] ?? null;
    const id = i + 1;
    cmp(rows, 'items', `${id}.price`, s(m?.price), exe, (t) => s(t.tools[i]?.price));
    cmp(rows, 'items', `${id}.stock`, s(m?.poolInit), exe, (t) => s(t.tools[i]?.stock));
    cmp(rows, 'items', `${id}.f6f7`, null, exe, (t) => (t.tools[i] ? `${t.tools[i]!.f6}/${t.tools[i]!.f7}` : null));
  }
  for (let i = 0; i < 12; i++) {
    const m = manual.characters?.[i] ?? null;
    const row = (t: ExtractedTables) => t.characters.find((c) => c.id === i);
    cmp(
      rows,
      'characters',
      `${i}.gender`,
      m ? (m.gender === 'm' ? '1' : m.gender === 'f' ? '0' : m.gender) : null,
      exe,
      (t) => s(row(t)?.gender),
    );
    cmp(rows, 'characters', `${i}.personality`, s(m?.personality), exe, (t) => s(row(t)?.personality));
    cmp(rows, 'characters', `${i}.loanRatio`, s(m?.loanRatio), exe, (t) => s(row(t)?.loanRatio));
    cmp(rows, 'characters', `${i}.cashRatio`, s(m?.cashRatio), exe, (t) => s(row(t)?.cashRatio));
    cmp(rows, 'characters', `${i}.stockRatio`, s(m?.stockRatio), exe, (t) => s(row(t)?.stockRatio));
    cmp(rows, 'characters', `${i}.color`, m ? m.color.toLowerCase().replace('#', '0x') : null, exe, (t) =>
      s(row(t)?.color),
    );
    cmp(rows, 'characters', `${i}.abilities`, null, exe, (t) => s(row(t)?.abilities));
  }
  const setupPairs = [
    ['funds', manual.setup.funds, (t: ExtractedTables) => t.setup.funds, 'funds'],
    ['days', manual.setup.days, (t: ExtractedTables) => t.setup.days, 'days'],
    ['wealthMultipliers', manual.setup.wealth, (t: ExtractedTables) => t.setup.wealthMultipliers, 'wealthMultipliers'],
  ] as const;
  for (const [name, m, get, dk] of setupPairs) {
    cmp(rows, 'setup', `${name}.options`, m ? m.options.join(',') : null, exe, (t) => get(t).join(','));
    cmp(rows, 'setup', `${name}.defaultIndex`, s(m?.defaultIndex), exe, (t) => s(t.setup.defaults[dk].index));
  }
  cmp(rows, 'facilityLevels', 'max', manual.facilityMax ? manual.facilityMax.join(',') : null, exe, (t) =>
    t.facilityLevels.max.join(','),
  );

  const verdicts: TableVerdict[] = [];
  for (const table of ['cards', 'items', 'characters', 'setup', 'facilityLevels']) {
    const rs = rows.filter((r) => r.table === table);
    const withManual = rs.filter((r) => r.manual !== null);
    const mism = rs.filter((r) => r.status === 'mismatch').length;
    const diff = rs.filter((r) => r.editionDiff).length;
    const both = rs.some((r) => r.v206 !== null) && rs.some((r) => r.v311 !== null);
    const manualState: TableVerdict['manual'] = withManual.length === 0 ? 'missing' : mism > 0 ? 'mismatch' : 'ok';
    const editions: TableVerdict['editions'] = !both ? 'single' : diff > 0 ? 'diff' : 'same';
    const conclusion =
      manualState === 'missing'
        ? '手录表缺失：只输出 exe 值（见对照清单）'
        : manualState === 'mismatch'
          ? `手录值与 exe 有 ${mism} 处不符`
          : `手录值与 exe 一致（${withManual.length} 项）`;
    verdicts.push({
      table,
      items: rs.length,
      manual: manualState,
      editions,
      mismatches: mism,
      conclusion: editions === 'diff' ? `${conclusion}；两版有 ${diff} 项不同` : conclusion,
    });
  }

  const anyExe = exe.v311 ?? exe.v206 ?? null;
  const verifyRefs = manual.verifyRefs.map((v) => ({ ...v, ...resolveVerifyRef(v.ref, anyExe) }));
  const checklist: string[] = [];
  if (!manual.cards)
    checklist.push('cards.ts：CARDS[0..29].{price, deckCount, f7} ↔ exe cards[1..30].{price, initCount, f7}');
  if (!manual.items) checklist.push('items.ts：ITEMS[0..12].{price, poolInit} ↔ exe tools[1..13].{price, stock}');
  if (!manual.characters) {
    checklist.push(
      'characters.ts：CHARACTERS[0..11].{gender, personality, loanRatio, cashRatio, stockRatio, color} ↔ exe characters +0x14/+0x17/+0x18/+0x19/+0x1a/+0x04',
    );
  }
  if (!manual.setup.funds || !manual.setup.days || !manual.setup.wealth) {
    checklist.push(
      'setup.ts：INITIAL_FUND_TABLE / TIME_LIMIT_TABLE / WIN_MULTIPLE_TABLE 的 options 与 defaultIndex ↔ exe setup.{funds,days,wealthMultipliers} 与 defaults',
    );
  }
  if (!manual.facilityMax) {
    checklist.push('facilities.ts：设施等级上限（公园/旅馆/购物中心/加油站/研究所）↔ exe facilityLevels.max');
  }
  return {
    schema: 'rich4.verify-tables/1',
    editions: (['v206', 'v311'] as const).filter((e) => exe[e] !== undefined),
    rows,
    verdicts,
    verifyRefs,
    checklist,
    notes: manual.notes,
  };
}

const TABLE_ALIASES: Record<string, keyof ExtractedTables> = {
  cards: 'cards',
  items: 'tools',
  tools: 'tools',
  characters: 'characters',
  setup: 'setup',
  stocks: 'stocks',
  holidays: 'holidays',
  facilityLevels: 'facilityLevels',
  facilities: 'facilityLevels',
};

/** 解析 `extract:<table>[<id>](.<field>)?`，确认引用的条目在抽取结果里存在 */
export function resolveVerifyRef(ref: string, t: ExtractedTables | null): { ok: boolean; detail: string } {
  const m = /^extract:([A-Za-z]+)(?:\[(\d+)\])?(?:\.([A-Za-z0-9_]+))?$/.exec(ref);
  if (!m) return { ok: false, detail: '格式应为 extract:<表>[<编号>].<字段>' };
  const key = TABLE_ALIASES[m[1]!];
  if (!key) return { ok: false, detail: `未知的表 ${m[1]}` };
  if (!t) return { ok: false, detail: '没有 exe 抽取结果' };
  if (m[2] === undefined) return { ok: true, detail: `表 ${key}` };
  const id = Number(m[2]);
  const rows: { id: number }[] =
    key === 'cards' ? t.cards : key === 'tools' ? t.tools : key === 'characters' ? t.characters : [];
  const row = rows.find((r) => r.id === id);
  if (!row) return { ok: false, detail: `${key} 没有编号 ${id}` };
  return { ok: true, detail: `${key}#${id}` };
}
