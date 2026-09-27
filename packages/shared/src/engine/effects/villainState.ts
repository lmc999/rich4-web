/**
 * 卡片、道具对四大恶人的作用（docs/research/g_villains.md §2、§4）。恶人的回合与雇用属于 M7（VILLAIN 帧、HIRE）。
 * - 陷害卡：直接关进监狱；飞弹、核弹、炸弹范围：送进医院。恶人不查免罪 / 嫁祸 / 复仇，也不计敌意。
 * - 恶人没有刑期：被关进去就一直关着，直到有人花 300 点券保释（保释人成为新雇主）⚑：关押时清掉雇主与状态。
 * - 「回老家」按最近一次从哪里被放出来判断，所以关押时把 home 改成新关押处。
 */
import type { Ctx } from '../core/ctx';
import type { Cause, VillainKind } from '../types/ids';

export function confineVillain(ctx: Ctx, kind: VillainKind, where: 'jail' | 'hospital', cause: Cause): void {
  const v = ctx.s.villains.find((x) => x.kind === kind);
  if (!v?.onBoard) return;
  const hold = where === 'jail' ? ctx.map.index.jailHold : ctx.map.index.hospitalHold;
  v.onBoard = false;
  v.home = where;
  v.node = hold;
  v.prevNode = hold;
  v.homeNode = hold;
  v.leftHome = false;
  v.employer = null;
  v.st = { jail: 0, hospital: 0, hibernate: 0, sleepwalk: 0, stay: 0, tortoise: 0 };
  ctx.emit('CONFINED', { actor: { t: 'villain', kind }, where, days: 0, total: 0, cause });
}
