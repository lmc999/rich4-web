// 角色状态外观（design/client.md §3.6）：冬眠（冰蓝色调 + zzz）、乌龟（龟壳）、梦游（摇晃 + 问号）、
// 身上的定时炸弹（引信数字）、附身神明、交通工具、住院 / 坐牢 / 住旅馆（人在医院 / 监狱 / 旅馆里，棋盘上不画，见 insideOf）、
// 出国（不在场）、乞丐（由路面层画乞丐，角色本体隐藏）。statusOf 从显示态推出，纯函数。
import type { LotId, MapDef, TileId } from '@rich4/shared/data';
import type { GodKind, Vehicle } from '@rich4/shared/engine';
import type { GameView, PlayerView } from '@rich4/shared/view';
import { Graphics } from 'pixi.js';
import { INK } from '../procedural/building/styles';

export interface ActorStatus {
  god: GodKind | null;
  vehicle: Vehicle;
  hibernate: boolean;
  tortoise: boolean;
  sleepwalk: boolean;
  /** 身上定时炸弹的引信（步数）；没有为 null */
  bomb: number | null;
  /** 坐牢 / 住院及剩余天数（含本回合） */
  confined: { where: 'jail' | 'hospital'; days: number } | null;
  /** 住旅馆 */
  hotel: boolean;
  /** 出国、被绑架：不在棋盘上 */
  away: boolean;
  /** 破产后成了乞丐：本体隐藏，由路面层画乞丐 */
  beggar: boolean;
}

export const NO_STATUS: ActorStatus = Object.freeze({
  god: null,
  vehicle: 'walk',
  hibernate: false,
  tortoise: false,
  sleepwalk: false,
  bomb: null,
  confined: null,
  hotel: false,
  away: false,
  beggar: false,
}) as ActorStatus;

/** 两段式计数器的显示天数（与 HUD、引擎 displayRemaining 一致） */
export function counterDays(raw: number): number {
  return raw === 0 ? 0 : (raw & 0x7f) + 1;
}

export function statusOf(p: PlayerView, view: Pick<GameView, 'beggars'>): ActorStatus {
  const jail = counterDays(p.st.jail);
  const hospital = counterDays(p.st.hospital);
  return {
    god: p.god?.kind ?? null,
    vehicle: p.vehicle,
    hibernate: p.st.hibernate !== 0,
    tortoise: p.st.tortoise !== 0,
    sleepwalk: p.st.sleepwalk !== 0,
    bomb: p.bomb ? p.bomb.fuse : null,
    confined: jail > 0 ? { where: 'jail', days: jail } : hospital > 0 ? { where: 'hospital', days: hospital } : null,
    hotel: p.st.hotel !== 0,
    away: p.st.away !== 0,
    beggar: !p.alive && view.beggars.some((b) => b.seat === p.seat),
  };
}

export function sameStatus(a: ActorStatus, b: ActorStatus): boolean {
  return (
    a.god === b.god &&
    a.vehicle === b.vehicle &&
    a.hibernate === b.hibernate &&
    a.tortoise === b.tortoise &&
    a.sleepwalk === b.sleepwalk &&
    a.bomb === b.bomb &&
    a.away === b.away &&
    a.hotel === b.hotel &&
    a.beggar === b.beggar &&
    a.confined?.where === b.confined?.where &&
    a.confined?.days === b.confined?.days
  );
}

/** 冬眠时身体的冰蓝色调 */
export const ICE_TINT = 0x9fdcff;

/** 龟壳（背在身上，原点在脚底） */
export function tortoiseShell(): Graphics {
  const g = new Graphics();
  g.ellipse(0, -40, 24, 20).fill(0x3f9a4a).stroke({ width: 3, color: INK });
  g.poly([-8, -50, 8, -50, 12, -40, 8, -30, -8, -30, -12, -40], true).fill(0x6cc36f).stroke({ width: 2, color: INK });
  for (const [x, y] of [
    [-18, -44],
    [18, -44],
    [-14, -28],
    [14, -28],
  ] as const) {
    g.circle(x, y, 4).fill(0x6cc36f).stroke({ width: 1.5, color: INK });
  }
  return g;
}

/** 头顶的小炸弹（引信数字另由 numberTag 叠加） */
export function bombIcon(): Graphics {
  const g = new Graphics();
  g.circle(0, 0, 11).fill(0x2a2a2a).stroke({ width: 3, color: INK });
  g.circle(-4, -4, 3).fill(0x8a8f99);
  g.roundRect(-3, -15, 6, 5, 1).fill(0x5a5a5a).stroke({ width: 1.5, color: INK });
  g.moveTo(0, -15).quadraticCurveTo(6, -24, 10, -20).stroke({ width: 2, color: 0x8a5a2b });
  return g;
}

/**
 * 人在建筑里：坐牢 / 住院在监狱 / 医院景观里，住旅馆在旅馆里（门前格的 ref.lot 是旅馆时；死神替人付旅馆费等不在门前的情形
 * 找不到建筑，here = 停在原格、同样不画）。原版被关时把棋子坐标写成景观 / 旅馆坐标，主阻碍计数不为 0 时不画棋子（附身神明与
 * 身上炸弹也不画）。
 * @source exe v2.06 0x43c369–0x43c37d（监狱取景观 2）、0x43d9f6–0x43da0a（医院取景观 1）、fcn.0040d06b（旅馆坐标）；
 *         0x4082a5–0x4082c3（计数 +0x32 不为 0 且没有 +0x15 bit5 就不画）、0x408be6（附身物件同样跳过）
 */
export type Inside = { t: 'landmark'; kind: 'jail' | 'hospital' } | { t: 'lot'; lot: LotId } | { t: 'here' };

/** 状态 → 所在的建筑（没在建筑里为 null）；hotelAt 给出门前格所属的旅馆 */
export function insideOf(s: ActorStatus, node: TileId, hotelAt: (node: TileId) => LotId | null): Inside | null {
  if (s.confined) return { t: 'landmark', kind: s.confined.where };
  if (s.hotel) {
    const lot = node > 0 ? hotelAt(node) : null;
    return lot ? { t: 'lot', lot } : { t: 'here' };
  }
  return null;
}

/** 门前格所属的旅馆（格的 ref.lot 是已盖成旅馆的设施地）；没有为 null */
export function hotelAt(
  node: TileId,
  def: Pick<MapDef, 'tiles'> | null | undefined,
  view: Pick<GameView, 'facilities'>,
): LotId | null {
  const lot = def?.tiles.find((t) => t.id === node)?.ref?.lot;
  if (!lot) return null;
  return view.facilities.some((f) => f.id === lot && f.type === 'hotel') ? lot : null;
}
