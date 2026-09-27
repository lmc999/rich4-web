/**
 * AiView：对公平视图（projectState 的 GameView）的只读封装（design/minigames-ai.md §9.2、§9.9）。
 * 只读公开信息与本座位的决策 options；不引用 GameState、不访问 secret。数值规则经 engine/selectors 复用引擎实现。
 */
import type { MapIndex } from '../data/maps/mapIndex';
import type { CompanyDef, FacilityLot, LandLot, TileId, World } from '../data/maps/types';
import { daysUntil, netWorth } from '../engine/selectors/index';
import type { DateNum, FacilityType, LotId, SeatIndex } from '../engine/types/index';
import { inViewWindow, VIEW_WINDOW_HALF } from '../geom/viewWindow';
import type { GameView, PlayerView } from '../view/types';
import { CHAIN_TOLL_BASE } from './constants';
import type { AiRng } from './types';

/** 地产（住宅或设施）的公开状态与静态参数 */
export interface AiLot {
  id: LotId;
  kind: 'land' | 'facility';
  owner: SeatIndex | null;
  level: number;
  chain: boolean;
  type: FacilityType | null;
  landPrice: number;
  housePrice: number;
  /** 住宅的同名路段 id；设施为 null */
  street: string | null;
  world: World;
  /** 当前等级的租金（住宅 rent[level]；设施为 rateWindow[level]） */
  rent: number;
}

export class AiView {
  constructor(
    readonly view: GameView,
    readonly seat: SeatIndex,
    readonly map: MapIndex,
  ) {}

  get me(): PlayerView {
    return this.player(this.seat);
  }

  player(seat: SeatIndex): PlayerView {
    const p = this.view.players.find((x) => x.seat === seat);
    if (!p) throw new RangeError(`no player at seat ${seat}`);
    return p;
  }

  get pi(): number {
    return this.view.econ.priceIndex;
  }

  get initialFund(): number {
    return this.view.econ.initialFund;
  }

  get date(): DateNum {
    return this.view.clock.date;
  }

  get dayOfMonth(): number {
    return this.view.clock.date % 100;
  }

  /** 已经过的月数（按 30 天一个月，至少 1；月均盈余的分母 ⚑） */
  get totalMonths(): number {
    return Math.trunc(this.view.clock.elapsedDays / 30) + 1;
  }

  /** 在场的其他玩家 */
  rivals(): SeatIndex[] {
    return this.view.players.filter((p) => p.alive && p.seat !== this.seat).map((p) => p.seat);
  }

  /** 最恨的人：严格大于当前最大值才替换（first-wins）；全为 0 返回 -1（@0x40d2d3） */
  mostHated(): SeatIndex | -1 {
    let best: SeatIndex | -1 = -1;
    let max = 0;
    for (const s of this.rivals()) {
      const h = this.me.hostility[s] ?? 0;
      if (h > max) {
        max = h;
        best = s;
      }
    }
    return best;
  }

  netWorth(seat: SeatIndex = this.seat): number {
    return netWorth(this.view, this.map, seat);
  }

  /** 持仓市值 Σ trunc(持股 × 股价分 / 100) */
  holdingsValue(seat: SeatIndex = this.seat): number {
    const p = this.player(seat);
    let v = 0;
    this.view.stocks.forEach((st, i) => {
      const n = p.holdings[i]?.shares ?? 0;
      if (n > 0) v += Math.trunc((n * st.priceCents) / 100);
    });
    return v;
  }

  /** 到 date 还有几天；date 为 0 时返回 null */
  daysUntil(date: DateNum): number | null {
    return daysUntil(this.view, date);
  }

  /** 股票对应的实体公司（没有返回 null） */
  companyOfStock(idx: number): CompanyDef | null {
    if (!this.map.def.stocks[idx]?.hasCompany) return null;
    return this.map.def.companies.find((c) => c.stockIndex === idx) ?? null;
  }

  /** 地块的地主（住宅、设施）；企业与非地产返回 undefined */
  ownerOfLot(lot: LotId): SeatIndex | null | undefined {
    if (lot.startsWith('L')) return this.view.lands.find((l) => l.id === lot)?.owner;
    if (lot.startsWith('F')) return this.view.facilities.find((f) => f.id === lot)?.owner;
    return undefined;
  }

  // ───────────────────────── 棋盘与视野（M6，design/minigames-ai.md §8.2） ─────────────────────────

  tileWorld(tile: TileId): World {
    return this.map.tile(tile).world;
  }

  /** 在棋盘上：在场、已落地、没有主阻碍（坐牢、住院、住旅馆、消失） */
  onBoard(seat: SeatIndex): boolean {
    const p = this.view.players.find((x) => x.seat === seat);
    if (!p?.alive || !p.placed) return false;
    return p.st.hotel === 0 && p.st.away === 0 && p.st.jail === 0 && p.st.hospital === 0;
  }

  /** 视野中心：自己所在格（未落地时 null） */
  get center(): World | null {
    const me = this.me;
    return me.placed && me.node > 0 ? this.tileWorld(me.node) : null;
  }

  /** 以自己为中心、440×440 的方窗（AI 视野固定用世界坐标方窗，DEV-03 / DEV-04） */
  inView(w: World): boolean {
    const c = this.center;
    return c !== null && inViewWindow(c, w, VIEW_WINDOW_HALF);
  }

  tileInView(tile: TileId): boolean {
    return tile > 0 && this.inView(this.tileWorld(tile));
  }

