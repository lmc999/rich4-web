/**
 * 落点码 15：百货公司 → SHOP 帧（董事长赠品 → 货架 → 买卖；design/engine.md §8、flow/shop.ts）。
 * 落点格的 ref.lot 指向百货公司（企业）；没有时取地图上第一家行业 10 公司。
 */
import { INDUSTRY } from '../../data/tables/facilities';
import type { CompanyLotId } from '../types/ids';
import type { SquareHandler } from './index';

export const shopSquare: SquareHandler = (ctx, sq) => {
  const ref = sq.tile.ref?.lot;
  let company: CompanyLotId | null = null;
  if (ref?.startsWith('C') && ctx.map.companyIdx(ref) >= 0) company = ref as CompanyLotId;
  else {
    const c = ctx.map.companies.find((x) => x.industry === INDUSTRY.DEPT);
    if (c) company = c.id as CompanyLotId;
  }
  const p = ctx.player(sq.seat);
  ctx.push({
    k: 'SHOP',
    seat: sq.seat,
    company,
    shelf: [],
    fullDeck: null,
    entryPoints: p.points,
    trades: [],
    stage: 'gift',
  });
};
