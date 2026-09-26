/**
 * BANKRUPT 帧（design/engine.md §6.2「破产打断」、§7.10；docs/research/r_rules_map.md §9；r_property.md §9.4）。
 *
 * detach    标记出局；作废乐透号码、撤下公布栏挂牌、清掉别人对他的敌意（神明、炸弹放回地图、解除同盟属于 M6）→ BANKRUPT
 * endcheck  在场真人为 0（endWhenNoHumans）→ noHumansLeft；只剩 1 人 → lastStanding。结束时跳过清算，地产原样保留
 * liquidate 股票按市价卖出（所得进公库）并重排董事长；名下住宅与设施变无主、等级保留、地契清零；卡片回牌堆、道具回库存（点券不归任何人）；
 *           现金、存款、贷款、点券、状态清零 → LIQUIDATION
 * auctions  释放的地产 > 3 处时随机抽 3 处拍卖，成交款进公库（TODO(M7)：AUCTION 帧；M1 不拍卖）
 * beggar    棋子留在原节点成为乞丐 → BECAME_BEGGAR
 * done      出栈，并展开破产者的帧（MOVE、LAND、TOLL…；他的 TURN 转入 end）
 */
import { ITEM_IDS, isPoolItem } from '../../data/tables/ids';
import { VEHICLE_ITEM } from '../../data/tables/setup';
import type { FrameHandler } from '../core/frameHandler';
import { emptyCounters } from '../rules/counters';
import { returnCardToDeck } from '../rules/inventory';
import { releaseLot } from '../rules/landMutation';
import { addMoney, zeroOutMoney } from '../rules/payment';
import { updateChairman } from '../rules/stock';
import { checkAfterBankruptcy } from '../rules/victory';
import type { FrameOf } from '../types/frames';
import type { LotId } from '../types/ids';

type BankruptFrame = FrameOf<'BANKRUPT'>;

export const BANKRUPT: FrameHandler<BankruptFrame> = {
  step(ctx, f) {
    const s = ctx.s;
    const p = ctx.player(f.seat);
    switch (f.stage) {
      case 'detach': {
        p.alive = false;
        p.out = 'bankrupt';
        s.lottery.owners = s.lottery.owners.map((o) => (o === f.seat ? null : o));
        s.noticeBoard = s.noticeBoard.filter((l) => l.seller !== f.seat);
        for (const q of s.players) q.hostility[f.seat] = 0;
        // TODO(M6)：附身的神明与身上的炸弹放回地图、解除同盟（ALLIANCE_BROKEN）、清空监狱 / 医院床位
        f.stage = 'endcheck';
        ctx.emit('BANKRUPT', { seat: f.seat, cause: f.cause, creditor: f.creditor });
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
        const stocks: number[] = [];
        s.stocks.forEach((st, i) => {
          const h = p.holdings[i];
          if (!h || h.shares <= 0) return;
          const value = Math.trunc((h.shares * st.priceCents) / 100);
          st.float += h.shares;
          s.econ.pool = addMoney(s, s.econ.pool, value);
          s.econ.ledger.minted += value;
          p.holdings[i] = { shares: 0, costCents: 0 };
          stocks.push(i);
        });
        const lots: LotId[] = [];
        for (const l of [...s.lands, ...s.facilities]) {
          if (l.owner !== f.seat) continue;
          releaseLot(l);
          lots.push(l.id);
        }
        for (const c of p.cards) returnCardToDeck(s, c);
        p.cards = [];
        for (const it of ITEM_IDS) {
          const n = p.items[it] ?? 0;
          if (n > 0 && isPoolItem(it)) s.pools.items[it] = (s.pools.items[it] ?? 0) + n;
          p.items[it] = 0;
        }
        const vehicleItem = VEHICLE_ITEM[p.vehicle];
        if (vehicleItem !== null) s.pools.items[vehicleItem] = (s.pools.items[vehicleItem] ?? 0) + 1;
        p.vehicle = 'walk';
        p.diceCount = 1;
        p.engineer = null;
        zeroOutMoney(s, f.seat);
        p.loan = 0;
        p.loanDue = 0;
        p.finance = 0;
        p.points = 0;
        p.st = emptyCounters();
        p.returning = false;
        p.bankReject = 0;
        p.insuranceDays = 0;
        p.quota = p.quota.map(() => 0);
        // TODO(M7)：lots.length > 3 时随机抽 3 处写入 f.auctionLots
        f.stage = 'auctions';
        ctx.emit('LIQUIDATION', { seat: f.seat, stocks, lots, auctionLots: f.auctionLots.slice() });
        // 股票退回市场后重排董事长
        for (const i of stocks) {
          const ch = updateChairman(s, i);
          if (ch) ctx.emit('CHAIRMAN_CHANGED', ch);
        }
        return;
      }
      case 'auctions':
        // TODO(M7)：依次压 AUCTION 帧（source 'bankrupt'，成交款进公库）
        f.stage = 'beggar';
        return;
      case 'beggar':
        f.stage = 'done';
        if (p.placed) {
          s.beggars.push({ seat: f.seat, node: p.node });
          ctx.emit('BECAME_BEGGAR', { seat: f.seat, node: p.node });
        }
        return;
      case 'done':
        ctx.pop(f);
        ctx.unwindActor(f.seat);
        return;
    }
  },
};
