import { sha256Hex } from '../io/hash';
import { canonicalJson } from '../io/writeCanonicalJson';
import { Big5StringIndex, PeFile } from '../pe/scan';
import { loadTableAnchors, type TableAnchors } from './anchors';
import type { ConstantAnchors } from './constants';
import { runEventStage } from './eventStage';
import { locateTable } from './locateTable';
import { cardsSpec } from './tables/cards';
import { charactersSpec } from './tables/characters';
import { chk, stripHex, type TableSpec } from './tables/common';
import { facilityLevelsSpec } from './tables/facilityLevels';
import { holidayCodeEvidence, holidaysSpec } from './tables/holidays';
import { lunarSpec } from './tables/lunar';
import { findDefaultIndex, setupDaysSpec, setupFundsSpec, setupWealthSpec } from './tables/setup';
import { STOCKS_PER_MAP, stocksSpec } from './tables/stocks';
import { toolsSpec } from './tables/tools';
import type {
  AnyTableId,
  Check,
  ExeEdition,
  ExtractedTables,
  LocateContext,
  LocateInfo,
  TableDigest,
  TableId,
} from './types';

export { LocateError, locateTable } from './locateTable';

export interface ExtractOptions {
  label?: string;
  edition?: ExeEdition | 'unknown';
  knownFileId?: string | null;
  /** 参考版本（v3.11）的抽取结果与文件，用于 xrefTransfer；抽取 v3.11 本身时不传 */
  ref?: { bytes: Uint8Array; tables: ExtractedTables } | undefined;
  anchors?: TableAnchors;
  /** 常量锚点（默认读 anchors/constants.json） */
  constants?: ConstantAnchors;
  /** 跳过第二阶段（常量、新闻/命运/魔法屋、视野表）；edition 为 unknown 时总是跳过 */
  skipEvents?: boolean;
}

function digest(file: PeFile, va: number, len: number, content: unknown): TableDigest {
  return {
    bytes: len,
    bytesSha256: sha256Hex(file.slice(va, len)),
    contentSha256: sha256Hex(new TextEncoder().encode(canonicalJson(content))),
  };
}

/** 行对象去掉 hex 后参与内容摘要；数值数组原样 */
function strip(v: unknown): unknown {
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object' && v[0] !== null) {
    return stripHex(v as readonly object[]);
  }
  return v;
}

/** 从一个 exe 抽取全部固定表（纯函数：只读入参字节） */
export function extractTables(bytes: Uint8Array, opts: ExtractOptions = {}): ExtractedTables {
  const label = opts.label ?? 'exe';
  const file = new PeFile(bytes, label);
  const anchors = opts.anchors ?? loadTableAnchors();
  const refFile = opts.ref ? new PeFile(opts.ref.bytes, 'ref') : undefined;
  const refLocated: Partial<Record<AnyTableId, number>> = {};
  if (opts.ref) {
    for (const [k, v] of Object.entries(opts.ref.tables.locate)) refLocated[k as TableId] = Number.parseInt(v.va, 16);
    for (const [k, v] of Object.entries(opts.ref.tables.eventTables?.locate ?? {})) {
      refLocated[k as AnyTableId] = Number.parseInt(v.va, 16);
    }
  }
  const ctx: LocateContext = {
    file,
    strings: Big5StringIndex.build(file),
    edition: opts.edition ?? 'unknown',
    anchors,
    located: {},
    ref: refFile ? { file: refFile, located: refLocated } : undefined,
  };
  const locate = {} as Record<TableId, LocateInfo>;
  const digests = {} as Record<TableId, TableDigest>;
  const run = <R>(spec: TableSpec<R>): R => {
    const { va, info } = locateTable(spec, ctx);
    ctx.located[spec.id] = va;
    const id = spec.id as TableId;
    locate[id] = info;
    const r = spec.parse(file, va, ctx);
    if (id === 'stocks') ctx.maps = (r as { maps: number }).maps;
    const content = id === 'stocks' || id === 'holidays' ? strip((r as { rows: unknown }).rows) : strip(r);
    digests[id] = digest(file, va, spec.byteLength(ctx), content);
    return r;
  };

  const cards = run(cardsSpec);
  const tools = run(toolsSpec);
  const characters = run(charactersSpec);
  const stocks = run(stocksSpec);
  const holidayRows = run(holidaysSpec);
  const holidays = { ...holidayRows, code: holidayCodeEvidence(file, ctx.located.holidays!) };
  const funds = run(setupFundsSpec);
  const days = run(setupDaysSpec);
  const wealthMultipliers = run(setupWealthSpec);
  const facilityMax = run(facilityLevelsSpec);
  const lunar = run(lunarSpec);

  const setup = {
    funds,
    days,
    wealthMultipliers,
    defaults: {
      funds: findDefaultIndex(file, ctx.located.setupFunds!, funds),
      days: findDefaultIndex(file, ctx.located.setupDays!, days),
      wealthMultipliers: findDefaultIndex(file, ctx.located.setupWealth!, wealthMultipliers),
    },
  };

  const facts = collectFacts(anchors, { cards, tools, characters, stocks, holidays, setup, facilityMax, lunar });
  const stage =
    opts.skipEvents || ctx.edition === 'unknown'
      ? null
      : runEventStage(ctx, {
          knownFileId: opts.knownFileId ?? null,
          ref: refFile && opts.ref ? { file: refFile, tables: opts.ref.tables } : undefined,
          ...(opts.constants ? { constants: opts.constants } : {}),
        });
  if (stage) facts.push(...stage.facts);
  return {
    schema: 'rich4.exe-tables/1',
    edition: ctx.edition,
    exe: { file: label, sha256: sha256Hex(bytes), bytes: bytes.length, knownFileId: opts.knownFileId ?? null },
    locate,
    digests,
    cards,
    tools,
    characters,
    stocks,
    holidays,
    setup,
    facilityLevels: { types: [...anchors.tables.facilityLevels.types], max: facilityMax },
    lunar,
    constants: stage?.constants ?? null,
    eventTables: stage?.eventTables ?? null,
    news: stage?.news ?? null,
    fate: stage?.fate ?? null,
    magic: stage?.magic ?? null,
    view: stage?.view ?? null,
    facts,
  };
}

