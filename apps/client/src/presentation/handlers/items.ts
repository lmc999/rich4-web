// 道具与路面物件演出（design/client.md §3.6、§4.5）：用道具（施放 + 光束）、交通工具与车毁、路障 / 地雷 / 定时炸弹的
// 放置与移除、机器娃娃清道、身上的定时炸弹（贴上、转移、爆炸）、飞弹 / 核弹、传送、时光机倒带。
import {
  type GameEventOf,
  isQuietVehicleSwitch,
  isVehicleItem,
  type SeatIndex,
  type TeleportSource,
} from '@rich4/shared/engine';
import { FATE_SHOW } from '@rich4/shared/view';
import { formatEvent } from '../logFormat';
import type { Anchor, EventHandler, PresentationContext } from '../types';
import { currentPacing } from './budget';
import { targetAnchor } from './cards';
import { showAllDeltas, syncFromPost } from './common';
import { type ObjectRemoval, stageOf, syncStageTo } from './stage';

const ITEM_BEAM = 0x3d8bfd;

/**
 * 用道具：提示「使用了XX」（原版电脑用道具时先出 1.5 秒「使用%s」消息框 0x446c17，真人没有）、道具名气泡、施放演出、
 * 有目标时光束；道具台词由 soundMap 放。换车道具（机车 / 汽车 / 工程车）原版没有施放：只刷新外观、整屏重画、说道具台词
 * （机车 0x445a40 / 0x445a4e / 0x445a77，汽车、工程车同理），所以这里不画气泡与施放演出，换座驾由随后的 VEHICLE 负责
 * （architecture §34）
 */
export const ITEM_USED: EventHandler<'ITEM_USED'> = async (e, ctx) => {
  const stage = stageOf(ctx);
  const line = formatEvent(e, ctx.names);
  if (line) ctx.ui.toast(line);
  if (isVehicleItem(e.item)) {
    syncFromPost(ctx, e.post);
    showAllDeltas(ctx, e);
    return;
  }
  stage.bubble({ seat: e.seat }, ctx.names.item(e.item), 900);
  await stage.cast(e.seat, ctx.signal);
  const to = targetAnchor(ctx, e.seat, e.target);
  if (to) await stage.beam({ seat: e.seat }, to, ITEM_BEAM, ctx.signal);
  syncFromPost(ctx, e.post);
  showAllDeltas(ctx, e);
  await ctx.wait(200);
};

/**
 * 换座驾：原版各条路径都只调 fcn.0040b425 刷新外观，不出对话框、没有换车音效、不移镜头（architecture §34）——这里同样只把
 * 外观换成 post 里的座驾，不提示、不闪光、不跳，日志照记（EventPlayer 按 logFormat 写）。用道具换车（没有 stowed / via）
 * 原版另外整屏重画一次（0x41cc56(0,0,1) 只走 bit0 → 0x407ebd，不移镜头：机车 0x445a4e、汽车 0x445b06、工程车 0x446629），
 * 再说道具台词（随 ITEM_USED，soundMap）；收起（0x4467b1）同样重画；中梦游卡（0x442fa8）、梦游结束（0x41c1aa）、
 * 工程车到期（0x41c4d3）、魔法屋卖光（0x4446de）只刷新外观。网页版棋盘每帧重画，没有对应的动作
 */
export const VEHICLE: EventHandler<'VEHICLE'> = async (e, ctx) => {
  syncFromPost(ctx, e.post);
  syncStageTo(ctx, e.post);
  await stageOf(ctx).vehicle(e.seat, e.vehicle, ctx.signal);
};

/**
 * 车毁（地雷、炸弹、飞弹、核弹、骑车摔伤）：提示、飘字、车毁演出。命运 10 / 11（via 'fate'，机车被偷 / 汽车撞毁）原版不走
 * 毁车 0x40c7cd：直接写步行、刷新外观、说事件槽台词（soundMap），之后是命运效果后的 0.8 秒停顿（fcn.00450f9a(800)，
 * compact 节奏 0.15 秒）——不提示、不飘字、不播车毁
 */
export const VEHICLE_DESTROYED: EventHandler<'VEHICLE_DESTROYED'> = async (e, ctx) => {
  if (isQuietVehicleSwitch(e)) {
    syncFromPost(ctx, e.post);
    syncStageTo(ctx, e.post);
    await ctx.wait(currentPacing() === 'original' ? FATE_SHOW.original.tailMs : 150);
    return;
  }
  const line = formatEvent(e, ctx.names);
  if (line) ctx.ui.toast(line, 'warn');
  ctx.board.floatText({ seat: e.seat }, ctx.t('events:bubble.wreck'), 'loss');
  await stageOf(ctx).wreck(e.seat, e.vehicle, ctx.signal);
  ctx.board.setActorPose(e.seat, 'idle');
  syncFromPost(ctx, e.post);
  await ctx.wait(150);
};

export const OBJECT_PLACED: EventHandler<'OBJECT_PLACED'> = async (e, ctx) => {
  await stageOf(ctx).dropObject(e.obj, ctx.signal);
  await ctx.wait(80);
};

/** 按起因选移除方式：被踩中 / 拆除卡 / 机器娃娃弹飞，恶人顺走，其余淡出 */
export function removalOf(e: GameEventOf<'OBJECT_REMOVED'>): ObjectRemoval {
  switch (e.cause.k) {
    case 'villain':
      return 'pickup';
    case 'object':
      return e.obj.kind === 'mine' || e.obj.kind === 'bomb' ? 'boom' : 'burst';
    case 'item':
    case 'card':
    case 'dog':
      return 'burst';
    default:
      return e.obj.kind === 'gift' || e.obj.kind === 'chest' ? 'pickup' : 'fade';
  }
}

