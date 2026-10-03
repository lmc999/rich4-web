// 事件格演出（design/client.md §4.5、§5.4）：新闻（NewsPopup：主播 + 打字机标题 + 受影响玩家；原版皮肤是原版新闻板）、
// 命运（FatePopup 卡片翻面；原版皮肤是原版命运板 + 插图）、魔法屋（女巫挥杖 + 魔法阵 + 结果条）、四大恶人（雇用、作案、
// 回家）、乞丐施舍。新闻、命运文案按编号取自 i18n（news / fate：原版原文，zh-TW 为 exe 格式串、zh-CN 由 opencc 转成）；
// 插值参数与命运的金额含义见 ../eventText。
// 新闻的节拍按房间节奏取 shared/view/pacing 的 newsShowMs（original 照原版新闻板 fcn.0044a173：停到语音播完、不足
// 2.4 秒补足，任意键跳过并停掉语音，之后没有停顿；compact 3.4 秒）。
// 命运的节拍按房间节奏取 shared/view/pacing 的 fateShowMs（original 照原版命运板 fcn.0044c4a0：板子停到语音播完、不足
// 1.6 秒补足 → 效果与加持消息框 1.5 秒 → 停 0.8 秒；compact 沿用 2.25 秒），服务器按同一张表算截止时间；板子之后是
// 重画地图还是留着板子，按各条命运的处理函数（FATE_AFTER_BOARD）。
import { NEWS_TABLE } from '@rich4/shared/data';
import {
  type GameEventOf,
  newsRowAmount,
  type PostPatch,
  type SeatIndex,
  type VillainKind,
} from '@rich4/shared/engine';
import { fateShowMs, newsShowMs } from '@rich4/shared/view';
import {
  type AffectedRow,
  type FatePopupSpec,
  type MagicPopupSpec,
  type NewsPopupSpec,
  opensClassic,
  type PlayerRef,
} from '../../ui/popups/popupStore';
import {
  fateShown,
  fateTitle,
  fateVariantSlot,
  magicEffectName,
  newsCategory,
  newsHeadline,
  newsRowLine,
  villainActionText,
} from '../eventText';
import { formatEvent } from '../logFormat';
import { FATE_FLIP_SFX, NEWS_STING_SFX } from '../soundMap';
import type { EventHandler, PresentationContext } from '../types';
import { currentPacing } from './budget';
import { showAllDeltas, syncFromPost } from './common';
import { affectedRows, playerRef, showPopup } from './popups';
import { stageOf } from './stage';
import { blessingText } from './status';

/** 新闻分类（exe 0x473cd8；0 無責任新聞、1 政府公告、2 社會新聞、3 路況報導、4 氣象報導、5 財經新聞），取自 shared 新闻表 */
export const NEWS_CATEGORY: readonly number[] = NEWS_TABLE.map((d) => d.category);

export { newsCategory };

/** compact 节奏的命运弹窗时长（original 节奏见 shared/view/pacing 的 FATE_SHOW） */
export const FATE_POPUP_MS = 2250;
export const MAGIC_COND_POPUP_MS = 1500;
export const MAGIC_CAST_POPUP_MS = 1650;

