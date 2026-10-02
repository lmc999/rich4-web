import { blockedSlots } from '../map/parseRaw';
import type { MapDataRaw, RawCompany, RawLand, RawName } from '../map/rawTypes';

export type SampleStatus = 'pass' | 'fail' | 'warn';

export interface SampleResult {
  id: string;
  label: string;
  status: SampleStatus;
  expected: string;
  actual: string;
  detail?: string;
}

/** 台/臺 视为同一字，用于名称匹配。 */
export function normalizeName(s: string): string {
  return s.replaceAll('臺', '台');
}

function nameIs(n: RawName, ...wanted: string[]): boolean {
  return n.text !== null && wanted.map(normalizeName).includes(normalizeName(n.text));
}

const fmt = (v: unknown): string => JSON.stringify(v);
const eq = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

function sample(
  id: string,
  label: string,
  ok: boolean,
  expected: unknown,
  actual: unknown,
  detail?: string,
): SampleResult {
  const r: SampleResult = {
    id,
    label,
    status: ok ? 'pass' : 'fail',
    expected: typeof expected === 'string' ? expected : fmt(expected),
    actual: typeof actual === 'string' ? actual : fmt(actual),
  };
  if (detail !== undefined) r.detail = detail;
  return r;
}

function uniq<T>(xs: readonly T[]): T[] {
  const out: T[] = [];
  for (const x of xs) if (!out.some((y) => fmt(y) === fmt(x))) out.push(x);
  return out;
}

export interface StreetSpec {
  id: string;
  names: string[];
  count?: number;
  landPrice: number;
  housePrice?: number[];
  rent: number[];
}

function streetSamples(raw: MapDataRaw, s: StreetSpec): SampleResult[] {
  const lands: RawLand[] = raw.lands.filter((l) => nameIs(l.name, ...s.names)).sort((a, b) => a.id - b.id);
  const label = s.names[0]!;
  const out: SampleResult[] = [];
  const ids = `地块 ${lands.map((l) => l.id).join(',')}`;
  if (s.count !== undefined)
    out.push(sample(`${s.id}.count`, `${label} 块数`, lands.length === s.count, s.count, lands.length, ids));
  else out.push(sample(`${s.id}.exists`, `${label} 存在`, lands.length > 0, '≥1', lands.length, ids));
  const prices = uniq(lands.map((l) => l.landPrice));
  out.push(
    sample(
      `${s.id}.landPrice`,
      `${label} 地价`,
      lands.length > 0 && prices.length === 1 && prices[0] === s.landPrice,
      s.landPrice,
      prices.length === 1 ? prices[0] : prices,
    ),
  );
  if (s.housePrice) {
    const hp = lands.map((l) => l.housePrice);
    out.push(sample(`${s.id}.housePrice`, `${label} 房价（按编号）`, eq(hp, s.housePrice), s.housePrice, hp));
  }
  const rents = uniq(lands.map((l) => l.rent));
  out.push(
    sample(
      `${s.id}.rent`,
      `${label} 租金`,
      lands.length > 0 && rents.length === 1 && eq(rents[0]!, s.rent),
      s.rent,
      rents.length === 1 ? rents[0] : rents,
    ),
  );
  return out;
}

function companyByName(raw: MapDataRaw, ...names: string[]): RawCompany | undefined {
  return raw.companies.find((c) => nameIs(c.name, ...names));
}

type RawSourceId = MapDataRaw['source']['id'];

/** 企业样本：按名称（台湾，名称各来源一致）或按企业号（名称有来源差异的图）查找。 */
export interface CompanySpec {
  id: string;
  /** 标签里的显示名 */
  label: string;
  /** 按名称查找（台/臺 视为同一字） */
  names?: string[];
  /** 按企业号查找（1 起） */
  companyId?: number;
  fields: Partial<Record<'industry' | 'stockIndex' | 'assetValue', number>>;
}

