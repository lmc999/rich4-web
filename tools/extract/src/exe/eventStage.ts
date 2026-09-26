import { hexVa, type PeFile } from '../pe/scan';
import { CodeIndex } from './code';
import { type ConstantAnchors, type ConstantResult, loadConstantAnchors, resolveConstants } from './constants';
import { HELPER_CALL_SITES } from './eventSpec';
import { extractEvents, resolveHelpers } from './events';
import { type AddressTranslator, stringTranslator } from './insnTransfer';
import { LocateError, locateTable } from './locate';
import { chk, type TableSpec } from './tables/common';
import {
  codeOf,
  fateHandlersSpec,
  magicConditionsSpec,
  magicCondJumpSpec,
  magicEffectJumpSpec,
  magicEffectsSpec,
  newsCategoriesSpec,
  newsHandlersSpec,
} from './tables/events';
import type {
  Check,
  ConstantValues,
  EventTableId,
  EventTablesInfo,
  ExtractedTables,
  LocateContext,
  LocateInfo,
  ViewTables,
} from './types';
import { xrefTransfer } from './xrefTransfer';

/**
 * extractTables 的第二阶段（D2 第二部分）：常量锚点、新闻 / 命运 / 魔法屋、视野投影表。
 * 任何一步定位失败都不影响固定表：对应字段为 null，并记一条事实核对（已登记的原版 exe 为 error，其他为 warn）。
 */

export interface StageRef {
  file: PeFile;
  tables: ExtractedTables;
}

export interface StageResult {
  constants: ConstantValues | null;
  constantResults: ConstantResult[] | null;
  eventTables: EventTablesInfo | null;
  news: ExtractedTables['news'];
  fate: ExtractedTables['fate'];
  magic: ExtractedTables['magic'];
  view: ViewTables | null;
  facts: Check[];
}

function constantValues(results: readonly ConstantResult[], side: 'v311' | 'v206'): ConstantValues {
  const out: ConstantValues = {};
  for (const r of results) {
    const s = side === 'v311' ? r.v311 : r.v206;
    out[r.id] = { value: s?.value ?? null, va: s?.va ?? null, ok: s?.ok ?? false };
  }
  return out;
}

// ───────────────────────── 视野投影表（V-E10） ─────────────────────────

const VIEW_DIRS = 8;
const VIEW_SIZE = 29;
const CELL_STRIDE = VIEW_SIZE * VIEW_SIZE * 4;
const DRAW_STRIDE = 0x260;
const DRAW_MAX = DRAW_STRIDE / 2;
/** v3.11 参考地址（anchors 之外的内部提示；v2.06 用 xrefTransfer 迁移） */
const VIEW_HINT = { cellScreen: 0x46ccf0, subcell: 0x474910, drawOrder: 0x473610 } as const;

const s8 = (v: number) => (v << 24) >> 24;
const s16 = (v: number) => (v << 16) >> 16;

function readView(file: PeFile, va: { cellScreen: number; subcell: number; drawOrder: number }): ViewTables {
  const cell: [number, number][][] = [];
  const sub: [number, number, number, number][] = [];
  const draw: [number, number][][] = [];
  for (let d = 0; d < VIEW_DIRS; d++) {
    const rows: [number, number][] = [];
    for (let k = 0; k < VIEW_SIZE * VIEW_SIZE; k++) {
      const at = va.cellScreen + d * CELL_STRIDE + k * 4;
      rows.push([s16(file.u16(at)), s16(file.u16(at + 2))]);
    }
    cell.push(rows);
    const m = file.slice(va.subcell + d * 4, 4);
    sub.push([s8(m[0]!), s8(m[1]!), s8(m[2]!), s8(m[3]!)]);
    const order: [number, number][] = [];
    for (let k = 0; k < DRAW_MAX; k++) {
      const dx = s8(file.u8(va.drawOrder + d * DRAW_STRIDE + 2 * k));
      if (dx === -128) break;
      order.push([dx, s8(file.u8(va.drawOrder + d * DRAW_STRIDE + 2 * k + 1))]);
    }
    draw.push(order);
  }
  return {
    cellScreen: { va: hexVa(va.cellScreen), dirs: VIEW_DIRS, size: VIEW_SIZE, data: cell },
    subcell: { va: hexVa(va.subcell), data: sub },
    drawOrder: { va: hexVa(va.drawOrder), data: draw },
  };
}

