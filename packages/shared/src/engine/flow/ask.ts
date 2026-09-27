/**
 * ASK 帧：通用的单问答（design/engine.md §6.1）。帧里只存 kind 与 data（例如 {lot}），
 * step 时按当前状态重新构造 options（不再适用就直接出栈、不问），resume 时交给 ASK_HANDLERS[kind].resolve。
 *
 * M1 实现 BUY_LAND、UPGRADE_LAND；M4 实现设施（买、首建、加盖、免费首建）、研究所、乐透、认购、建设公司；
 * M6 实现保释、满手弃牌；被动卡、魔法屋、生日、死神目标由持有流程的帧直接询问（flow/askCombat.ts）。
 */
import type { Ctx } from '../core/ctx';
import type { FrameHandler } from '../core/frameHandler';
import { buildBuyLand, buildUpgradeLand } from '../decisions/build';
import {
  buildBuildFacility,
  buildBuyFacility,
  buildConstruction,
  buildFacilityType,
  buildLottery,
  buildResearch,
  buildSubscribe,
  buildUpgradeFacility,
} from '../decisions/economy';
import { EngineInvariantError, EngineRuleError } from '../errors';
import { constructionPick, subscribeShares } from '../squares/company';
import {
  buildFacility,
  chooseFacilityType,
  confirmBuyFacility,
  confirmUpgradeFacility,
  startResearch,
} from '../squares/facility';
import { buyTicket } from '../squares/lottery';
import { MINIGAME_ASK } from '../squares/minigame';
import { confirmBuyLand, confirmUpgradeLand } from '../squares/property';
import type { DecisionOptionsMap, PendingMinigame } from '../types/decision';
import type { FrameOf, SimpleAskKind } from '../types/frames';
import type { CompanyLotId, FacilityLotId, LotId } from '../types/ids';
import type { PlayerAction, PlayerIntent } from '../types/intent';
import {
  BAIL_ASK,
  BIRTHDAY_PICK_ASK,
  DEATH_GOD_TARGET_ASK,
  DISCARD_ASK,
  MAGIC_CAST_ASK,
  SCAPEGOAT_ASK,
  USE_FREE_CARD_ASK,
} from './askCombat';
import { chargeConstructionNoTarget } from './fee';

type AskFrame = FrameOf<'ASK'>;

export interface AskBuild<K extends SimpleAskKind> {
  options: DecisionOptionsMap[K];
  defaultIntent: PlayerIntent;
  lot: LotId | null;
  amount: number | null;
  /** 只有 MINIGAME 给出（种子与参数写进 PendingDecision.minigame） */
  minigame?: PendingMinigame | null;
}

export interface AskHandler<K extends SimpleAskKind> {
  /** 不再适用（例如买不起了）返回 null，帧直接出栈 */
  build(ctx: Ctx, f: AskFrame): AskBuild<K> | null;
  resolve(ctx: Ctx, f: AskFrame, a: PlayerAction): void;
}

function lotOf(f: AskFrame): LotId {
  const lot = f.data.lot;
  if (typeof lot !== 'string') throw new EngineInvariantError('ASK_DATA', `ASK ${f.kind} without lot`);
  return lot as LotId;
}

function facOf(f: AskFrame): FacilityLotId {
  return lotOf(f) as FacilityLotId;
}

function companyOf(f: AskFrame): CompanyLotId {
  const c = f.data.company;
  if (typeof c !== 'string') throw new EngineInvariantError('ASK_DATA', `ASK ${f.kind} without company`);
  return c as CompanyLotId;
}

