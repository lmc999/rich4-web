/**
 * 设施费与企业收费（design/engine.md §8；docs/research/g_map.md §4.2–§4.3 已裁决的公式）。
 *
 * 设施（地主是座位；免收规则同住宅：查封、同盟、地主死神 / 住旅馆 / 消失 / 坐牢 / 住院 / 冬眠 / 梦游）：
 *   旅馆     转盘天数 n × rate[等级] × PI（涨价 ×2），并住宿 n 天
 *   购物中心 转盘倍数 m × rate[等级] × PI（涨价 ×2）
 *   加油站   500 × k × 步数 × PI（k：机车 1、汽车 2、工程车 4；步行免费）
 *   公园、研究所不收费；设施收费不做同盟分账
 * 企业（钱进公司的本月与累积盈余；没有董事长不收费；董事长本人停留走董事长分支；关押中的董事长照收）：
 *   航空 1   转盘 n × 收费基数 × PI，并消失 n 天（n=0「不用出國！」不收费）
 *   电子 3   收费基数 × 已过天数（不乘 PI）
 *   保险 4   转盘天数 d × 收费基数 × PI，并投保 d 天（董事长免费投保）
 *   汽车 5 / 石油 6   收费基数 × k × 步数 × PI（步行免费）
 *   建设 11  选自己一块地加盖：工程费 = 该地地价 × PI（找不到目标 1000 × PI）；董事长免费加 2 级
 *   门派 12  收费基数 × 步数 × PI
 *   饭店、银行、百货等不收费
 * 付款方身上的神对合并后的总额生效（设施和企业收费也算）：小财神 ÷2、大财神 0、小穷神 ×1.5、大穷神 ×2。
 */
import { ECON } from '../../data/tables/economy';
import { industryFee, VEHICLE_FEE_FACTOR } from '../../data/tables/facilities';
import { mul32 } from '../../util/int32';
import type { EngineMap } from '../core/mapCache';
import type { TollExemptReason, TollMod } from '../types/frames';
import type { SeatIndex, Vehicle } from '../types/ids';
import type { FacilityState } from '../types/state';
import { applyPayerGod, tollExemption } from './toll';
import { findPlayer, modeOf, playerOf, type RulePlayer, type RuleWorld } from './world';

export type FacilityFeeKind = 'hotel' | 'mall' | 'gas';

export function facilityFeeKind(f: Pick<FacilityState, 'type' | 'level'>): FacilityFeeKind | null {
  if (f.level <= 0) return null;
  switch (f.type) {
    case 'hotel':
      return 'hotel';
    case 'mall':
      return 'mall';
    case 'gas':
      return 'gas';
    default:
      return null;
  }
}

/** 交通工具收费倍率 k（步行 0） */
export function vehicleFactor(v: Vehicle): number {
  return VEHICLE_FEE_FACTOR[v];
}

export type FacilityFeeCheck =
  | { kind: 'none' }
  | { kind: 'exempt'; reason: TollExemptReason }
  | { kind: 'fee'; feeKind: FacilityFeeKind; owner: SeatIndex };

/** 停在别人设施上：是否收费、免收原因（不含转盘） */
export function checkFacilityFee(w: RuleWorld, facIdx: number, payerSeat: SeatIndex): FacilityFeeCheck {
  const f = w.facilities[facIdx]!;
  if (f.owner === null || f.owner === payerSeat) return { kind: 'none' };
  const feeKind = facilityFeeKind(f);
  if (feeKind === null) return { kind: 'none' };
  const payer = playerOf(w.players, payerSeat);
  if (feeKind === 'gas' && vehicleFactor(payer.vehicle) === 0) return { kind: 'none' };
  const owner = findPlayer(w.players, f.owner);
  if (!owner) return { kind: 'none' };
  const exempt = tollExemption(w, payer, owner, f.mark);
  if (exempt) return { kind: 'exempt', reason: exempt };
  return { kind: 'fee', feeKind, owner: f.owner };
}

/**
 * 设施费金额。wheel：旅馆天数 / 购物中心倍数（加油站为 null）；steps：本次掷骰总步数。
 * 返回付款方神明修正后的金额与修正标记。
 */
export function facilityFeeAmount(
  w: RuleWorld,
  em: EngineMap,
  facIdx: number,
  payer: RulePlayer,
  feeKind: FacilityFeeKind,
  wheel: number | null,
  steps: number,
): { amount: number; mods: TollMod[] } {
  const mode = modeOf(w);
  const f = w.facilities[facIdx]!;
  const mods: TollMod[] = ['priceIndex'];
  let amount: number;
  if (feeKind === 'gas') {
    amount = mul32(
      mul32(mul32(ECON.GAS_PER_STEP, vehicleFactor(payer.vehicle), mode), steps, mode),
      w.econ.priceIndex,
      mode,
    );
  } else {
    let rate = em.facilities[facIdx]!.rateWindow[f.level];
    if (f.mark?.kind === 'raise') {
      rate = mul32(rate, 2, mode);
      mods.push('raise');
    }
    amount = mul32(mul32(rate, w.econ.priceIndex, mode), wheel ?? 1, mode);
  }
  return { amount: applyPayerGod(w, payer, amount, mods), mods };
}

export type CompanyFeeKind = ReturnType<typeof industryFee>;

export function companyFeeKind(em: EngineMap, companyIdx: number): CompanyFeeKind {
  return industryFee(em.companies[companyIdx]!.industry);
}

/**
 * 企业收费金额（建设公司另算，见 constructionFee）。wheel：航空 n / 保险 d；steps：本次掷骰总步数。
 * 返回付款方神明修正后的金额；行业不收费或步行免费时 amount 为 0。
 */
export function companyFeeAmount(
  w: RuleWorld,
  em: EngineMap,
  companyIdx: number,
  payer: RulePlayer,
  wheel: number | null,
  steps: number,
): { amount: number; mods: TollMod[] } {
  const mode = modeOf(w);
  const c = em.companies[companyIdx]!;
  const base = c.tollBase;
  const pi = w.econ.priceIndex;
  const mods: TollMod[] = [];
  let amount = 0;
  switch (industryFee(c.industry)) {
    case 'airline':
    case 'insurance':
      amount = mul32(mul32(wheel ?? 0, base, mode), pi, mode);
      mods.push('priceIndex');
      break;
    case 'electronics':
      amount = mul32(base, w.clock.elapsedDays, mode);
      break;
    case 'vehicle':
      amount = mul32(mul32(mul32(base, vehicleFactor(payer.vehicle), mode), steps, mode), pi, mode);
      mods.push('priceIndex');
      break;
    case 'sect':
      amount = mul32(mul32(base, steps, mode), pi, mode);
      mods.push('priceIndex');
      break;
    default:
      return { amount: 0, mods };
  }
  return { amount: applyPayerGod(w, payer, amount, mods), mods };
}

/** 建设公司工程费：目标地价 × PI；没有目标时 1000 × PI（再按付款方神明修正） */
export function constructionFee(w: RuleWorld, payer: RulePlayer, landPrice: number | null): number {
  const mode = modeOf(w);
  const base = landPrice ?? ECON.CONSTRUCTION_NO_TARGET_FEE;
  return applyPayerGod(w, payer, mul32(base, w.econ.priceIndex, mode), []);
}
