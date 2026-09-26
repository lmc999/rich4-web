/**
 * ASK 帧：通用的单问答（design/engine.md §6.1）。帧里只存 kind 与 data（例如 {lot}），
 * step 时按当前状态重新构造 options（不再适用就直接出栈、不问），resume 时交给 ASK_HANDLERS[kind].resolve。
 *
 * M1 实现 BUY_LAND、UPGRADE_LAND；其余 kind 的构造器在对应里程碑补上（现在调用会抛 NOT_IMPLEMENTED）。
 */
import type { Ctx } from '../core/ctx';
import type { FrameHandler } from '../core/frameHandler';
import { buildBuyLand, buildUpgradeLand } from '../decisions/build';
import { EngineInvariantError } from '../errors';
import { confirmBuyLand, confirmUpgradeLand } from '../squares/property';
import type { DecisionOptionsMap } from '../types/decision';
import type { FrameOf, SimpleAskKind } from '../types/frames';
import type { LotId } from '../types/ids';
import type { PlayerAction, PlayerIntent } from '../types/intent';

type AskFrame = FrameOf<'ASK'>;

export interface AskBuild<K extends SimpleAskKind> {
  options: DecisionOptionsMap[K];
  defaultIntent: PlayerIntent;
  lot: LotId | null;
  amount: number | null;
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

function notImplemented<K extends SimpleAskKind>(kind: K): AskHandler<K> {
  const fail = (): never => {
    throw new EngineInvariantError('NOT_IMPLEMENTED', `ASK ${kind}`);
  };
  return { build: fail, resolve: fail };
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
  // TODO(M4)：设施、研究所、乐透、认购、建设公司
  BUY_FACILITY: notImplemented('BUY_FACILITY'),
  BUILD_FACILITY: notImplemented('BUILD_FACILITY'),
  UPGRADE_FACILITY: notImplemented('UPGRADE_FACILITY'),
  RESEARCH: notImplemented('RESEARCH'),
  LOTTERY: notImplemented('LOTTERY'),
  CONSTRUCTION_PICK: notImplemented('CONSTRUCTION_PICK'),
  SUBSCRIBE_SHARES: notImplemented('SUBSCRIBE_SHARES'),
  // TODO(M6)：免费首建类型、保释、被动卡、满手弃牌
  FACILITY_TYPE: notImplemented('FACILITY_TYPE'),
  BAIL: notImplemented('BAIL'),
  USE_FREE_CARD: notImplemented('USE_FREE_CARD'),
  SCAPEGOAT: notImplemented('SCAPEGOAT'),
  DISCARD_CARD: notImplemented('DISCARD_CARD'),
  // TODO(M7)：魔法屋、生日、死神目标；TODO(M8)：小游戏
  MAGIC_CAST: notImplemented('MAGIC_CAST'),
  BIRTHDAY_PICK: notImplemented('BIRTHDAY_PICK'),
  DEATH_GOD_TARGET: notImplemented('DEATH_GOD_TARGET'),
  MINIGAME: notImplemented('MINIGAME'),
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
      ctx.pop(f);
      return;
    }
    ctx.ask(f, f.seat, f.kind, b.options, b.defaultIntent, { lot: b.lot, amount: b.amount });
  },
  resume(ctx, f, a) {
    f.stage = 'done';
    (ASK_HANDLERS[f.kind] as AskHandler<SimpleAskKind>).resolve(ctx, f, a);
  },
};