export const OBJECT_REMOVED: EventHandler<'OBJECT_REMOVED'> = async (e, ctx) => {
  await stageOf(ctx).removeObject(e.obj, removalOf(e), ctx.signal);
};

export const DOLL_WALK: EventHandler<'DOLL_WALK'> = async (e, ctx) => {
  const stage = stageOf(ctx);
  const line = formatEvent(e, ctx.names);
  if (line) ctx.ui.toast(line);
  // 被扫走的神明由随后的 GOD_LEFT 演出离场（这里提前 godLeave 会被事件后的舞台同步加回路面，再离场一次）
  await stage.dollWalk(e.path, e.clearedObjects, ctx.signal);
  await ctx.wait(150);
};

export const BOMB_ATTACHED: EventHandler<'BOMB_ATTACHED'> = async (e, ctx) => {
  const line = formatEvent(e, ctx.names);
  if (line) ctx.ui.toast(line, 'warn');
  ctx.board.setActorPose(e.seat, 'hurt');
  await stageOf(ctx).bombAttach(e.seat, e.fuse, ctx.signal);
  ctx.board.floatText({ seat: e.seat }, `💣 ${e.fuse}`, 'loss');
  ctx.board.setActorPose(e.seat, 'idle');
  await ctx.wait(200);
};

export const BOMB_TRANSFERRED: EventHandler<'BOMB_TRANSFERRED'> = async (e, ctx) => {
  const line = formatEvent(e, ctx.names);
  if (line) ctx.ui.toast(line, 'warn');
  await stageOf(ctx).bombPass(e.from, e.to, e.fuse, ctx.signal);
  ctx.board.floatText({ seat: e.to }, `💣 ${e.fuse}`, 'loss');
  await ctx.wait(200);
};

export const BOMB_EXPLODED: EventHandler<'BOMB_EXPLODED'> = async (e, ctx) => {
  const stage = stageOf(ctx);
  const line = formatEvent(e, ctx.names);
  if (line) ctx.ui.toast(line, 'warn');
  await ctx.board.focus({ tile: e.node }, 300, ctx.signal);
  ctx.board.setActorPose(e.seat, 'hurt');
  stage.flash(0xfff3b0, 260);
  await stage.explode({ tile: e.node }, 'big', ctx.signal);
  syncFromPost(ctx, e.post);
  showAllDeltas(ctx, e);
  await ctx.wait(400);
  ctx.board.setActorPose(e.seat, 'idle');
};

export const STRIKE: EventHandler<'STRIKE'> = async (e, ctx) => {
  const stage = stageOf(ctx);
  ctx.ui.toast(ctx.t(`events:strike.${e.kind}`, { defaultValue: formatEvent(e, ctx.names) ?? '' }), 'warn');
  await ctx.board.focus({ tile: e.center }, 400, ctx.signal);
  for (const a of e.actors) if (a.t === 'seat') ctx.board.setActorPose(a.seat, 'hurt');
  await stage.strike(e.kind, e.center, e.half, ctx.signal);
  syncFromPost(ctx, e.post);
  showAllDeltas(ctx, e);
  for (const a of e.actors) if (a.t === 'seat') ctx.board.setActorPose(a.seat, 'idle');
  await ctx.wait(150);
};

/** 传送源在棋盘上的位置 */
export function sourceAnchor(ctx: PresentationContext, s: TeleportSource): Anchor | null {
  switch (s.k) {
    case 'actor':
      return s.actor.t === 'seat' ? { seat: s.actor.seat } : stageOf(ctx).villainAnchor(s.actor.kind);
    case 'god': {
      const g = ctx.view().gods.find((x) => x.slot === s.slot);
      if (!g) return null;
      return g.where.t === 'road' ? { tile: g.where.node } : g.where.t === 'attached' ? { seat: g.where.seat } : null;
    }
    case 'object': {
      const o = ctx.view().objects.find((x) => x.id === s.object);
      return o ? { tile: o.node } : null;
    }
    case 'house':
      return { lot: s.lot };
  }
}

export const TELEPORTED: EventHandler<'TELEPORTED'> = async (e, ctx) => {
  const line = formatEvent(e, ctx.names);
  if (line) ctx.ui.toast(line);
  const from = sourceAnchor(ctx, e.source);
  const to: Anchor = e.dest.k === 'road' ? { tile: e.dest.node } : { lot: e.dest.lot };
  const moving: SeatIndex | null = e.source.k === 'actor' && e.source.actor.t === 'seat' ? e.source.actor.seat : null;
  await stageOf(ctx).teleport(from ?? to, to, ctx.signal);
  syncFromPost(ctx, e.post);
  if (moving !== null) await ctx.board.hop(moving, ctx.signal);
  await ctx.wait(150);
};

export const TIME_REWOUND: EventHandler<'TIME_REWOUND'> = async (e, ctx) => {
  const line = formatEvent(e, ctx.names);
  ctx.ui.toast(line ?? ctx.t('events:show.timeRewound'), 'warn');
  // 直接用批尾 view reset（EventPlayer 处理）；这里只做一段短暂的倒带画面
  await stageOf(ctx).rewind(ctx.signal);
};
