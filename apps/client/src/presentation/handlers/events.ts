// 事件格演出（design/client.md §4.5、§5.4）：新闻（NewsPopup：主播 + 打字机标题 + 受影响玩家）、命运（FatePopup 卡片翻面）、
// 魔法屋（女巫挥杖 + 魔法阵 + 结果条）、四大恶人（雇用、作案、回家）、乞丐施舍。
// 新闻、命运文案按编号取自 i18n（news / fate，自拟概括扩写，不照抄原版）；插值参数与命运的金额含义见 ../eventText。
import { NEWS_TABLE } from '@rich4/shared/data';
import type { SeatIndex, VillainKind } from '@rich4/shared/engine';
import type { FatePopupSpec, MagicPopupSpec, NewsPopupSpec, PlayerRef } from '../../ui/popups/popupStore';
import {
  fateShown,
  fateTitle,
  magicEffectName,
  newsBody,
  newsCategory,
  newsHeadline,
  villainActionText,
} from '../eventText';
import { formatEvent } from '../logFormat';
import type { EventHandler, PresentationContext } from '../types';
import { showAllDeltas, syncFromPost } from './common';
import { affectedRows, playerRef, showPopup } from './popups';
import { stageOf } from './stage';
import { blessingText } from './status';

/** 新闻分类（exe newsCategories；0 奇闻、1 政府公告、2 社会、3 路况、4 气象、5 财经），取自 shared 新闻表 */
export const NEWS_CATEGORY: readonly number[] = NEWS_TABLE.map((d) => d.category);

export { newsCategory };

export const NEWS_POPUP_MS = 3400;
export const FATE_POPUP_MS = 2250;
export const MAGIC_COND_POPUP_MS = 1500;
export const MAGIC_CAST_POPUP_MS = 1650;

export const NEWS: EventHandler<'NEWS'> = async (e, ctx) => {
  const category = newsCategory(e.id);
  const spec: NewsPopupSpec = {
    kind: 'news',
    id: e.id,
    category,
    categoryLabel: ctx.t(`news:category.${category}`),
    headline: newsHeadline(ctx.names, e.id, e.params),
    body: newsBody(ctx.names, e.id, e.params),
    affected: affectedRows(ctx, e, e.affected),
  };
  await showPopup(ctx, spec, NEWS_POPUP_MS, 1500);
  syncFromPost(ctx, e.post);
  showAllDeltas(ctx, e);
  await ctx.wait(200);
};

export const FATE: EventHandler<'FATE'> = async (e, ctx) => {
  const stage = stageOf(ctx);
  const player = playerRef(ctx, e.seat);
  stage.bubble({ seat: e.seat }, '？', 600);
  const shown = fateShown(ctx.names, e);
  if (player) {
    const spec: FatePopupSpec = {
      kind: 'fate',
      player,
      id: e.id,
      title: fateTitle(ctx.names, e.id),
      text: ctx.t(`fate:${e.id}.text`, { ...shown.params, defaultValue: '' }),
      amountText: shown.amountText,
      amountTone: shown.amountTone,
      tone: shown.tone,
      blessingText:
        e.blessing === null || shown.category === null ? null : blessingText(ctx, shown.category, e.blessing),
    };
    ctx.board.setActorPose(e.seat, shown.tone === 'good' ? 'cheer' : shown.tone === 'bad' ? 'sad' : 'idle');
    await showPopup(ctx, spec, FATE_POPUP_MS, 1100);
  } else {
    await ctx.wait(FATE_POPUP_MS);
  }
  ctx.board.setActorPose(e.seat, 'idle');
  syncFromPost(ctx, e.post);
  showAllDeltas(ctx, e);
  await ctx.wait(200);
};

function refs(ctx: PresentationContext, seats: readonly SeatIndex[]): PlayerRef[] {
  return seats.map((s) => playerRef(ctx, s)).filter((x): x is PlayerRef => x !== null);
}

export const MAGIC_CONDITION: EventHandler<'MAGIC_CONDITION'> = async (e, ctx) => {
  const stage = stageOf(ctx);
  const caster = playerRef(ctx, e.caster);
  const cond = ctx.t(`magic:condition.${e.cond}`);
  const run = stage.magic(e.caster, e.targets, ctx.signal);
  if (caster) {
    const spec: MagicPopupSpec = {
      kind: 'magic',
      caster,
      title: ctx.t('magic:title'),
      line: ctx.t(e.targets.length > 0 ? 'magic:conditionLine' : 'magic:conditionNobody', { cond }),
      targets: refs(ctx, e.targets),
    };
    await Promise.all([showPopup(ctx, spec, MAGIC_COND_POPUP_MS, 900), run]);
  } else {
    await Promise.all([ctx.wait(MAGIC_COND_POPUP_MS), run]);
  }
  await ctx.wait(100);
};