export const ASK_HANDLERS = Object.freeze({
  BUY_LAND: {
    build(ctx, f) {
      const lot = lotOf(f);
      const options = buildBuyLand(ctx.s, ctx.map, f.seat, ctx.map.landIdx(lot));
      return options ? { options, defaultIntent: { type: 'DECLINE' }, lot, amount: options.price } : null;
    },
    resolve(ctx, f, a) {
      if (a.type === 'CONFIRM') confirmBuyLand(ctx, f.seat, lotOf(f));
    },
  },
  UPGRADE_LAND: {
    build(ctx, f) {
      const lot = lotOf(f);
      const options = buildUpgradeLand(ctx.s, ctx.map, f.seat, ctx.map.landIdx(lot));
      return options ? { options, defaultIntent: { type: 'DECLINE' }, lot, amount: options.cost } : null;
    },
    resolve(ctx, f, a) {
      if (a.type === 'CONFIRM') confirmUpgradeLand(ctx, f.seat, lotOf(f));
    },
  },
  BUY_FACILITY: {
    build(ctx, f) {
      const lot = facOf(f);
      const options = buildBuyFacility(ctx.s, ctx.map, f.seat, ctx.map.facilityIdx(lot));
      return options ? { options, defaultIntent: { type: 'DECLINE' }, lot, amount: options.price } : null;
    },
    resolve(ctx, f, a) {
      if (a.type === 'CONFIRM') confirmBuyFacility(ctx, f.seat, facOf(f));
    },
  },
  BUILD_FACILITY: {
    build(ctx, f) {
      const lot = facOf(f);
      const options = buildBuildFacility(ctx.s, ctx.map, f.seat, ctx.map.facilityIdx(lot));
      return options ? { options, defaultIntent: { type: 'DECLINE' }, lot, amount: options.cost } : null;
    },
    resolve(ctx, f, a) {
      if (a.type === 'BUILD_FACILITY') buildFacility(ctx, f.seat, facOf(f), a.facility);
    },
  },
  UPGRADE_FACILITY: {
    build(ctx, f) {
      const lot = facOf(f);
      const options = buildUpgradeFacility(ctx.s, ctx.map, f.seat, ctx.map.facilityIdx(lot));
      return options ? { options, defaultIntent: { type: 'DECLINE' }, lot, amount: options.cost } : null;
    },
    resolve(ctx, f, a) {
      if (a.type === 'CONFIRM') confirmUpgradeFacility(ctx, f.seat, facOf(f));
    },
  },
  FACILITY_TYPE: {
    build(ctx, f) {
      const lot = facOf(f);
      const options = buildFacilityType(ctx.s, ctx.map, f.seat, ctx.map.facilityIdx(lot));
      if (!options) return null;
      const t = options.types[0]?.type ?? 'park';
      return { options, defaultIntent: { type: 'CHOOSE_FACILITY_TYPE', facility: t }, lot, amount: null };
    },
    resolve(ctx, f, a) {
      if (a.type === 'CHOOSE_FACILITY_TYPE') chooseFacilityType(ctx, f.seat, facOf(f), a.facility);
    },
  },
  RESEARCH: {
    build(ctx, f) {
      const lot = facOf(f);
      const options = buildResearch(ctx.s, f.seat, ctx.map.facilityIdx(lot));
      if (!options) return null;
      const last = options.projects[options.projects.length - 1];
      const defaultIntent = last ? ({ type: 'RESEARCH', project: last.project } as const) : ({ type: 'SKIP' } as const);
      return { options, defaultIntent, lot, amount: null };
    },
    resolve(ctx, f, a) {
      if (a.type === 'RESEARCH') startResearch(ctx, f.seat, facOf(f), a.project);
    },
  },
  LOTTERY: {
    build(ctx, f) {
      const options = buildLottery(ctx.s, f.seat);
      return options ? { options, defaultIntent: { type: 'SKIP' }, lot: null, amount: options.price } : null;
    },
    resolve(ctx, f, a) {
      if (a.type === 'LOTTERY_BUY') buyTicket(ctx, f.seat, a.number);
    },
  },
  CONSTRUCTION_PICK: {
    // 没有可加盖的目标：非董事长直接收 1000 × PI（构造时结算，帧随即出栈）；董事长无事
    build(ctx, f) {
      const company = companyOf(f);
      const chairman = f.data.chairman === true;
      const options = buildConstruction(ctx.s, ctx.map, f.seat, company, chairman);
      if (!options) {
        if (!chairman) chargeConstructionNoTarget(ctx, f.seat, company);
        return null;
      }
      let cheapest = options.lots[0]!;
      for (const l of options.lots) if (l.cost < cheapest.cost) cheapest = l;
      return { options, defaultIntent: { type: 'PICK_LOT', lot: cheapest.lot }, lot: company, amount: null };
    },
    resolve(ctx, f, a) {
      if (a.type === 'SKIP') throw new EngineRuleError('NOT_ALLOWED', 'construction pick cannot be skipped');
      if (a.type === 'PICK_LOT') constructionPick(ctx, f.seat, companyOf(f), f.data.chairman === true, a.lot);
    },
  },
  SUBSCRIBE_SHARES: {
    build(ctx, f) {
      const company = companyOf(f);
      const options = buildSubscribe(ctx.s, ctx.map, f.seat, ctx.map.companyIdx(company));
      return options ? { options, defaultIntent: { type: 'SKIP' }, lot: company, amount: options.unitPrice } : null;
    },
    resolve(ctx, f, a) {
      if (a.type === 'SUBSCRIBE') subscribeShares(ctx, f.seat, companyOf(f), a.shares);
    },
  },
  // M6：保释、满手弃牌（flow/askCombat.ts）；被动卡由持有付款 / 关押流程的帧直接询问
  BAIL: BAIL_ASK,
  USE_FREE_CARD: USE_FREE_CARD_ASK,
  SCAPEGOAT: SCAPEGOAT_ASK,
  DISCARD_CARD: DISCARD_ASK,
  // M7：魔法屋（MAGIC 帧）、生日（FATE 帧）、死神目标（SURRENDER 帧）由各自的帧直接询问
  MAGIC_CAST: MAGIC_CAST_ASK,
  BIRTHDAY_PICK: BIRTHDAY_PICK_ASK,
  DEATH_GOD_TARGET: DEATH_GOD_TARGET_ASK,
  MINIGAME: MINIGAME_ASK,
} satisfies { readonly [K in SimpleAskKind]: AskHandler<K> });

export const ASK: FrameHandler<AskFrame> = {
  step(ctx, f) {
    if (f.stage === 'done') {
      ctx.pop(f);
      return;
    }
    const h = ASK_HANDLERS[f.kind] as AskHandler<SimpleAskKind>;
    const b = h.build(ctx, f);
    if (b === null) {
      // build 可能已结算并压了 BANKRUPT（建设公司无目标时收费）：此时本帧不在栈顶，交给 run 在演员出局后丢弃
      f.stage = 'done';
      if (ctx.top() === f) ctx.pop(f);
      return;
    }
    const extra = { minigame: b.minigame ?? null };
    ctx.ask(f, f.seat, f.kind, b.options, b.defaultIntent, { lot: b.lot, amount: b.amount }, extra);
  },
  resume(ctx, f, a) {
    f.stage = 'done';
    (ASK_HANDLERS[f.kind] as AskHandler<SimpleAskKind>).resolve(ctx, f, a);
  },
};