/** 单个地块 / 企业字段的样本（已知瑕疵与多来源基线差异按来源给出期望）。 */
export interface FieldSpec {
  id: string;
  label: string;
  table: 'lands' | 'companies';
  recordId: number;
  field: 'landPrice' | 'rent' | 'name';
  /** 数组字段的下标（rent） */
  index?: number;
  expected: number | string;
  /** 个别来源的不同期望（documented rawDiff） */
  bySource?: Partial<Record<RawSourceId, number | string>>;
  detail?: string;
}

/**
 * 每张图的样本规格（data-pipeline.md §10.1）。
 * - hold：'exists' 只查关押格存在（台湾既有写法）；给出节点号时逐一核对，并核对景观 1「醫院」/2「監獄」；
 * - blocked：{ nodes } 只查封路节点数（台湾既有写法）；{ edges } 核对确切的边；
 * - streets：有独立出处的街道样本；新图暂无公开出处，留空并输出一条 ⚠️ 占位，等用户在原版核对后填入。
 */
export interface MapSampleSpec {
  key: string;
  globalMapId: number;
  counts: readonly [number, number, number, number, number];
  streets: readonly StreetSpec[];
  /** 新图：街道样本待原版核对（输出 warn 占位行） */
  streetsPending?: string;
  hold: 'exists' | { 8001: number; 8002: number };
  blocked: { nodes: number } | { edges: readonly string[] };
  /** bit31 禁放物件节点（日本快艇段）；省略则不核对 */
  noItems?: readonly number[];
  companies: readonly CompanySpec[];
  fields?: readonly FieldSpec[];
}

const HOLD_SCAPE_NAMES: Record<8001 | 8002, string> = { 8001: '醫院', 8002: '監獄' };

function holdSamples(raw: MapDataRaw, spec: MapSampleSpec): SampleResult[] {
  const out: SampleResult[] = [];
  for (const [type, label] of [
    [8001, '医院关押格'],
    [8002, '监狱关押格'],
  ] as const) {
    const nodes = raw.nodes.filter((n) => n.type === type);
    const scape = raw.landscapes[type - 8001];
    const scapeDesc = `引用景观 ${type - 8000}「${scape?.name.text ?? '?'}」`;
    if (spec.hold === 'exists') {
      out.push(
        sample(
          `hold.${type}`,
          `${label} type ${type}`,
          nodes.length > 0,
          '存在',
          nodes.length > 0 ? `节点 ${nodes.map((n) => n.id).join(',')}` : '无',
          scapeDesc,
        ),
      );
      continue;
    }
    const want = spec.hold[type];
    const ids = nodes.map((n) => n.id);
    const scapeName = scape?.name.text ?? '?';
    out.push(
      sample(
        `hold.${type}`,
        `${label} type ${type}（节点 / 景观 ${type - 8000}）`,
        ids.length === 1 && ids[0] === want && scapeName === HOLD_SCAPE_NAMES[type],
        `节点 ${want}「${HOLD_SCAPE_NAMES[type]}」`,
        `节点 ${ids.join(',') || '无'}「${scapeName}」`,
        scapeDesc,
      ),
    );
  }
  return out;
}

function blockedSample(raw: MapDataRaw, spec: MapSampleSpec): SampleResult {
  const blocked = raw.nodes.flatMap((n) => blockedSlots(n.flags).map((k) => ({ n, k })));
  const nodeIds = [...new Set(blocked.map((b) => b.n.id))];
  const emptySlot = blocked.filter((b) => b.n.adj[b.k] === 0);
  const desc = blocked.map((b) => `${b.n.id}「${b.n.name.text ?? ''}」槽${b.k}→${b.n.adj[b.k]}`).join('；');
  if ('nodes' in spec.blocked) {
    return sample(
      'blocked',
      '静态封路节点数（bit 30−k）',
      nodeIds.length === spec.blocked.nodes && emptySlot.length === 0,
      spec.blocked.nodes,
      nodeIds.length,
      desc || '无',
    );
  }
  const edges = blocked.map((b) => `${b.n.id}->${b.n.adj[b.k]}`);
  const want = [...spec.blocked.edges];
  return sample(
    'blocked',
    '静态封路的边（bit 30−k）',
    emptySlot.length === 0 && edges.length === want.length && edges.every((e, i) => e === want[i]),
    want.join('、') || '无',
    edges.join('、') || '无',
    desc || '无',
  );
}