  /** 视野内棋盘上的对手（按座位） */
  visibleRivals(): SeatIndex[] {
    return this.rivals().filter((s) => this.onBoard(s) && this.tileInView(this.player(s).node));
  }

  /** 地产（住宅或设施）；企业与不存在的返回 null */
  lot(id: LotId): AiLot | null {
    if (id.startsWith('L')) {
      const st = this.view.lands.find((l) => l.id === id);
      const def = this.map.lot(id) as LandLot;
      if (!st) return null;
      return {
        id,
        kind: 'land',
        owner: st.owner,
        level: st.level,
        chain: st.chain,
        type: null,
        landPrice: st.landPrice,
        housePrice: def.housePrice,
        street: def.streetId,
        world: def.world,
        rent: def.rent[st.level],
      };
    }
    if (id.startsWith('F')) {
      const st = this.view.facilities.find((f) => f.id === id);
      const def = this.map.lot(id) as FacilityLot;
      if (!st) return null;
      return {
        id,
        kind: 'facility',
        owner: st.owner,
        level: st.level,
        chain: false,
        type: st.type,
        landPrice: st.landPrice,
        housePrice: def.housePrice,
        street: null,
        world: def.world,
        rent: st.level > 0 ? def.rateWindow[st.level] : 0,
      };
    }
    return null;
  }

  /** 格所属的地产（住宅或设施） */
  lotAt(tile: TileId): AiLot | null {
    const id = this.map.tile(tile).ref?.lot;
    return id === undefined ? null : this.lot(id);
  }

  /** 全部住宅与设施（按地图顺序） */
  allLots(): AiLot[] {
    const out: AiLot[] = [];
    for (const l of this.map.def.lots) {
      const x = this.lot(l.id);
      if (x) out.push(x);
    }
    return out;
  }

  /** 视野内的住宅与设施（按屏幕行序：先 y 后 x，再按 id） */
  lotsInView(): AiLot[] {
    return this.allLots()
      .filter((l) => this.inView(l.world))
      .sort((a, b) => a.world.y - b.world.y || a.world.x - b.world.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** 同名路段的全部住宅 */
  streetLots(street: string): AiLot[] {
    return this.map.streetLots(street).map((id) => this.lot(id)!);
  }

  /**
   * owner 在 lot 所在路段的过路费估计（× PI；连锁店按 2000 × 连锁店数）。设施为当前等级费率 × PI。
   */
  streetToll(lot: AiLot): number {
    if (lot.owner === null) return 0;
    const owner = lot.owner;
    if (lot.kind === 'facility') return lot.rent * this.pi;
    if (lot.chain) return CHAIN_TOLL_BASE * this.allLots().filter((l) => l.chain && l.owner === owner).length * this.pi;
    let sum = 0;
    for (const l of this.streetLots(lot.street!)) if (l.owner === owner && !l.chain) sum += l.rent;
    return sum * this.pi;
  }

  /** 路上的神（未附身）：槽位、种类、格 */
  roadGods(): { slot: number; kind: number; node: TileId }[] {
    const out: { slot: number; kind: number; node: TileId }[] = [];
    for (const g of this.view.gods)
      if (g.where.t === 'road') out.push({ slot: g.slot, kind: g.kind, node: g.where.node });
    return out;
  }

  /** 格上的路面物件（至多 1 个） */
  objectAt(tile: TileId): GameView['objects'][number] | null {
    return this.view.objects.find((o) => o.node === tile) ?? null;
  }

  /** 格上有棋盘上的玩家（seat 以外）或恶人 */
  occupied(tile: TileId, except: SeatIndex | null = null): boolean {
    for (const p of this.view.players) if (p.seat !== except && this.onBoard(p.seat) && p.node === tile) return true;
    return this.view.villains.some((v) => v.onBoard && v.node === tile);
  }

  /**
   * 沿来路方向往回看 n 格（第一步走到来路格，之后与 lookahead 相同）（@0x40b343）
   */
  lookbehind(n: number, rng: AiRng): { nodes: TileId[]; forked: boolean } {
    const me = this.me;
    const nodes: TileId[] = [];
    let forked = false;
    if (!me.placed || me.node === 0 || me.prevNode === 0) return { nodes, forked };
    let prev = me.node;
    let at = me.prevNode;
    nodes.push(at);
    for (let i = 1; i < n; i++) {
      const cands = this.map.forwardCandidates(at, prev);
      let next: TileId;
      if (cands.length === 0) next = prev;
      else if (cands.length === 1) next = cands[0]!;
      else {
        forked = true;
        next = cands[rng.mod(cands.length)]!;
      }
      prev = at;
      at = next;
      nodes.push(at);
    }
    return { nodes, forked };
  }

  /**
   * 沿前进方向看 n 格（不回头；岔路用 AI 的 rng 挑一条并记下遇到过岔路；无路可走原路返回）（@0x40b221）
   */
  lookahead(n: number, rng: AiRng): { nodes: TileId[]; forked: boolean } {
    const me = this.me;
    let at = me.node;
    let prev = me.prevNode;
    const nodes: TileId[] = [];
    let forked = false;
    if (!me.placed || at === 0) return { nodes, forked };
    for (let i = 0; i < n; i++) {
      const cands = this.map.forwardCandidates(at, prev);
      let next: TileId;
      if (cands.length === 0) next = prev;
      else if (cands.length === 1) next = cands[0]!;
      else {
        forked = true;
        next = cands[rng.mod(cands.length)]!;
      }
      prev = at;
      at = next;
      nodes.push(at);
    }
    return { nodes, forked };
  }
}
