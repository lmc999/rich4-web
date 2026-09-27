/**
 * 原版 AI 的用道具判据（design/minigames-ai.md §9.6；入口为 exe 跳表 v311:0x4753a0）。
 * 与卡片相同：只读公平视图与 TURN_MENU 行（row.targets 是合法候选），返回想用的目标或 null，
 * 由 preRoll 用 targetMatches 自检。随机数用 ctx.turnRng('item:<号>')。时光机从不使用。
 */
import { FACILITY_TYPES } from '../data/tables/ids';
import type { ItemId, SeatIndex, TileId, TurnMenuItemRow, UseTarget } from '../engine/types/index';
import { inViewWindow } from '../geom/viewWindow';
import { BAD_GODS } from './cards';
import { MONEY_FLOOR } from './constants';
import type { AiContext } from './types';
import type { AiLot, AiView } from './view';

export type ItemJudge = (v: AiView, row: TurnMenuItemRow, ctx: AiContext) => UseTarget | null;

const NONE: UseTarget = { t: 'none' };
const MISSILE_HALF = 100;
const NUKE_HALF = 220;

function nodeCands(row: TurnMenuItemRow): TileId[] {
  return row.targets.t === 'node' ? row.targets.nodes : [];
}

/** 格上有坏神、恶犬或坏物件（地雷、地面炸弹） */
function badTile(v: AiView, tile: TileId): boolean {
  if (v.roadGods().some((g) => g.node === tile && (g.kind === 11 || BAD_GODS.includes(g.kind)))) return true;
  const o = v.objectAt(tile);
  return o !== null && (o.kind === 'mine' || o.kind === 'bomb');
}

const robotDoll: ItemJudge = (v, _row, ctx) => {
  const ahead = v.lookahead(4, ctx.turnRng('item:1'));
  if (ahead.forked) return null;
  for (const node of ahead.nodes) {
    if (v.roadGods().some((g) => g.node === node && (g.kind === 11 || BAD_GODS.includes(g.kind)))) return NONE;
    const o = v.objectAt(node);
    const l = v.lotAt(node);
    if (!o || !l) continue;
    if (o.kind === 'mine' && l.owner === v.seat) return NONE;
    if (o.kind === 'roadblock' && l.owner !== null && l.owner !== v.seat) {
      if (l.kind === 'facility' || v.streetToll(l) > 3000 * v.pi) return NONE;
    }
  }
  return null;
};

const roadblock: ItemJudge = (v, row, ctx) => {
  const cands = nodeCands(row);
  const me = v.me;
  const money = me.cash + me.deposit > MONEY_FLOOR && me.luck.wealth >= 0 && me.st.tortoise === 0;
  const ahead = v.lookahead(4, ctx.turnRng('item:2'));
  if (!ahead.forked) {
    for (const node of ahead.nodes) {
      if (!cands.includes(node)) continue;
      const l = v.lotAt(node);
      const kind = v.map.tile(node).kind;
      if (l && l.owner === null && money && l.landPrice * v.pi < me.cash) {
        if (l.kind === 'facility') return { t: 'node', node };
        const mine = v.streetLots(l.street!).filter((x) => x.owner === v.seat).length;
        if (mine >= 2 || l.level !== 0) return { t: 'node', node };
      }
      if (kind === 'shop' && me.points > 200) return { t: 'node', node };
      break; // 只看第一个空格
    }
  }
  const behind = v.lookbehind(6, ctx.turnRng('item:2b'));
  let best: { node: TileId; toll: number } | null = null;
  for (const node of behind.nodes) {
    if (!cands.includes(node) || !v.tileInView(node)) continue;
    const l = v.lotAt(node);
    if (l?.kind !== 'land' || l.owner !== v.seat) continue;
    const toll = v.streetToll(l);
    if (toll > 6000 * v.pi && (best === null || toll > best.toll)) best = { node, toll };
  }
  return best === null ? null : { t: 'node', node: best.node };
};