function companySample(raw: MapDataRaw, c: CompanySpec): SampleResult {
  const hit =
    c.companyId !== undefined
      ? raw.companies.find((x) => x.id === c.companyId)
      : companyByName(raw, ...(c.names ?? []));
  const keys = Object.keys(c.fields) as (keyof CompanySpec['fields'])[];
  const pick = (co: RawCompany) => Object.fromEntries(keys.map((k) => [k, co[k]]));
  const expected = keys.length === 1 ? c.fields[keys[0]!] : c.fields;
  const actual = hit ? (keys.length === 1 ? hit[keys[0]!] : pick(hit)) : '未找到';
  const ok = hit !== undefined && keys.every((k) => hit[k] === c.fields[k]);
  const detail = c.companyId !== undefined && hit ? `企业 C${hit.id}「${hit.name.text ?? hit.name.hex}」` : undefined;
  return sample(c.id, `${c.label} ${keys.join('/')}`, ok, expected, actual, detail);
}

function fieldSample(raw: MapDataRaw, f: FieldSpec): SampleResult {
  const rec: RawLand | RawCompany | undefined =
    f.table === 'lands' ? raw.lands.find((x) => x.id === f.recordId) : raw.companies.find((x) => x.id === f.recordId);
  let actual: number | string | undefined;
  if (rec) {
    if (f.field === 'name') actual = rec.name.text ?? rec.name.hex;
    else if (f.field === 'rent') actual = 'rent' in rec ? rec.rent[f.index ?? 0] : undefined;
    else actual = 'landPrice' in rec ? rec.landPrice : undefined;
  }
  const want = f.bySource?.[raw.source.id] ?? f.expected;
  return sample(f.id, f.label, actual === want, want, actual ?? '未找到', f.detail);
}

/**
 * 按图样本（data-pipeline.md §10.1）。只做对照，不修改数据。结果顺序：计数、街道、关押格、封路、禁放物件、
 * Big5、企业、字段样本、rent 20% 启发式（台湾的输出与泛化前逐字节相同）。
 */
export function runMapSamples(raw: MapDataRaw, spec: MapSampleSpec): SampleResult[] {
  const out: SampleResult[] = [];
  const counts = [
    raw.header.nodes.count,
    raw.header.lands.count,
    raw.header.facilities.count,
    raw.header.companies.count,
    raw.header.landscapes.count,
  ];
  out.push(sample('counts', '计数 节点/住宅/设施/企业/景观', eq(counts, spec.counts), [...spec.counts], counts));

  for (const st of spec.streets) out.push(...streetSamples(raw, st));
  if (spec.streetsPending !== undefined) {
    out.push({
      id: 'streets.pending',
      label: '街道价格样本（待原版核对）',
      status: 'warn',
      expected: '原版 v2.06 地产信息抽查',
      actual: '未提供',
      detail: spec.streetsPending,
    });
  }

  out.push(...holdSamples(raw, spec));
  out.push(blockedSample(raw, spec));

  if (spec.noItems) {
    const ids = raw.nodes.filter((n) => (n.flags >>> 31) & 1).map((n) => n.id);
    out.push(
      sample(
        'noItems',
        'bit31 禁放物件节点',
        eq(ids, spec.noItems),
        spec.noItems.length > 0 ? `${spec.noItems.length} 个 [${spec.noItems.join(',')}]` : '0 个',
        ids.length > 0 ? `${ids.length} 个 [${ids.join(',')}]` : '0 个',
      ),
    );
  }

  // Big5
  {
    const all: { tag: string; name: RawName }[] = [
      ...raw.nodes.map((x) => ({ tag: `node#${x.id}`, name: x.name })),
      ...raw.lands.map((x) => ({ tag: `land#${x.id}`, name: x.name })),
      ...raw.facilities.map((x) => ({ tag: `fac#${x.id}`, name: x.name })),
      ...raw.companies.map((x) => ({ tag: `com#${x.id}`, name: x.name })),
      ...raw.landscapes.map((x) => ({ tag: `scape#${x.id}`, name: x.name })),
    ];
    const nonEmpty = all.filter((x) => x.name.hex !== '');
    const bad = nonEmpty.filter((x) => x.name.text === null || !x.name.roundtrip);
    out.push(
      sample(
        'big5',
        '非空名称 Big5 严格解码且回编码一致',
        bad.length === 0,
        `${nonEmpty.length}/${nonEmpty.length}`,
        `${nonEmpty.length - bad.length}/${nonEmpty.length}`,
        bad.length > 0 ? bad.map((x) => `${x.tag}(${x.name.hex})`).join(', ') : undefined,
      ),
    );
  }

  for (const c of spec.companies) out.push(companySample(raw, c));
  for (const f of spec.fields ?? []) out.push(fieldSample(raw, f));

  // 启发式：rent[0] = landPrice 的 20%，偏离只告警
  {
    const off = raw.lands.filter((l) => l.rent[0] * 5 !== l.landPrice);
    const streets = uniq(off.map((l) => `${l.name.text ?? l.name.hex}(${l.landPrice}→${l.rent[0]})`));
    out.push({
      id: 'heuristic.rent20',
      label: '住宅 rent[0] = 地价×20%（启发式）',
      status: off.length === 0 ? 'pass' : 'warn',
      expected: '全部满足',
      actual: `${raw.lands.length - off.length}/${raw.lands.length}`,
      ...(off.length > 0 ? { detail: `偏离：${streets.join('、')}` } : {}),
    });
  }
  return out;
}