// ───────────────────────── 事实核对（期望值来自调研文档） ─────────────────────────

/** @source docs/research/r_items.md；mytbk rich4_tool_table.c */
export const EXPECT_TOOL_PRICES_1_8 = [15, 30, 25, 25, 80, 150, 100, 30] as const;
/** @source nurockplayer calendar-and-setup.md；mytbk */
export const EXPECT_CASH_RATIOS = [50, 40, 70, 60, 40, 70, 50, 40, 60, 50, 55, 80] as const;
/** Fandom 与 r_cards 有争议的四张卡：嫁禍 40、紅卡 50、漲價 35、同盟 40（卡号 19/24/27/29） */
export const EXPECT_DISPUTED_CARD_PRICES: Readonly<Record<number, number>> = { 19: 40, 24: 50, 27: 35, 29: 40 };
/**
 * 台湾 12 支股票（名称 / 初始价 / 波动）。@source docs/research/g_map.md、r_references.md（oama stocks.ts，v3.11）
 */
export const EXPECT_TAIWAN_STOCKS: readonly (readonly [string, number, number])[] = [
  ['中國信託', 100, 1.0],
  ['臺灣人壽', 40, 0.6],
  ['大宇百貨', 25, 1.5],
  ['台積電', 180, 1.6],
  ['大宇資訊', 80, 1.2],
  ['台灣塑膠', 60, 1.0],
  ['裕隆汽車', 60, 1.4],
  ['遠東紡織', 27, 0.9],
  ['統一超商', 310, 0.7],
  ['震旦行', 66, 1.0],
  ['萊爾富', 171, 1.4],
  ['聯合報', 280, 0.8],
];

interface FactInput {
  cards: ExtractedTables['cards'];
  tools: ExtractedTables['tools'];
  characters: ExtractedTables['characters'];
  stocks: ExtractedTables['stocks'];
  holidays: ExtractedTables['holidays'];
  setup: ExtractedTables['setup'];
  facilityMax: number[];
  lunar: ExtractedTables['lunar'];
}

