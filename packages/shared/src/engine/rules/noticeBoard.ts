/**
 * 公布栏（玩家间二级市场；docs/research/r_property.md §9.3；design/minigames-ai.md §9.4 boardList / boardBuy）。纯函数。
 *
 * - 每人至多 7 个挂牌（BOARD_SLOTS）；可以挂股票（股数）、自己的住宅或设施、手里的卡、背包里的道具（数量）。
 * - 挂牌保留规则：挂牌不冻结资产，资产仍在卖家手里、可以照常使用；同一资产的挂牌合计不能超过持有量（同一块地、
 *   同一张卡不能重复挂）。资产后来不在了（卖掉、用掉、被抢、地产易主）挂牌即失效：回合开始时撤下
 *   （LISTING_REMOVED{invalid}），失效期间不出现在 options 里，也不能成交。卖家出局时他的挂牌全部撤下。
 *   挂牌跨回合保留，直到成交、卖家撤下或失效；不做重新定价（AI 也不做，DEV-11）。
 * - 标价 ≥ 1；地产标价上限 = 市价 × 10，市价 = (地价 + 等级 × 房价) × PI（设施用 rate0）。
 * - 成交：买家（本人回合的 TURN_MENU）用现金付给卖家（现金），资产转给买家：股票（持股、平均成本按成交价）、
 *   地产（地主、地契按开局期限重算；研究所进行中的研发作废）、卡片（满手按 rules.handFull）、道具（买家放得下才能买）。
 */
import { CMB } from '../../data/tables/combat';
import { ECON } from '../../data/tables/economy';
import { add32, mul32 } from '../../util/int32';
import type { EngineMap } from '../core/mapCache';
import type { ListingView } from '../types/decision';
import type { LotId, SeatIndex } from '../types/ids';
import type { GameState, Listing, ListingAsset, PlayerState } from '../types/state';

function playerOf(s: GameState, seat: SeatIndex): PlayerState | null {
  return s.players.find((p) => p.seat === seat) ?? null;
}

function lotOwner(s: GameState, em: EngineMap, lot: LotId): SeatIndex | null | undefined {
  if (lot.startsWith('L')) return s.lands[em.landIdx(lot)]?.owner;
  if (lot.startsWith('F')) return s.facilities[em.facilityIdx(lot)]?.owner;
  return undefined;
}

/** 地产市价 = (地价 + 等级 × 房价) × PI；非住宅 / 设施返回 null */
export function lotMarketValue(s: GameState, em: EngineMap, lot: LotId): number | null {
  const mode = s.config.rules.intOverflow;
  if (lot.startsWith('L')) {
    const i = em.landIdx(lot);
    const l = s.lands[i];
    if (!l) return null;
    return mul32(add32(l.landPrice, mul32(l.level, em.lands[i]!.housePrice, mode), mode), s.econ.priceIndex, mode);
  }
  if (lot.startsWith('F')) {
    const i = em.facilityIdx(lot);
    const f = s.facilities[i];
    if (!f) return null;
    return mul32(
      add32(f.landPrice, mul32(f.level, em.facilities[i]!.rateWindow[0], mode), mode),
      s.econ.priceIndex,
      mode,
    );
  }
  return null;
}

/** 地产挂牌的标价上限（市价 × 10） */
export function lotPriceCap(s: GameState, em: EngineMap, lot: LotId): number | null {
  const v = lotMarketValue(s, em, lot);
  return v === null ? null : mul32(v, CMB.BOARD_LOT_CAP_X, s.config.rules.intOverflow);
}

function sameAsset(a: ListingAsset, b: ListingAsset): boolean {
  if (a.t === 'stock') return b.t === 'stock' && b.stock === a.stock;
  if (a.t === 'item') return b.t === 'item' && b.item === a.item;
  if (a.t === 'card') return b.t === 'card' && b.card === a.card;
  return b.t === 'lot' && b.lot === a.lot;
}

/** 卖家持有的数量（股数、道具件数、卡张数、地块 1） */
function heldAmount(s: GameState, em: EngineMap, p: PlayerState, a: ListingAsset): number {
  switch (a.t) {
    case 'stock':
      return p.holdings[a.stock]?.shares ?? 0;
    case 'item':
      return p.items[a.item] ?? 0;
    case 'card':
      return p.cards.filter((c) => c === a.card).length;
    case 'lot':
      return lotOwner(s, em, a.lot) === p.seat ? 1 : 0;
  }
}

function assetUnits(a: ListingAsset): number {
  return a.t === 'stock' ? a.shares : a.t === 'item' ? a.qty : 1;
}

/**
 * 当前有效的挂牌 id：按挂牌先后（id 升序）逐个认领卖家的持有量，认领得下的有效；
 * 资产不够时先挂的优先（卖家出局的全部无效）。
 */
export function validListingIds(s: GameState, em: EngineMap): Set<number> {
  const ok = new Set<number>();
  const board = s.noticeBoard.slice().sort((a, b) => a.id - b.id);
  for (let i = 0; i < board.length; i++) {
    const l = board[i]!;
    const p = playerOf(s, l.seller);
    const units = assetUnits(l.asset);
    if (!p?.alive || units <= 0) continue;
    let used = 0;
    for (let j = 0; j < i; j++) {
      const e = board[j]!;
      if (e.seller === l.seller && ok.has(e.id) && sameAsset(e.asset, l.asset)) used += assetUnits(e.asset);
    }
    if (used + units <= heldAmount(s, em, p, l.asset)) ok.add(l.id);
  }
  return ok;
}

