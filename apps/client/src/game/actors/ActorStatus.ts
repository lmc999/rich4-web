// 角色状态外观（design/client.md §3.6）：冬眠（冰蓝色调 + zzz）、乌龟（龟壳）、梦游（摇晃 + 问号）、
// 身上的定时炸弹（引信数字）、附身神明、交通工具、住院 / 坐牢（离开棋盘，显示在医院 / 监狱窗口气泡里）、
// 出国（不在场）、乞丐（由路面层画乞丐，角色本体隐藏）。statusOf 从显示态推出，纯函数。
import type { GodKind, Vehicle } from '@rich4/shared/engine';
import type { GameView, PlayerView } from '@rich4/shared/view';
import { Container, Graphics } from 'pixi.js';
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

/** 医院 / 监狱窗口气泡：铁窗或红十字的小窗框，内容（头像、天数）由调用方放在 content 里 */
export function confineWindow(where: 'jail' | 'hospital'): { root: Container; content: Container } {
  const root = new Container({ label: `confine:${where}` });
  const frame = new Graphics();
  frame
    .roundRect(-30, -64, 60, 56, 10)
    .fill(where === 'jail' ? 0xd8d2c4 : 0xffffff)
    .stroke({ width: 3, color: INK });
  frame
    .poly([-6, -9, 6, -9, 0, 0], true)
    .fill(where === 'jail' ? 0xd8d2c4 : 0xffffff)
    .stroke({ width: 3, color: INK });
  const content = new Container();
  const bars = new Graphics();
  if (where === 'jail') {
    for (const x of [-16, -6, 4, 14]) bars.rect(x, -60, 3, 44).fill(0x5a5a5a);
  } else {
    bars.rect(14, -60, 6, 16).fill(0xe8453c);
    bars.rect(9, -55, 16, 6).fill(0xe8453c);
  }
  root.addChild(frame, content, bars);
  return { root, content };
}