export const MAGIC_CAST: EventHandler<'MAGIC_CAST'> = async (e, ctx) => {
  const stage = stageOf(ctx);
  const caster = playerRef(ctx, e.caster);
  const effect = magicEffectName(ctx.names, e.effect);
  const desc = ctx.t(`magic:effect.${e.effect}.desc`);
  for (const s of e.targets) stage.burst({ seat: s }, 0x9b6bff, 14);
  void stage.pillar({ seat: e.caster }, 0x9b6bff, ctx.signal);
  if (caster) {
    const spec: MagicPopupSpec = {
      kind: 'magic',
      caster,
      title: ctx.t('magic:castTitle', { effect }),
      line: desc,
      targets: refs(ctx, e.targets),
    };
    await showPopup(ctx, spec, MAGIC_CAST_POPUP_MS, 900);
  } else {
    await ctx.wait(MAGIC_CAST_POPUP_MS);
  }
  syncFromPost(ctx, e.post);
  showAllDeltas(ctx, e);
  await ctx.wait(200);
};

// ───────────────────────── 四大恶人与乞丐 ─────────────────────────

export const VILLAIN_HIRED: EventHandler<'VILLAIN_HIRED'> = async (e, ctx) => {
  const stage = stageOf(ctx);
  const villain = ctx.names.villain(e.kind);
  ctx.ui.toast(ctx.t('events:villainHired', { who: ctx.names.seat(e.by), villain }));
  stage.bubble({ seat: e.by }, ctx.t('events:show.villain', { villain }), 800);
  showAllDeltas(ctx, e);
  syncFromPost(ctx, e.post);
  await ctx.wait(700);
};

const VILLAIN_COLOR: Readonly<Record<VillainKind, number>> = {
  thief: 0x3e4450,
  robber: 0xc0392b,
  thug: 0x2a2a2a,
  spy: 0xc8a870,
};

export const VILLAIN_ACTION: EventHandler<'VILLAIN_ACTION'> = async (e, ctx) => {
  const stage = stageOf(ctx);
  const villain = ctx.names.villain(e.kind);
  ctx.ui.toast(villainActionText(ctx.names, e), 'warn');
  const from = stage.villainAnchor(e.kind);
  if (e.victim !== null) {
    await ctx.board.focus({ seat: e.victim }, 250, ctx.signal);
    ctx.board.setActorPose(e.victim, 'hurt');
    if (from) await stage.beam(from, { seat: e.victim }, VILLAIN_COLOR[e.kind], ctx.signal);
    if (e.employer !== null && e.amount > 0) {
      void ctx.board.coinFlight({ seat: e.victim }, { seat: e.employer }, ctx.signal).catch(() => {});
    }
  } else if (from) {
    stage.bubble(from, villain, 700);
  }
  showAllDeltas(ctx, e);
  syncFromPost(ctx, e.post);
  await ctx.wait(700);
  if (e.victim !== null) ctx.board.setActorPose(e.victim, 'idle');
};

export const VILLAIN_HOME: EventHandler<'VILLAIN_HOME'> = async (e, ctx) => {
  const line = formatEvent(e, ctx.names);
  if (line) ctx.ui.toast(line);
  const at = stageOf(ctx).villainAnchor(e.kind);
  if (at) stageOf(ctx).burst(at, 0xffffff, 8);
  await ctx.wait(400);
};

export const BEGGAR_ALMS: EventHandler<'BEGGAR_ALMS'> = async (e, ctx) => {
  const stage = stageOf(ctx);
  const line = formatEvent(e, ctx.names);
  if (line) ctx.ui.toast(line);
  const b = ctx.view().beggars.find((x) => x.seat === e.beggar);
  if (b) await ctx.board.coinFlight({ seat: e.payer }, { tile: b.node }, ctx.signal);
  showAllDeltas(ctx, e);
  await stage.beggarMove(e.beggar, e.newNode, ctx.signal);
  syncFromPost(ctx, e.post);
};
