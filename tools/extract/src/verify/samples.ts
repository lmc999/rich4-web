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

interface StreetSpec {
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

/**
 * 台湾样本（data-pipeline.md §10.1）。只做对照，不修改数据。
 * 出处：计数 rich4-spec map-format §6.2 / nurockplayer fidelity.md；三组街道 oama toll.test.ts、known-deviations.md；
 * 企业 oama map.ts 注释与 stocks 表；封路 r_rules_map §5。
 */
export function runTaiwanSamples(raw: MapDataRaw): SampleResult[] {
  const out: SampleResult[] = [];
  const counts = [
    raw.header.nodes.count,
    raw.header.lands.count,
    raw.header.facilities.count,
    raw.header.companies.count,
    raw.header.landscapes.count,
  ];
  out.push(
    sample('counts', '计数 节点/住宅/设施/企业/景观', eq(counts, [103, 50, 4, 3, 21]), [103, 50, 4, 3, 21], counts),
  );

  out.push(
    ...streetSamples(raw, {
      id: 'taipei',
      names: ['台北市', '臺北市'],
      count: 4,
      landPrice: 2500,
      rent: [500, 1200, 3000, 7500, 16000, 30000],
    }),
    ...streetSamples(raw, {
      id: 'hsinchu',
      names: ['新竹市'],
      landPrice: 1000,
      rent: [200, 500, 1200, 2800, 6000, 10000],
    }),
    ...streetSamples(raw, {
      id: 'tainan',
      names: ['台南市', '臺南市'],
      count: 4,
      landPrice: 1500,
      housePrice: [500, 300, 300, 300],
      rent: [300, 750, 2000, 4800, 10000, 18000],
    }),
  );

  // 关押格
  for (const [type, label] of [
    [8001, '医院关押格'],
    [8002, '监狱关押格'],
  ] as const) {
    const nodes = raw.nodes.filter((n) => n.type === type);
    const scape = raw.landscapes[type - 8001];
    out.push(
      sample(
        `hold.${type}`,
        `${label} type ${type}`,
        nodes.length > 0,
        '存在',
        nodes.length > 0 ? `节点 ${nodes.map((n) => n.id).join(',')}` : '无',
        `引用景观 ${type - 8000}「${scape?.name.text ?? '?'}」`,
      ),
    );
  }

  // 静态封路 bit(30−k)
  {
    const blocked = raw.nodes.flatMap((n) => blockedSlots(n.flags).map((k) => ({ n, k })));
    const nodeIds = [...new Set(blocked.map((b) => b.n.id))];
    const emptySlot = blocked.filter((b) => b.n.adj[b.k] === 0);
    const desc = blocked.map((b) => `${b.n.id}「${b.n.name.text ?? ''}」槽${b.k}→${b.n.adj[b.k]}`).join('；');
    out.push(
      sample(
        'blocked',
        '静态封路节点数（bit 30−k）',
        nodeIds.length === 2 && emptySlot.length === 0,
        2,
        nodeIds.length,
        desc || '无',
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

  // 企业
  {
    const life = companyByName(raw, '台灣人壽', '臺灣人壽');
    out.push(
      sample(
        'company.life.asset',
        '台灣人壽 assetValue',
        life?.assetValue === 400000,
        400000,
        life ? life.assetValue : '未找到',
      ),
    );
    const bank = companyByName(raw, '中國信託');
    out.push(
      sample(
        'company.bank',
        '中國信託 industry/stockIndex',
        bank?.industry === 7 && bank.stockIndex === 0,
        { industry: 7, stockIndex: 0 },
        bank ? { industry: bank.industry, stockIndex: bank.stockIndex } : '未找到',
      ),
    );
  }

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

export function samplesFailed(results: readonly SampleResult[]): boolean {
  return results.some((r) => r.status === 'fail');
}