/** 新图的企业样本：industry / stockIndex / assetValue 三项（按企业号查找）。 */
const co = (
  companyId: number,
  label: string,
  industry: number,
  stockIndex: number,
  assetValue: number,
): CompanySpec => ({ id: `company.C${companyId}`, label, companyId, fields: { industry, stockIndex, assetValue } });

const STREETS_PENDING =
  '这张图没有公开的街道价格出处；请在原版 v2.06 地产信息里抽查 1–2 条最贵的街（地价与各级过路费），或提供 SAVE*.DAT，再填入 MAP_SAMPLES';

/**
 * 各图样本规格。出处：
 * - 台湾：计数 rich4-spec map-format §6.2 / nurockplayer fidelity.md；三组街道 oama toll.test.ts、known-deviations.md；
 *   企业 oama map.ts 注释与 stocks 表；封路 r_rules_map §5。
 * - 大陆 / 日本 / 美国：计数 r_rules_map §11.1 与 g_map.md；企业与股票下标 r_stocks_time §4.2（mytbk rich4_all_stocks.c）
 *   及 exe 股票模板表 0x47ce92；封路、关押格、禁放物件为三来源（MapDat.MKF、v2.06 map.mkf、v3.11 map.mkf）一致的结构；
 *   已知瑕疵与基线差异见 .cache/extract/diff/map<gm>.json（基线 v206-mapdat，与 v3.11 一致）。
 */