export function collectFacts(anchors: TableAnchors, t: FactInput): Check[] {
  const out: Check[] = [];
  const toolPrices = t.tools.slice(0, 8).map((r) => r.price);
  out.push(
    chk(
      'tools.prices1to8',
      'error',
      toolPrices.join() === EXPECT_TOOL_PRICES_1_8.join(),
      `道具 1..8 价格 [${toolPrices.join(',')}]`,
    ),
  );
  const disputed = Object.entries(EXPECT_DISPUTED_CARD_PRICES).map(([id, p]) => {
    const r = t.cards[Number(id) - 1];
    return { id, name: r?.name ?? '', got: r?.price, want: p };
  });
  out.push(
    chk(
      'cards.disputedPrices',
      'error',
      disputed.every((d) => d.got === d.want),
      disputed.map((d) => `${d.name}=${d.got}`).join('、'),
    ),
  );
  const cash = t.characters.map((r) => r.cashRatio);
  out.push(
    chk('characters.cashRatios', 'error', cash.join() === EXPECT_CASH_RATIOS.join(), `现金比例 [${cash.join(',')}]`),
  );
  const tw = t.stocks.rows.filter((r) => r.mapId === 0);
  const twBad = EXPECT_TAIWAN_STOCKS.flatMap(([name, price, vol], i) => {
    const r = tw[i];
    return r && r.nameNorm === name && r.price === price && r.volatility === vol
      ? []
      : [`#${i} 期望 ${name} ${price}/${vol}，实际 ${r ? `${r.nameNorm} ${r.price}/${r.volatility}` : '缺'}`];
  });
  out.push(
    chk(
      'stocks.taiwanSample',
      'error',
      tw.length === STOCKS_PER_MAP && twBad.length === 0,
      twBad.length === 0 ? '台湾 12 支股票名称/初始价/波动全部吻合' : twBad.join('；'),
    ),
  );
  const tw24 = t.holidays.rows.filter((r) => r.mapId === 0 && !r.empty).length;
  out.push(chk('holidays.taiwan24', 'warn', tw24 === 24, `台湾节日非空槽 ${tw24}/24`));
  const code = t.holidays.code;
  const has = (arr: readonly number[], v: number) => arr.includes(v);
  out.push(
    chk(
      'holidays.codeLayout',
      'warn',
      has(code.flags0Tests, 0x80) &&
        has(code.flags0Cmps, 0) &&
        [1, 4, 8].every((b) => has(code.eventTests, b)) &&
        !has(code.eventTests, 2),
      `代码用法：+0 test [${code.flags0Tests.map((v) => `0x${v.toString(16)}`)}]、+0 cmp [${code.flags0Cmps}]、` +
        `+5 test [${code.eventTests}]；字段引用次数 [${code.fieldRefs}]`,
    ),
  );
  const afterLunar: string[] = [];
  for (let gm = 0; gm < t.holidays.maps; gm++) {
    const rows = t.holidays.rows.filter((r) => r.mapId === gm && !r.empty && !r.disabled);
    const firstLunar = rows.findIndex((r) => r.lunar);
    if (firstLunar >= 0 && rows.slice(firstLunar).some((r) => !r.lunar)) afterLunar.push(String(gm));
  }
  out.push(
    chk(
      'holidays.lunarLast',
      'info',
      afterLunar.length === 0,
      afterLunar.length === 0
        ? '各图农历项都排在公历项之后（原版「农历项之后改用农历日期比较」的写法不影响结果）'
        : `地图 ${afterLunar.join(',')} 有排在农历项之后的非农历项（原版会拿农历日期去比）`,
    ),
  );
  const lunar31 = t.holidays.rows.filter((r) => r.lunar && !r.empty && r.day > t.lunar.maxDayMonth12 && r.month === 12);
  out.push(
    chk(
      'holidays.lunarUnreachable',
      'info',
      lunar31.length === 0,
      lunar31.length === 0
        ? '没有超出农历表范围的农历节日'
        : `农历表十二月最大日 ${t.lunar.maxDayMonth12}，以下项永不命中：${lunar31.map((r) => `${r.mapId}/${r.slot}（${r.month}/${r.day}）`).join('、')}`,
    ),
  );
  for (const key of ['funds', 'days', 'wealthMultipliers'] as const) {
    const want = anchors.tables.setup[key];
    out.push(
      chk(
        `setup.${key}`,
        'error',
        t.setup[key].join() === want.join(),
        `[${t.setup[key].join(',')}]（期望 [${want}]）`,
      ),
    );
  }
  const fl = anchors.tables.facilityLevels.expect;
  out.push(
    chk(
      'facilityLevels.expect',
      'error',
      t.facilityMax.join() === fl.join(),
      `[${t.facilityMax.join(',')}]（期望 [${fl}]）`,
    ),
  );
  const d = t.setup.defaults.funds;
  out.push(
    chk(
      'setup.defaultFunds',
      'info',
      d.index !== null,
      d.index !== null ? `默认资金档位下标 ${d.index} → ${d.value}` : `无法唯一推定：${d.detail}`,
    ),
  );
  return out;
}
