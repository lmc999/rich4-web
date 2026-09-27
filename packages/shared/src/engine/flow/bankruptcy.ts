/**
 * BANKRUPT 帧（design/engine.md §6.2「破产打断」、§7.10；docs/research/r_rules_map.md §9；r_property.md §9.4）。
 *
 * detach    标记出局；作废乐透号码、撤下公布栏挂牌、清掉别人对他的敌意 → BANKRUPT；
 *           身上的炸弹放回所在格（格上已有东西或不可放置时回库存）⚑；附身的神明离场（搭档刷出）；解除同盟；
 *           他雇的恶人被强制送回（g_villains §4）
 * endcheck  在场真人为 0（endWhenNoHumans）→ noHumansLeft；只剩 1 人 → lastStanding。结束时跳过清算，地产原样保留
 * liquidate 股票按市价卖出（所得进公库）并重排董事长；名下住宅与设施变无主、等级保留、地契清零；卡片回牌堆、道具回库存（点券不归任何人）；
 *           现金、存款、贷款、点券、状态清零 → LIQUIDATION；释放的地产 > 3 处时随机抽 3 处写入 auctionLots
 * auctions  依次压 AUCTION 帧（无卖方，成交款进公库；流拍保持无主）
 * beggar    棋子留在原节点成为乞丐 → BECAME_BEGGAR
 * done      出栈，并展开破产者的帧（MOVE、LAND、TOLL…；他的 TURN 转入 end）
 * 共用环节在 flow/liquidation.ts（投降 SURRENDER 同样使用）。
 */
import type { FrameHandler } from '../core/frameHandler';
import { checkAfterBankruptcy } from '../rules/victory';
import type { FrameOf } from '../types/frames';
import { pushAuction } from './auction';
import { becomeBeggar, detachCombat, liquidate, markOut } from './liquidation';

type BankruptFrame = FrameOf<'BANKRUPT'>;

export const BANKRUPT: FrameHandler<BankruptFrame> = {
  step(ctx, f) {
    const s = ctx.s;
    switch (f.stage) {
      case 'detach': {
        markOut(ctx, f.seat, 'bankrupt');
        f.stage = 'endcheck';
        ctx.emit('BANKRUPT', { seat: f.seat, cause: f.cause, creditor: f.creditor });
        detachCombat(ctx, f.seat, { k: 'bankrupt', ref: null, by: f.seat });
        return;
      }
      case 'endcheck': {
        const end = checkAfterBankruptcy(s);
        if (end) {
          ctx.endGame(end);
          return;
        }
        f.stage = 'liquidate';
        return;
      }
      case 'liquidate': {
        f.stage = 'auctions';
        f.auctionLots = liquidate(ctx, f.seat).auctionLots;
        return;
      }
      case 'auctions': {
        const lot = f.auctionLots.shift();
        if (lot === undefined) {
          f.stage = 'beggar';
          return;
        }
        pushAuction(ctx, lot, null, 'bankrupt');
        return;
      }
      case 'beggar':
        f.stage = 'done';
        becomeBeggar(ctx, f.seat);
        return;
      case 'done':
        ctx.pop(f);
        ctx.unwindActor(f.seat);
        return;
    }
  },
};
