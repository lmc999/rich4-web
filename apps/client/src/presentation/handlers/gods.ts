// 神明演出（design/client.md §3.6、§4.5）：路上出现、降临附身（光柱 + 缩小挂到头顶 + GodArrivePopup 台词）、
// 发威（光环爆发 + 老虎机金额滚动）、离身（旋转上升）、显灵（地块光柱）、恶犬咬人 / 被撞开、召来死神。
import { GOD_KEYS, type GodKind, type SeatIndex } from '@rich4/shared/engine';
import { GOD_PALETTES } from '../../game/actors/godPalettes';
import type { GodPopupSpec } from '../../ui/popups/popupStore';
import { formatEvent } from '../logFormat';
import type { EventHandler, PresentationContext } from '../types';
import { showAllDeltas, syncFromPost } from './common';
import { playerRef, showPopup, signedMoney } from './popups';
import { stageOf } from './stage';

/** 不阻塞的演出：中止后的收尾异常不外抛（避免 unhandledrejection） */
const noop = (): void => {};

/** GodArrivePopup 的展示时长：普通台词 / 带老虎机 */
export const GOD_POPUP_MS = 1300;
export const GOD_SLOT_POPUP_MS = 2750;
export const GOD_POWER_POPUP_MS = 1400;

function godSpec(
  ctx: PresentationContext,
  kind: GodKind,
  seat: SeatIndex | null,
  title: string,
  line: string,
  extra: Partial<Pick<GodPopupSpec, 'slot' | 'amountText'>> = {},
): GodPopupSpec {
  return {
    kind: 'god',
    god: kind,
    godName: ctx.names.god(kind),
    player: playerRef(ctx, seat),
    title,
    line,
    good: GOD_PALETTES[kind].good,
    slot: extra.slot ?? null,
    amountText: extra.amountText ?? null,
  };
}

function godLine(ctx: PresentationContext, kind: GodKind, key: string): string {
  return ctx.t(`gods:${GOD_KEYS[kind]}.${key}`, { defaultValue: ctx.names.god(kind) });
}

export const GOD_SPAWNED: EventHandler<'GOD_SPAWNED'> = async (e, ctx) => {
  await stageOf(ctx).godSpawn(e.kind, e.node, ctx.signal);
  await ctx.wait(80);
};

export const GOD_ATTACHED: EventHandler<'GOD_ATTACHED'> = async (e, ctx) => {
  const stage = stageOf(ctx);
  const who = ctx.names.seat(e.seat);
  const god = ctx.names.god(e.kind);
  const spec = godSpec(
    ctx,
    e.kind,
    e.seat,
    ctx.t('events:popup.godArrive', { god, who }),
    godLine(ctx, e.kind, 'arrive'),
  );
  ctx.board.setActorPose(e.seat, GOD_PALETTES[e.kind].good ? 'cheer' : 'sad');
  await Promise.all([showPopup(ctx, spec, GOD_POPUP_MS, 800), stage.godArrive(e.seat, e.kind, ctx.signal)]);
  ctx.board.setActorPose(e.seat, 'idle');
  syncFromPost(ctx, e.post);
  await ctx.wait(100);
};

export const GOD_POWER: EventHandler<'GOD_POWER'> = async (e, ctx) => {
  const stage = stageOf(ctx);
  const mine = e.transfers.filter((t) => t.seat === e.seat).reduce((a, t) => a + t.amount, 0);
  const others = e.transfers.filter((t) => t.seat !== e.seat);
  const spec = godSpec(
    ctx,
    e.kind,
    e.seat,
    ctx.t('events:popup.godPower', { god: ctx.names.god(e.kind) }),
    godLine(ctx, e.kind, 'power'),
    {
      slot: e.slot,
      amountText: e.transfers.length > 0 ? signedMoney(ctx, mine) : null,
    },
  );
  const ms = e.slot === null ? GOD_POWER_POPUP_MS : GOD_SLOT_POPUP_MS;
  const fx = (async () => {
    await stage.godPower(e.seat, e.kind, ctx.signal);
    // 其他人被波及：金币飞向 / 飞离发威者
    for (const t of others) {
      if (t.amount < 0) void ctx.board.coinFlight({ seat: t.seat }, { seat: e.seat }, ctx.signal).catch(noop);
      else if (t.amount > 0) void ctx.board.coinFlight({ seat: e.seat }, { seat: t.seat }, ctx.signal).catch(noop);
    }
  })();
  await Promise.all([showPopup(ctx, spec, ms, 900), fx]);
  syncFromPost(ctx, e.post);
  showAllDeltas(ctx, e);
  await ctx.wait(100);
};