/**
 * 命运板停完之后画面怎么变（原版处理函数表 0x473d14 的 49 项，按 slot；参数 1 分支执行效果）：
 * - redraw：一开始就无条件重画地图 fcn.0041cc56(0,0,3)（bit0 → 0x407ebd 整屏重画、bit1 → 0x41562e 地图、0x418a90 翻页），
 *   板子随即消失，之后才判加持、执行效果，0.8 秒停顿（0x44c6af）时屏幕上是地图——金额与状态变化当场可见；
 *   第 10 条（机车被偷）没有加持时先换座驾再重画，同样看作 redraw；
 * - focusLot：第 0、1 条（违建被拆、土地被征收）先 fcn.0041cc56(x,y,2) 把镜头移到被拆 / 被征收的地块（0x44a940 / 0x44aad8，
 *   同样翻页、板子消失），拆除 / 征收与补偿之后另停 0.3 秒（0x44a9b6，第 1 条跳回 0x44a99e 同一段）；
 * - keep：没有加持时不重画（第 2、3、8 条只在有加持时重画再出消息框 0x44abee / 0x44ace7 / 0x44b2a2；第 4 条根本不重画；
 *   第 5 条先逐人送卡、最后才重画 0x44afb0），板子一直留到 0.8 秒停顿结束。
 * 有加持时各条都是重画 → 消息框 1.5 秒 → 再执行效果（高档免付 / 逃过时没有效果）。
 * @source exe v2.06 fcn.0044c4a0、处理函数 0x44a86e–0x44c478（test/evcard-r2.sh 反汇编逐项追参数 1 的路径）
 */
export type FateAfterBoard = 'redraw' | 'focusLot' | 'keep';
export const FATE_AFTER_BOARD: readonly FateAfterBoard[] = Object.freeze(
  Array.from({ length: 49 }, (_, slot): FateAfterBoard => {
    if (slot === 0 || slot === 1) return 'focusLot';
    if (slot <= 5 || slot === 8) return 'keep';
    return 'redraw';
  }),
);

/** 事件的 post 里有没有画面上看得到的变化（玩家、地产、设施、企业、股票）；FATE 的效果多数不在这里，而在随后的事件里 */
export function postShowsEffect(post: PostPatch | undefined): boolean {
  if (!post) return false;
  return [post.players, post.lands, post.facilities, post.companies, post.stocks].some((x) => (x?.length ?? 0) > 0);
}

/**
 * 受影响玩家（原版新闻板参数 0 分支逐人列出的那些）：新闻 11–13 税、23 储金红利另带原版的逐人行「<人>繳交<n>元」，
 * 金额按公布时的显示态算（selectors.newsRowAmount，与引擎同一公式；税在 NEWS 之后才逐人收，NEWS 的 post 里还没有）
 */
function newsAffected(ctx: PresentationContext, e: GameEventOf<'NEWS'>): AffectedRow[] {
  const rows = affectedRows(ctx, e, e.affected);
  const map = ctx.map;
  if (!map) return rows;
  const view = ctx.view();
  return rows.map((r) => {
    if (!e.affected.includes(r.seat)) return r;
    const amount = newsRowAmount(view, map, e.id, r.seat);
    const line = amount === null ? null : newsRowLine(ctx.names, e.id, r.name, amount);
    return line === null ? r : { ...r, line };
  });
}

/**
 * 新闻：原版皮肤（新闻板就绪，popupStore.opensClassic）照原版新闻板停 holdMs（语音 ≥ 2.4 秒），任意键跳过、连语音一起停，
 * 没有网页版的跳过钮与最短时间（fcn.00452c39）；原版新闻板没有音效，只有语音。程序化弹窗：提示音 + 打字机标题，
 * 最短 1.5 秒后可点跳过。之后同步显示态、飘字。
 */
export const NEWS: EventHandler<'NEWS'> = async (e, ctx) => {
  const category = newsCategory(e.id);
  const spec: NewsPopupSpec = {
    kind: 'news',
    id: e.id,
    category,
    categoryLabel: ctx.t(`news:category.${category}`),
    headline: newsHeadline(ctx.names, e.id, e.params),
    affected: newsAffected(ctx, e),
  };
  const t = newsShowMs(e.id, currentPacing());
  const classic = opensClassic(spec);
  if (!classic) ctx.audio.cue?.(NEWS_STING_SFX);
  const skipped = await showPopup(ctx, spec, t.holdMs, classic ? 0 : Math.min(1500, t.holdMs));
  if (skipped && classic) ctx.audio.stopVoice?.();
  syncFromPost(ctx, e.post);
  showAllDeltas(ctx, e);
  await ctx.wait(t.endMs);
};

