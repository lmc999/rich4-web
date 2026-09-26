/**
 * 企业格（design/engine.md §8「企业格」；docs/research/g_map.md §4.3；收费公式见 rules/fee.ts）。
 * 停在企业格（落点码 0、ref.lot 为 C）：压 FEE 帧（董事长特权 / 收费 / 出国 / 投保）→ 现场认购。
 * 本文件另提供 SUBSCRIBE_SHARES 与 CONSTRUCTION_PICK 的结算。
 *
 * 认购：单价 = trunc(资产额 / 10000)（不乘 PI）；每次造访最多 1000 股；只用现金，钱销毁、不计入公司盈余。
 * 建设公司：目标 +1 级（董事长免费 + constructionChairmanLevels 级，到上限即止）；非董事长付工程费
 *          = 目标地价 × PI 给公司（可用存款，付不起即破产）；找不到目标收 1000 × PI（ASK 构造时直接收取）。
 */
import type { Ctx } from '../core/ctx';
import { buildConstruction, buildSubscribe, subscribeUnitPrice } from '../decisions/economy';
import { EngineRuleError } from '../errors';
import { payCompany, pushCompanyFee } from '../flow/fee';
import { constructionFee } from '../rules/fee';
import { levelUpLand } from '../rules/landMutation';
import { facilityLevelAfter } from '../rules/purchase';
import { updateChairman } from '../rules/stock';
import type { CompanyLotId, LotId, SeatIndex } from '../types/ids';

export function companySquare(ctx: Ctx, seat: SeatIndex, lot: CompanyLotId, steps: number): void {
  if (ctx.map.companyIdx(lot) < 0) return;
  pushCompanyFee(ctx, seat, lot, steps);
}

/** SUBSCRIBE{shares}：现金认购公司保留股 */
export function subscribeShares(ctx: Ctx, seat: SeatIndex, company: CompanyLotId, shares: number): void {
  const ci = ctx.map.companyIdx(company);
  const o = ci < 0 ? null : buildSubscribe(ctx.s, ctx.map, seat, ci);
  if (o === null) throw new EngineRuleError('NOT_ALLOWED', 'nothing to subscribe');
  if (!Number.isInteger(shares) || shares < 1 || shares > o.max) {
    throw new EngineRuleError('OUT_OF_RANGE', `shares ${shares} not in 1..${o.max}`);
  }
  const unit = subscribeUnitPrice(ctx.map, ci);
  if (!ctx.spendCash(seat, unit * shares)) throw new EngineRuleError('CANNOT_AFFORD');
  const c = ctx.s.companies[ci]!;
  const p = ctx.player(seat);
  const h = p.holdings[c.stock]!;
  p.holdings[c.stock] = { shares: h.shares + shares, costCents: h.costCents + unit * 100 * shares };
  c.reserved -= shares;
  ctx.emit('SUBSCRIBED', { seat, stock: c.stock, shares, unit });
  const ch = updateChairman(ctx.s, c.stock);
  if (ch) ctx.emit('CHAIRMAN_CHANGED', ch);
}

/** PICK_LOT{lot}：建设公司加盖（董事长免费），非董事长随后付工程费 */
export function constructionPick(
  ctx: Ctx,
  seat: SeatIndex,
  company: CompanyLotId,
  chairman: boolean,
  lot: LotId,
): void {
  const o = buildConstruction(ctx.s, ctx.map, seat, company, chairman);
  const row = o?.lots.find((l) => l.lot === lot);
  if (!o || !row) throw new EngineRuleError('INVALID_TARGET', `${lot} cannot be built by the construction company`);
  const cause = { k: 'system' as const, ref: 'construction', by: seat };
  let landPrice: number;
  if (lot.startsWith('L')) {
    const land = ctx.s.lands[ctx.map.landIdx(lot)]!;
    landPrice = land.landPrice;
    const ch = levelUpLand(land, o.levels);
    if (ch.to !== ch.from) ctx.emit('LOT_LEVEL', { lot, from: ch.from, to: ch.to, cause });
  } else {
    const fac = ctx.s.facilities[ctx.map.facilityIdx(lot)]!;
    landPrice = fac.landPrice;
    const from = fac.level;
    fac.level = facilityLevelAfter(from, o.levels, fac.type);
    if (fac.level !== from) ctx.emit('LOT_LEVEL', { lot, from, to: fac.level, cause });
  }
  if (chairman) return;
  const ci = ctx.map.companyIdx(company);
  const industry = ctx.map.companies[ci]!.industry;
  payCompany(ctx, seat, company, industry, constructionFee(ctx.s, ctx.player(seat), landPrice), null);
}
