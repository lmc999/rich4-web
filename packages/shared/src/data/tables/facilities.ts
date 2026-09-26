/**
 * 设施（大块地）与上市企业的规则表（design/engine.md §8；docs/research/g_map.md §4.2–§4.3、r_property.md §6）。
 * 转盘一律按 12 格（或 6 格）等概率抽下标：rand15() % 格数（purpose 'wheel'）。
 *
 * @source docs/research/g_map.md §4.2（旅馆 / 购物中心 / 加油站，oama 与 nuro 各自读机器码，结论一致）【A】
 * @source docs/research/g_map.md §4.3（航空 / 电子 / 保险 / 汽车 / 石油 / 建设 / 门派）【A】
 * @source docs/research/r_property.md §6.1–§6.2（设施等级上限、研发项目）
 */
import type { Sourced, Src } from '../source';
import type { FacilityType, Vehicle } from './ids';

const G42: Src = { research: 'docs/research/g_map.md §4.2' };
const G43: Src = { research: 'docs/research/g_map.md §4.3' };

export interface WheelDef extends Sourced {
  /** 转盘各格的结果（按格序；rand15() % slots.length 取下标） */
  slots: readonly number[];
}

function wheel(slots: number[], src: Src[], confidence: Sourced['confidence'] = 'high'): WheelDef {
  return Object.freeze({ slots: Object.freeze(slots), src, confidence });
}

/** 旅馆住宿天数：1 天 4/12、2 天 3/12、3 天 2/12、4 天 3/12（期望约 2.33） */
export const HOTEL_WHEEL = wheel([1, 1, 1, 1, 2, 2, 2, 3, 3, 4, 4, 4], [G42]);

/** 购物中心消费倍数：1..6 各 2/12 */
export const MALL_WHEEL = wheel([1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6], [G42]);

/** 航空（行业 1）：出国天数 0 天 2/12、1 天 4/12、2 天 4/12、3 天 2/12；0 天「不用出國！」不收费 */
export const AIRLINE_WHEEL = wheel([0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3], [G43, { exe: '3.11', va: '0x41abcd' }]);

/** 保险（行业 4）：投保天数 5/3/30/20/15/10 各 1/6 */
export const INSURANCE_WHEEL = wheel(
  [5, 3, 30, 20, 15, 10],
  [G43, { research: 'docs/research/r_stocks_time.md §4.7' }],
);

/** 设施等级上限：公园 1、旅馆 5、购物中心 5、加油站 1、研究所 5 */
export const FACILITY_CAPS: Readonly<Record<FacilityType, number>> & Sourced = Object.freeze({
  park: 1,
  hotel: 5,
  mall: 5,
  gas: 1,
  lab: 5,
  src: [{ research: 'docs/research/r_property.md §6.1' }, { verify: 'extract:facilityLevels' }],
  confidence: 'high',
});

/** 交通工具收费倍率 k = 1 << ((trafficMethod & 3) − 1)：步行不收费、机车 1、汽车 2、工程车 4 */
export const VEHICLE_FEE_FACTOR: Readonly<Record<Vehicle, number>> & Sourced = Object.freeze({
  walk: 0,
  moto: 1,
  car: 2,
  engineer: 4,
  src: [G42, G43],
  confidence: 'high',
});

/** 上市企业的行业码（MapDef CompanyDef.industry） */
export const INDUSTRY = Object.freeze({
  AIRLINE: 1,
  HOTEL: 2,
  ELECTRONICS: 3,
  INSURANCE: 4,
  AUTO: 5,
  OIL: 6,
  BANK: 7,
  DEPT: 10,
  CONSTRUCTION: 11,
  SECT: 12,
} as const);

export type IndustryFeeKind =
  | 'airline' // n × 收费基数 × PI，并消失 n 天
  | 'electronics' // 收费基数 × 已过天数（不乘 PI）
  | 'insurance' // d × 收费基数 × PI，并投保 d 天（董事长免费投保）
  | 'vehicle' // 收费基数 × k × 步数 × PI（步行免费）
  | 'construction' // 选自己一块地加盖（董事长免费加 2 级，非董事长付地价 × PI）
  | 'sect' // 收费基数 × 步数 × PI
  | 'none'; // 饭店、银行、百货等在企业分支不收费

export interface IndustryDef extends Sourced {
  industry: number;
  fee: IndustryFeeKind;
}

function ind(industry: number, fee: IndustryFeeKind, confidence: Sourced['confidence'] = 'high'): IndustryDef {
  return Object.freeze({ industry, fee, src: [G43], confidence });
}

/** 行业码 → 收费方式（未列出的行业不收费） */
export const INDUSTRIES: readonly IndustryDef[] = Object.freeze([
  ind(INDUSTRY.AIRLINE, 'airline'),
  ind(INDUSTRY.HOTEL, 'none'),
  ind(INDUSTRY.ELECTRONICS, 'electronics'),
  ind(INDUSTRY.INSURANCE, 'insurance'),
  ind(INDUSTRY.AUTO, 'vehicle'),
  ind(INDUSTRY.OIL, 'vehicle'),
  ind(INDUSTRY.BANK, 'none'),
  ind(INDUSTRY.DEPT, 'none', 'medium'),
  ind(INDUSTRY.CONSTRUCTION, 'construction'),
  ind(INDUSTRY.SECT, 'sect'),
]);

export function industryFee(industry: number): IndustryFeeKind {
  for (const d of INDUSTRIES) if (d.industry === industry) return d.fee;
  return 'none';
}