function viewChecks(v: ViewTables): Check[] {
  const center = (VIEW_SIZE * VIEW_SIZE - 1) / 2;
  const centered = v.cellScreen.data.every((d) => d[center]![0] === 0 && d[center]![1] === 0);
  const subOk = v.subcell.data.every((m) => m.every((x) => Math.abs(x) <= 64) && m.some((x) => x !== 0));
  const drawOk = v.drawOrder.data.every((d) => d.length > 100 && d.length < DRAW_MAX);
  return [
    chk('view.cellCenter', 'error', centered, centered ? '8 个视角的中心格都映射到 (0,0)' : '有视角的中心格不在 (0,0)'),
    chk('view.subcell', 'error', subOk, subOk ? '8 个 2×2 亚像素矩阵的元素都在 ±64 内' : '亚像素矩阵异常'),
    chk('view.drawOrder', 'error', drawOk, `绘制顺序项数 [${v.drawOrder.data.map((d) => d.length).join(',')}]`),
  ];
}

function locateView(
  file: PeFile,
  edition: string,
  ref: StageRef | null,
): { va: typeof VIEW_HINT; detail: string } | null {
  if (edition === 'v311' || !ref) return edition === 'v311' ? { va: VIEW_HINT, detail: 'v3.11 参考地址' } : null;
  const refView = ref.tables.view;
  if (!refView) return null;
  const out: Record<string, number> = {};
  for (const [k, span] of [
    ['cellScreen', 4],
    ['subcell', 4],
    ['drawOrder', 2],
  ] as const) {
    const x = xrefTransfer(ref.file, file, Number.parseInt(refView[k].va, 16), { span });
    if (x.va === null) return null;
    out[k] = x.va;
  }
  return { va: out as typeof VIEW_HINT, detail: '自 v3.11 按引用点迁移' };
}

// ───────────────────────── 第二阶段入口 ─────────────────────────

export interface StageOptions {
  constants?: ConstantAnchors;
  knownFileId: string | null;
  ref?: StageRef | undefined;
}