/**
 * 命运：
 * - 原版皮肤（命运板就绪，popupStore.opensClassic）：命运板停 holdMs（任意键跳过，跳过时停掉语音），之后按 FATE_AFTER_BOARD：
 *   - keep（没有加持）：板子一直留到停顿结束（holdMs + tailMs），之后同步显示态；
 *   - redraw / focusLot，以及有加持的各条：关板（重画地图）→ 有加持时加持消息框 blessingMs（phase blessing，效果在消息框
 *     之后）→ 同步显示态、金额飘字 → 效果写在 FATE 自己的 post 里（贷款、股票、点券…）时当场可见，在地图上停 tailMs；
 *     多数效果在随后的事件里（引擎先发 FATE 再执行：MONEY、CONFINED、LOT_MUTATED、VEHICLE_DESTROYED…），这里不空等，
 *     让它们紧接着板子演出——原版的顺序是重画 → 效果 → 停 0.8 秒，先空等 0.8 秒再出效果反而把飘字推迟了；
 *     focusLot（拆屋、征收）的镜头移到地块由随后的 LOT_MUTATED 负责（这里还不知道是哪块地）；
 *   原版命运板没有音效，只有语音；
 * - 程序化弹窗：翻牌声（FATE_FLIP_SFX）+ 翻面卡（含加持结果）停满 holdMs + blessingMs + tailMs，之后同步显示态。
 * 都不超过 FATE 的预算（原版皮肤的重画类效果在随后事件里时比预算短 tailMs）。
 */
export const FATE: EventHandler<'FATE'> = async (e, ctx) => {
  const stage = stageOf(ctx);
  const player = playerRef(ctx, e.seat);
  const shown = fateShown(ctx.names, e);
  const slot = fateVariantSlot(e.id, ctx.names.globalMapId?.());
  const blessing =
    e.blessing === null || shown.category === null ? null : blessingText(ctx, shown.category, e.blessing);
  const t = fateShowMs(slot, blessing !== null, currentPacing());
  const spec: FatePopupSpec | null = player
    ? {
        kind: 'fate',
        player,
        id: e.id,
        slot,
        phase: 'board',
        title: fateTitle(ctx.names, e.id),
        text: shown.text,
        textAmount: shown.textAmount,
        amountText: shown.amountText,
        amountTone: shown.amountTone,
        tone: shown.tone,
        blessingText: blessing,
      }
    : null;
  const classic = spec !== null && opensClassic(spec);
  // 原版命运板之外没有头顶的问号与翻牌声（程序化演出才有）
  if (!classic) {
    stage.bubble({ seat: e.seat }, '？', 600);
    ctx.audio.cue?.(FATE_FLIP_SFX);
  }
  ctx.board.setActorPose(e.seat, shown.tone === 'good' ? 'cheer' : shown.tone === 'bad' ? 'sad' : 'idle');
  if (spec && classic) {
    // 原版：板子停到语音播完（任意键跳过、连语音一起停）→ 重画地图（或留着板子）、执行效果 → 停 0.8 秒
    const keep = blessing === null && FATE_AFTER_BOARD[slot] === 'keep';
    const skipped = await showPopup(ctx, spec, keep ? t.holdMs + t.tailMs : t.holdMs, 0);
    if (skipped) ctx.audio.stopVoice?.();
    if (blessing !== null) await showPopup(ctx, { ...spec, phase: 'blessing' }, t.blessingMs, 0);
    syncFromPost(ctx, e.post);
    showAllDeltas(ctx, e);
    if (!keep && postShowsEffect(e.post)) await ctx.wait(t.tailMs);
  } else {
    if (spec) await showPopup(ctx, spec, t.holdMs + t.blessingMs + t.tailMs, Math.min(1100, t.holdMs));
    else await ctx.wait(t.holdMs + t.blessingMs + t.tailMs);
    syncFromPost(ctx, e.post);
    showAllDeltas(ctx, e);
  }
  ctx.board.setActorPose(e.seat, 'idle');
  await ctx.wait(t.endMs);
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