/** 挂牌仍然有效（见 validListingIds） */
export function listingValid(s: GameState, em: EngineMap, l: Listing): boolean {
  return validListingIds(s, em).has(l.id);
}

/** 卖家还没有挂出（被有效挂牌认领）的数量 */
export function unlistedAmount(
  s: GameState,
  em: EngineMap,
  seat: SeatIndex,
  a: ListingAsset,
  valid: Set<number> = validListingIds(s, em),
): number {
  const p = playerOf(s, seat);
  if (!p) return 0;
  let used = 0;
  for (const l of s.noticeBoard)
    if (l.seller === seat && valid.has(l.id) && sameAsset(l.asset, a)) used += assetUnits(l.asset);
  return heldAmount(s, em, p, a) - used;
}

/** 挂牌的合法性（BOARD_LIST）：返回拒绝原因或 null */
export function checkListing(
  s: GameState,
  em: EngineMap,
  seat: SeatIndex,
  asset: ListingAsset,
  price: number,
): string | null {
  const p = playerOf(s, seat);
  if (!p?.alive) return 'seller is out';
  if (s.noticeBoard.filter((l) => l.seller === seat).length >= CMB.BOARD_SLOTS) return 'board is full';
  if (!Number.isInteger(price) || price < 1) return 'bad price';
  if (asset.t === 'stock' && (asset.stock < 0 || asset.stock >= s.stocks.length)) return 'bad stock';
  if (asset.t === 'lot') {
    const cap = lotPriceCap(s, em, asset.lot);
    if (cap === null) return 'not a land or facility';
    if (price > cap) return `price above cap ${cap}`;
  }
  const units = assetUnits(asset);
  if (units <= 0) return 'nothing to list';
  if (units > unlistedAmount(s, em, seat, asset)) return 'not enough held';
  return null;
}

/** 买家能否接手：卡片总能进手（满手按 handFull 处理）；道具要放得下（每种 ≤ 9） */
export function canReceive(p: PlayerState, a: ListingAsset): boolean {
  if (a.t === 'item') return (p.items[a.item] ?? 0) + a.qty <= ECON.ITEM_MAX;
  return true;
}

/** 可以成交：挂牌有效、不是自己的、买家现金够、放得下 */
export function canBuyListing(s: GameState, em: EngineMap, buyer: SeatIndex, l: Listing): boolean {
  return listingValid(s, em, l) && canBuyValid(s, buyer, l);
}

/** 已知挂牌有效时：不是自己的、买家在场、现金够、放得下 */
function canBuyValid(s: GameState, buyer: SeatIndex, l: Listing): boolean {
  const p = playerOf(s, buyer);
  if (!p?.alive || l.seller === buyer) return false;
  return p.cash >= l.price && canReceive(p, l.asset);
}

/** 本人还能挂的东西（有任何未挂出的资产且有空槽） */
function hasListable(s: GameState, em: EngineMap, p: PlayerState, valid: Set<number>): boolean {
  if (s.noticeBoard.filter((l) => l.seller === p.seat).length >= CMB.BOARD_SLOTS) return false;
  const probes: ListingAsset[] = [];
  p.holdings.forEach((h, i) => {
    if (h.shares > 0) probes.push({ t: 'stock', stock: i, shares: 1 });
  });
  p.items.forEach((n, i) => {
    if (i > 0 && n > 0) probes.push({ t: 'item', item: i as 1, qty: 1 });
  });
  for (const c of p.cards) probes.push({ t: 'card', card: c });
  for (const l of [...s.lands, ...s.facilities]) if (l.owner === p.seat) probes.push({ t: 'lot', lot: l.id });
  return probes.some((a) => unlistedAmount(s, em, p.seat, a, valid) >= 1);
}

/** TURN_MENU 的 board options */
export function boardOptions(
  s: GameState,
  em: EngineMap,
  seat: SeatIndex,
): { listings: ListingView[]; mine: number; canList: boolean; lotCaps: { lot: LotId; cap: number }[] } {
  const p = playerOf(s, seat);
  const valid = validListingIds(s, em);
  const listings: ListingView[] = s.noticeBoard
    .filter((l) => valid.has(l.id))
    .map((l) => ({
      id: l.id,
      seller: l.seller,
      price: l.price,
      asset: structuredCloneAsset(l.asset),
      mine: l.seller === seat,
      affordable: l.seller !== seat && canBuyValid(s, seat, l),
    }));
  const mine = s.noticeBoard.filter((l) => l.seller === seat).length;
  const lotCaps: { lot: LotId; cap: number }[] = [];
  if (p) {
    for (const l of [...s.lands, ...s.facilities]) {
      if (l.owner !== seat) continue;
      if (unlistedAmount(s, em, seat, { t: 'lot', lot: l.id }, valid) < 1) continue;
      const cap = lotPriceCap(s, em, l.id);
      if (cap !== null && cap >= 1) lotCaps.push({ lot: l.id, cap });
    }
  }
  return { listings, mine, canList: p?.alive === true && hasListable(s, em, p, valid), lotCaps };
}

function structuredCloneAsset(a: ListingAsset): ListingAsset {
  return { ...a } as ListingAsset;
}