export function runEventStage(ctx: LocateContext, opts: StageOptions): StageResult {
  const file = ctx.file;
  const level = opts.knownFileId !== null ? 'error' : 'warn';
  const facts: Check[] = [];
  const res: StageResult = {
    constants: null,
    constantResults: null,
    eventTables: null,
    news: null,
    fate: null,
    magic: null,
    view: null,
    facts,
  };
  const code = codeOf(ctx);
  const refCode = opts.ref ? CodeIndex.build(opts.ref.file) : null;
  const translate: AddressTranslator | undefined = opts.ref ? stringTranslator(opts.ref.file, file) : undefined;
  const isRef = ctx.edition !== 'v206';

  // 常量锚点
  let anchors: ConstantAnchors | null = null;
  try {
    anchors = opts.constants ?? loadConstantAnchors();
  } catch (e) {
    facts.push(chk('constants.anchors', 'error', false, e instanceof Error ? e.message : String(e)));
  }
  if (anchors) {
    const results = isRef
      ? resolveConstants(anchors, code, null)
      : resolveConstants(anchors, refCode, code, { transfer: 'missing', ...(translate ? { translate } : {}) });
    res.constantResults = results;
    res.constants = constantValues(results, isRef ? 'v311' : 'v206');
    const bad = results.filter((r) => !(isRef ? r.v311.ok : r.v206?.ok));
    facts.push(
      chk(
        'constants.resolved',
        level,
        bad.length === 0,
        bad.length === 0
          ? `${results.length} 个常量锚点全部解析且等于期望值`
          : `${bad.length}/${results.length} 个常量不符或未解析：${bad
              .slice(0, 8)
              .map((r) => r.id)
              .join('、')}${bad.length > 8 ? '…' : ''}`,
      ),
    );
  }

  // 新闻 / 命运 / 魔法屋的表
  try {
    const locate = {} as Record<EventTableId, LocateInfo>;
    const run = <R>(spec: TableSpec<R>): R => {
      const { va, info } = locateTable(spec, ctx);
      ctx.located[spec.id] = va;
      locate[spec.id as EventTableId] = info;
      return spec.parse(file, va, ctx);
    };
    const newsHandlers = run(newsHandlersSpec);
    const newsCategories = run(newsCategoriesSpec);
    const fateHandlers = run(fateHandlersSpec);
    const magicEffects = run(magicEffectsSpec);
    const magicConditions = run(magicConditionsSpec);
    const magicEffectJump = run(magicEffectJumpSpec);
    const magicCondJump = run(magicCondJumpSpec);
    // 非参考版本没有 v3.11 可迁移时无法识别辅助函数（调用点 VA 属于 v3.11），全部记为 null
    const helpers =
      isRef || refCode
        ? resolveHelpers(code, isRef ? null : refCode, translate)
        : { byName: Object.fromEntries(Object.keys(HELPER_CALL_SITES).map((k) => [k, null])) };
    const ev = extractEvents({
      code,
      edition: isRef ? 'v311' : 'v206',
      newsHandlers,
      newsCategories,
      fateHandlers,
      magicEffects,
      magicConditions,
      magicEffectJump,
      magicCondJump,
      helpers,
      constants: res.constantResults ?? [],
    });
    res.eventTables = {
      locate,
      newsHandlers: newsHandlers.map(hexVa),
      fateHandlers: fateHandlers.map(hexVa),
      magicEffectJump: magicEffectJump.map(hexVa),
      magicCondJump: magicCondJump.map(hexVa),
      newsCategoryNames: newsCategories.names,
      helpers: helpers.byName,
    };
    res.news = ev.news;
    res.fate = ev.fate;
    res.magic = ev.magic;
    const unresolved = Object.entries(helpers.byName).filter(([, v]) => v === null);
    facts.push(
      chk(
        'events.helpers',
        isRef || opts.ref ? level : 'info',
        unresolved.length === 0,
        unresolved.length === 0
          ? `${Object.keys(helpers.byName).length} 个辅助函数全部识别`
          : `未识别：${unresolved.map(([k]) => k).join('、')}`,
      ),
    );
    const withHeadline =
      ev.news.filter((r) => r.headline !== null).length + ev.fate.filter((r) => r.headline !== null).length;
    facts.push(
      chk('events.headlines', 'warn', withHeadline === 36 + 37, `新闻 + 命运有标题串的处理函数 ${withHeadline}/73`),
    );
  } catch (e) {
    if (!(e instanceof LocateError)) throw e;
    facts.push(chk('events.located', level, false, `新闻/命运/魔法屋表定位失败：${e.message}`));
  }

  // 视野投影表
  const v = locateView(file, ctx.edition, opts.ref ?? null);
  if (v) {
    try {
      const view = readView(file, v.va);
      const checks = viewChecks(view);
      facts.push(...checks);
      if (checks.every((c) => c.ok)) res.view = view;
    } catch (e) {
      facts.push(chk('view.read', level, false, e instanceof Error ? e.message : String(e)));
    }
  } else if (ctx.edition !== 'unknown') {
    facts.push(chk('view.located', level, false, '视野投影表未定位（v2.06 需要 v3.11 参考）'));
  }
  return res;
}
