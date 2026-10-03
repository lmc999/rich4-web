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

/** 前瞻 / 后瞻最多几格（原版输出缓冲 0x48b8b4 是 8 个 u16，n > 8 截成 8；@source exe v3.11 0x40b360） */
const LOOK_MAX = 8;

/**
 * 原版视角 0 的亚格投影矩阵 [a, b, c, d]：屏幕行 sy ∝ −(b·x + d·y)、列 sx ∝ −(a·x + c·y)。与逐格表 0x46ccf0 视角 0 的
 * 每格增量一致（沿世界 x 一格 (sy, sx) += (−11, +34)，沿 y 一格 += (+25, +14)），只差逐格表里的舍入。AI 固定用视角 0（DEV-03）。
 * @source exe v3.11 0x474910（v2.06 0x4727bc，两版相同；VERIFY V-E10）
 */
const VIEW0 = { a: -34, b: 11, c: -14, d: -25 } as const;

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
   * 视野内的格，按原版候选表的屏幕行序：0x409ef9 把视野内各格按投影后的像素位置写进 440×440 缓冲（下标 = sy × 440 + sx），
   * 再逐行、行内从左到右扫出来。这里用视角 0 的线性投影排序（先 sy 后 sx，同一位置按 id），视野本身仍是世界坐标方窗（DEV-04）。
   * 注意世界坐标的同一行在视角 0 里是右高左低：同一条横街上 x 大的格先扫到（lotsInView 仍按世界坐标先 y 后 x，未改）。
   * @source exe v3.11 0x409ef9（0x40a028–0x40a046 写缓冲，0x40a05c–0x40a09e 逐行扫出）
   */
  tilesInView(tiles: readonly TileId[]): TileId[] {
    const key = (t: TileId): { sy: number; sx: number } => {
      const w = this.tileWorld(t);
      return { sy: -(VIEW0.b * w.x + VIEW0.d * w.y), sx: -(VIEW0.a * w.x + VIEW0.c * w.y) };
    };
    return tiles
      .filter((t) => this.tileInView(t))
      .sort((a, b) => {
        const ka = key(a);
        const kb = key(b);
        return ka.sy - kb.sy || ka.sx - kb.sx || a - b;
      });
  }

  /**
   * 原版口径的来路：被关押时原版把来路写成 0、获释后不改（@source exe v3.11 0x43d630 / 0x43ecdc，v2.06 0x43c35b / 0x43d9e8），
   * 我们写成关押格本身（来路 = 节点，flow/confine.ts、flow/turn.ts release）；这里换回 0（原版的全 0 哨兵节点）。
   */
  private origPrev(): TileId {
    const me = this.me;
    return me.prevNode === me.node ? 0 : me.prevNode;
  }

  /**
   * 原版前瞻 / 后瞻的共用循环（v3.11 0x40b221 与 0x40b343 只有开头读节点 / 来路的两条指令互换，即起点与排除格对调）：最多 LOOK_MAX 格；
   * 每一步取 at 的邻格、去掉空槽、排除格 excl 与静态封路（forwardCandidates）：0 个候选回落为 excl（原路返回），
   * 1 个候选直接走、不取随机数，≥2 个候选取一次 rng.mod(n) 并记下遇到过岔路；然后 excl = at、at = 下一格，输出 at。
   * at 为 0 时是原版的全 0 哨兵节点（没有邻接，0 个候选）。
   * @source exe v3.11 0x40b397–0x40b450（v2.06 只有前瞻 0x40ae1d，同一段循环）
   */
  private walk(at: TileId, excl: TileId, n: number, rng: AiRng): { nodes: TileId[]; forked: boolean } {
    const nodes: TileId[] = [];
    let forked = false;
    const steps = Math.min(n, LOOK_MAX);
    for (let i = 0; i < steps; i++) {
      const cands = at === 0 ? [] : this.map.forwardCandidates(at, excl);
      let next: TileId;
      if (cands.length === 0) next = excl;
      else if (cands.length === 1) next = cands[0]!;
      else {
        forked = true;
        next = cands[rng.mod(cands.length)]!;
      }
      excl = at;
      at = next;
      nodes.push(at);
    }
    return { nodes, forked };
  }

  /**
   * 沿来路方向往回看 n 格（v3.11 0x40b343）：从来路格出发、排除当前格逐格外推，输出不含来路格本身——
   * 第一格是往回第 2 格（来路格再往后一格），n = 6 时是往回第 2–7 格。来路格是死路（0 个候选）时第一格回落为当前格。
   * 获释后（原版来路 0，我们来路 = 节点 = 关押格）从全 0 哨兵出发：第一格回落为关押格，之后排除 0 即全部未封邻格，
   * 得到 [关押格, 邻格…]。调用方（路障阶段二、地雷、定时炸弹）只拿它与候选格比对，见 ai/items.ts behindCands。
   * v2.06 没有这个函数：同三处调用方用的是前瞻 0x40ae1d(6)，并且是「候选不在前方 6 格里」的排除语义（architecture §31）。
   * @source exe v3.11 0x40b343（0x40b376 起点 = 来路 0x496b76、0x40b381 排除 = 节点 0x496b74）
   */
  lookbehind(n: number, rng: AiRng): { nodes: TileId[]; forked: boolean } {
    const me = this.me;
    if (!me.placed || me.node === 0) return { nodes: [], forked: false };
    return this.walk(this.origPrev(), me.node, n, rng);
  }

  /**
   * 沿前进方向看 n 格（不回头；岔路用 AI 的 rng 挑一条并记下遇到过岔路；无路可走原路返回）
   * @source exe v3.11 0x40b221（起点 = 节点 0x496b74、排除 = 来路 0x496b76）；v2.06 0x40ae1d
   */
  lookahead(n: number, rng: AiRng): { nodes: TileId[]; forked: boolean } {
    const me = this.me;
    if (!me.placed || me.node === 0) return { nodes: [], forked: false };
    return this.walk(me.node, this.origPrev(), n, rng);
  }
}