function trapJudge(item: 3 | 4): ItemJudge {
  return (v, row, ctx) => {
    const cands = nodeCands(row);
    const behind = v.lookbehind(6, ctx.turnRng(`item:${item}`));
    const nodes = behind.nodes.filter((n) => cands.includes(n) && v.tileInView(n));
    // 监狱 / 医院门口：里面有人时优先
    const jailed = v.view.players.some((p) => p.alive && p.st.jail !== 0);
    const hospitalized = v.view.players.some((p) => p.alive && p.st.hospital !== 0);
    for (const n of nodes) {
      const kind = v.map.tile(n).kind;
      if ((kind === 'jail' && jailed) || (kind === 'hospital' && hospitalized)) return { t: 'node', node: n };
    }
    const pool =
      item === 3
        ? nodes.filter((n) => {
            const l = v.lotAt(n);
            return l !== null && l.owner !== null && l.owner !== v.seat;
          })
        : nodes;
    if (pool.length === 0) return null;
    return { t: 'node', node: pool[ctx.turnRng(`item:${item}:pick`).mod(pool.length)]! };
  };
}

const motorcycle: ItemJudge = (v, _row, ctx) =>
  v.me.vehicle === 'walk' && ctx.turnRng('item:5').mod(4) === 0 ? NONE : null;

const car: ItemJudge = (v, _row, ctx) =>
  (v.me.vehicle === 'walk' || v.me.vehicle === 'moto') && ctx.turnRng('item:6').mod(4) === 0 ? NONE : null;

/** 以 center 为中心、半宽 half 的方窗里有我或我的地产 */
function hitsMe(v: AiView, center: TileId, half: number): boolean {
  const c = v.tileWorld(center);
  if (v.me.placed && inViewWindow(c, v.tileWorld(v.me.node), half)) return true;
  return v.allLots().some((l) => l.owner === v.seat && inViewWindow(c, l.world, half));
}

/**
 * 飞弹（exe 0x421717，r2 复核）：目标 = 最恨的人；没有最恨的人才从棋盘上的对手里随机抽一人（0x40d31c，不限视野）。
 * 目标必须在视野内——最恨的人不在视野内就放弃，不改打视野内的别人；爆风里有我或我的地产也放弃。
 */
const missile: ItemJudge = (v, _row, ctx) => {
  let target: SeatIndex | -1 = v.mostHated();
  if (target === -1) {
    const pool = v.rivals().filter((s) => v.onBoard(s));
    if (pool.length === 0) return null;
    target = pool[ctx.turnRng('item:7').mod(pool.length)]!;
  }
  if (!v.onBoard(target) || !v.tileInView(v.player(target).node)) return null;
  const node = v.player(target).node;
  return hitsMe(v, node, MISSILE_HALF) ? null : { t: 'node', node };
};

const remoteDice: ItemJudge = (v, row, ctx) => {
  if (row.targets.t !== 'dice') return null;
  const me = v.me;
  const god = me.god?.kind ?? 0;
  if (god === 7 || god === 8 || god === 15 || me.st.tortoise !== 0) return null;
  if (me.cash + me.deposit < MONEY_FLOOR || me.luck.wealth < 0) return null;
  const ahead = v.lookahead(6, ctx.turnRng('item:8'));
  if (ahead.forked) return null;
  let later: { value: number; level: number } | null = null;
  for (let k = 1; k <= ahead.nodes.length; k++) {
    const node = ahead.nodes[k - 1]!;
    if (badTile(v, node) || v.view.villains.some((x) => x.onBoard && x.node === node)) continue;
    const l = v.lotAt(node);
    if (!l) continue;
    if (l.owner === null) {
      if (l.kind === 'land') {
        const mine = v.streetLots(l.street!).filter((x) => x.owner === v.seat).length;
        if (mine >= 2 && 2 * me.cash > 5 * l.landPrice) return { t: 'dice', value: k as 1 };
      } else if (2 * me.cash > 5 * l.landPrice) return { t: 'dice', value: k as 1 };
    } else if (l.owner === v.seat && 2 * me.cash > 5 * l.housePrice) {
      const upgradable =
        l.kind === 'land' ? !l.chain && l.level < 5 : l.type !== 'park' && l.type !== 'gas' && l.level < 5;
      if (upgradable && (later === null || l.level > later.level)) later = { value: k, level: l.level };
    }
  }
  return later === null ? null : { t: 'dice', value: later.value as 1 };
};