export const GOD_LEFT: EventHandler<'GOD_LEFT'> = async (e, ctx) => {
  const reason = ctx.t(`events:godLeave.${e.reason}`, { defaultValue: '' });
  if (e.seat !== null) {
    ctx.board.floatText({ seat: e.seat }, `${ctx.names.god(e.kind)} ${reason}`.trim(), 'info');
  }
  const line = formatEvent(e, ctx.names);
  if (line) ctx.ui.toast(reason ? `${line}（${reason}）` : line);
  await stageOf(ctx).godLeave(e.seat, e.kind, ctx.signal);
  syncFromPost(ctx, e.post);
  await ctx.wait(100);
};

export const GOD_MANIFEST: EventHandler<'GOD_MANIFEST'> = async (e, ctx) => {
  const stage = stageOf(ctx);
  await ctx.board.focus({ lot: e.lot }, 300, ctx.signal);
  const spec = godSpec(
    ctx,
    e.kind,
    e.seat,
    ctx.t('events:popup.godManifest', { god: ctx.names.god(e.kind), lot: ctx.names.lot(e.lot) }),
    ctx.t(`gods:manifest.${e.effect}`),
  );
  await Promise.all([
    showPopup(ctx, spec, GOD_POPUP_MS, 800),
    stage.manifest(e.kind, { lot: e.lot }, e.effect, ctx.signal),
  ]);
  syncFromPost(ctx, e.post);
  showAllDeltas(ctx, e);
  await ctx.wait(100);
};

export const DOG_BITE: EventHandler<'DOG_BITE'> = async (e, ctx) => {
  const stage = stageOf(ctx);
  const line = formatEvent(e, ctx.names);
  if (line) ctx.ui.toast(line, 'warn');
  stage.bubble({ tile: e.node }, ctx.t('events:bubble.bite'), 800);
  await stage.dogBite(e.seat, e.node, false, ctx.signal);
  ctx.board.setActorPose(e.seat, 'hurt');
  syncFromPost(ctx, e.post);
  showAllDeltas(ctx, e);
  await ctx.wait(500);
  ctx.board.setActorPose(e.seat, 'idle');
};

export const DOG_KNOCKED: EventHandler<'DOG_KNOCKED'> = async (e, ctx) => {
  const stage = stageOf(ctx);
  stage.bubble({ seat: e.seat }, ctx.t('events:bubble.knocked'), 700);
  await stage.dogBite(e.seat, e.node, true, ctx.signal);
  syncFromPost(ctx, e.post);
  await ctx.wait(100);
};

export const DEATH_GOD_SUMMONED: EventHandler<'DEATH_GOD_SUMMONED'> = async (e, ctx) => {
  const stage = stageOf(ctx);
  const spec = godSpec(
    ctx,
    15,
    e.target,
    ctx.t('events:popup.deathSummon', { who: ctx.names.seat(e.by), target: ctx.names.seat(e.target) }),
    ctx.t('gods:death.summon'),
  );
  ctx.board.setActorPose(e.by, 'cast');
  const fx = (async () => {
    await ctx.wait(300);
    await stage.beam({ seat: e.by }, { seat: e.target }, GOD_PALETTES[15].aura, ctx.signal);
    ctx.board.setActorPose(e.target, 'hurt');
    stage.burst({ seat: e.target }, GOD_PALETTES[15].aura, 18);
  })();
  await Promise.all([showPopup(ctx, spec, 1500, 900), fx]);
  ctx.board.setActorPose(e.by, 'idle');
  ctx.board.setActorPose(e.target, 'idle');
  syncFromPost(ctx, e.post);
  await ctx.wait(100);
};