export const MAP_SAMPLES: Readonly<Record<string, MapSampleSpec>> = {
  taiwan: {
    key: 'taiwan',
    globalMapId: 0,
    counts: [103, 50, 4, 3, 21],
    streets: [
      {
        id: 'taipei',
        names: ['台北市', '臺北市'],
        count: 4,
        landPrice: 2500,
        rent: [500, 1200, 3000, 7500, 16000, 30000],
      },
      {
        id: 'hsinchu',
        names: ['新竹市'],
        landPrice: 1000,
        rent: [200, 500, 1200, 2800, 6000, 10000],
      },
      {
        id: 'tainan',
        names: ['台南市', '臺南市'],
        count: 4,
        landPrice: 1500,
        housePrice: [500, 300, 300, 300],
        rent: [300, 750, 2000, 4800, 10000, 18000],
      },
    ],
    hold: 'exists',
    blocked: { nodes: 2 },
    companies: [
      { id: 'company.life.asset', label: '台灣人壽', names: ['台灣人壽', '臺灣人壽'], fields: { assetValue: 400000 } },
      { id: 'company.bank', label: '中國信託', names: ['中國信託'], fields: { industry: 7, stockIndex: 0 } },
    ],
  },
  china: {
    key: 'china',
    globalMapId: 1,
    counts: [144, 73, 8, 4, 26],
    streets: [],
    streetsPending: STREETS_PENDING,
    hold: { 8001: 63, 8002: 144 },
    blocked: { edges: ['28->136'] },
    noItems: [],
    companies: [
      co(1, '中國石油', 6, 3, 120000),
      co(2, '中國人壽', 4, 1, 288000),
      co(3, '上海銀行', 7, 0, 560000),
      co(4, '王井府百貨', 10, 2, 160000),
    ],
    fields: [
      {
        id: 'flaw.C4.name',
        label: 'C4 企业名（原版笔误，股票表为「王府井百貨」）',
        table: 'companies',
        recordId: 4,
        field: 'name',
        expected: '王井府百貨',
        bySource: { 'v206-mapmkf': '玉井府百貨' },
        detail: 'MapDat.MKF 与 v3.11 为「王井府百貨」，v2.06 map.mkf 为「玉井府百貨」；基线取 v206-mapdat，不修正',
      },
    ],
  },
  japan: {
    key: 'japan',
    globalMapId: 2,
    counts: [110, 49, 5, 6, 16],
    streets: [],
    streetsPending: STREETS_PENDING,
    hold: { 8001: 55, 8002: 84 },
    blocked: { edges: ['78->79'] },
    noItems: [23, 24, 25, 26, 27, 28, 29],
    companies: [
      co(1, '三越百貨', 10, 2, 176000),
      co(2, '豐田汽車', 5, 5, 270000),
      co(3, '日產建設', 11, 3, 244000),
      co(4, '三井生命', 4, 1, 790000),
      co(5, 'ＳＥＧＡ', 3, 4, 2400000),
      co(6, '富士銀行', 7, 0, 1000000),
    ],
    fields: [
      {
        id: 'flaw.L6.landPrice',
        label: '仙台 L6 地价（原版瑕疵，同街 L4、L5 为 800）',
        table: 'lands',
        recordId: 6,
        field: 'landPrice',
        expected: 500,
        detail: '三个来源一致，照原样保留',
      },
      {
        id: 'flaw.L17.rent1',
        label: '名古屋 L17 rent[1]（VERIFY V-M1）',
        table: 'lands',
        recordId: 17,
        field: 'rent',
        index: 1,
        expected: 750,
        bySource: { 'v206-mapmkf': 7500 },
        detail: 'MapDat.MKF 与 v3.11 为 750（同街 L16、L18 也是 750），v2.06 map.mkf 为 7500；基线取 v206-mapdat',
      },
    ],
  },
  usa: {
    key: 'usa',
    globalMapId: 3,
    counts: [118, 55, 8, 6, 16],
    streets: [],
    streetsPending: STREETS_PENDING,
    hold: { 8001: 85, 8002: 118 },
    blocked: { edges: [] },
    noItems: [],
    companies: [
      co(1, '福特汽車', 5, 4, 120000),
      co(2, '聯合航空', 1, 3, 244000),
      co(3, '喬治亞人壽', 4, 1, 440000),
      co(4, 'ＩＢＭ', 3, 5, 4000000),
      co(5, '環球百貨', 10, 2, 160000),
      co(6, '花旗銀行', 7, 0, 1000000),
    ],
  },
};

/** 按 globalMapId 取样本规格；没有规格时返回 undefined。 */
export function samplesSpecFor(gm: number): MapSampleSpec | undefined {
  return Object.values(MAP_SAMPLES).find((s) => s.globalMapId === gm);
}

/** 台湾样本（保留旧入口，等价于 runMapSamples(raw, MAP_SAMPLES.taiwan)）。 */
export function runTaiwanSamples(raw: MapDataRaw): SampleResult[] {
  return runMapSamples(raw, MAP_SAMPLES.taiwan!);
}

export function samplesFailed(results: readonly SampleResult[]): boolean {
  return results.some((r) => r.status === 'fail');
}