const robotWorker: ItemJudge = (v, row, ctx) => {
  if (row.targets.t !== 'lot') return null;
  const needType = row.targets.needType;
  let best: AiLot | null = null;
  for (const l of v.lotsInView()) {
    if (!row.targets.lots.includes(l.id) || l.owner !== v.seat) continue;
    if (best === null || l.rent > best.rent) best = l;
  }
  if (best === null) return null;
  const facility = needType.includes(best.id) ? FACILITY_TYPES[ctx.turnRng('item:9').mod(4) + 1]! : null;
  return { t: 'lot', lot: best.id, facility };
};

const teleporter: ItemJudge = (v, row) => {
  if (row.targets.t !== 'teleport') return null;
  const me = v.me;
  if (me.cash + me.deposit <= MONEY_FLOOR || me.luck.wealth < 0) return null;
  const self = row.targets.sources.find((x) => x.k === 'actor' && x.actor.t === 'seat' && x.actor.seat === v.seat);
  if (!self) return null;
  let best: AiLot | null = null;
  for (const l of v.lotsInView()) {
    if (l.owner !== null || l.level < 3 || l.housePrice * v.pi >= me.cash) continue;
    if (best === null || l.level > best.level) best = l;
  }
  if (best === null) return null;
  const front = v.map
    .lot(best.id)
    .frontTiles.find((t) => row.targets.t === 'teleport' && row.targets.roads.includes(t));
  return front === undefined ? null : { t: 'teleport', source: self, dest: { k: 'road', node: front } };
};

const engineeringVehicle: ItemJudge = (v, _row, ctx) =>
  v.me.vehicle !== 'engineer' && ctx.turnRng('item:12').mod(15) <= ctx.traits.personality ? NONE : null;

/**
 * 核子飞弹（exe 0x421e62，r2 复核；design/minigames-ai.md §9.6 #13）：候选 = 别人的、等级 ≥1 的地产；最多 10 次随机取一个，
 * 以它门前格为中心、半宽 220 的窗内：我的棋子在里面 → 换下一个；否则统计窗内有主地产的块数与等级和（我的 / 别人的），
 * 两个比值都 < 1/(在场人数 + 2) 才发射（原版是 float 比较，这里交叉相乘成整数比较，结果相同）。
 * 窗内有我的地产不直接放弃，只按比例计入。
 */
const nuke: ItemJudge = (v, _row, ctx) => {
  const cands = v.allLots().filter((l) => l.owner !== null && l.owner !== v.seat && l.level > 0);
  if (cands.length === 0) return null;
  const rng = ctx.turnRng('item:13');
  const k = v.view.players.filter((p) => p.alive).length + 2;
  for (let i = 0; i < 10; i++) {
    const l = cands[rng.mod(cands.length)]!;
    const node = v.map.lot(l.id).frontTiles[0];
    if (node === undefined) continue;
    const c = v.tileWorld(node);
    if (v.onBoard(v.seat) && inViewWindow(c, v.tileWorld(v.me.node), NUKE_HALF)) continue;
    let mine = 0;
    let mineLv = 0;
    let other = 0;
    let otherLv = 0;
    for (const x of v.allLots()) {
      if (x.owner === null || !inViewWindow(c, x.world, NUKE_HALF)) continue;
      if (x.owner === v.seat) {
        mine += 1;
        mineLv += x.level;
      } else {
        other += 1;
        otherLv += x.level;
      }
    }
    if (mine * k < other && mineLv * k < otherLv) return { t: 'node', node };
  }
  return null;
};

const never: ItemJudge = () => null;

export const ITEM_AI = Object.freeze({
  1: robotDoll,
  2: roadblock,
  3: trapJudge(3),
  4: trapJudge(4),
  5: motorcycle,
  6: car,
  7: missile,
  8: remoteDice,
  9: robotWorker,
  10: never,
  11: teleporter,
  12: engineeringVehicle,
  13: nuke,
} satisfies { readonly [I in ItemId]: ItemJudge });
