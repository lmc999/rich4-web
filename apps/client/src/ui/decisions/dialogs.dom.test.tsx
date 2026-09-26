// 各决策对话框：按 options 渲染价格与候选，点击后提交的 intent 正确（PlayerIntentSchema 校验），重复点击只提交一次
import { CARD, ITEM } from '@rich4/shared/engine';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import AuctionDialog, { bidPrice } from './AuctionDialog';
import BailDialog from './BailDialog';
import BirthdayPickDialog from './BirthdayPickDialog';
import BuyLotDialog from './BuyLotDialog';
import DeathGodTargetDialog from './DeathGodTargetDialog';
import DiscardDialog from './DiscardDialog';
import FacilityBuildDialog from './FacilityBuildDialog';
import LotPickDialog from './LotPickDialog';
import MagicHouseDialog from './MagicHouseDialog';
import MinigameIntro, { ticketStartsAt } from './MinigameIntro';
import PassiveCardDialog from './PassiveCardDialog';
import ResearchDialog from './ResearchDialog';
import ShopDialog from './ShopDialog';
import SubscribeDialog from './SubscribeDialog';
import { expectSingleIntent, installResizeObserver, intents, renderDialog } from './testing';
import UpgradeDialog from './UpgradeDialog';

installResizeObserver();

describe('BuyLotDialog', () => {
  it('BUY_LAND：显示地价、购买后现金、买后过路费与同街归属；购买 → CONFIRM，连点只提交一次', async () => {
    const r = renderDialog(BuyLotDialog, 'BUY_LAND');
    expect(screen.getByTestId('buy-price')).toHaveTextContent('2,000');
    expect(screen.getByTestId('buy-cash-after')).toHaveTextContent('46,800');
    expect(screen.getByTestId('buy-toll-after')).toHaveTextContent('400');
    const street = screen.getByTestId('buy-street');
    expect(within(street).getAllByRole('listitem')).toHaveLength(3);
    expect(street).toHaveTextContent('阿土伯');
    expect(street).toHaveTextContent('无主');
    const btn = screen.getByTestId('buy-confirm');
    await r.user.dblClick(btn);
    await r.user.click(btn);
    expectSingleIntent(r.submit, { type: 'CONFIRM' });
    expect(screen.getByTestId('decision-BUY_LAND')).toHaveAttribute('data-locked', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('已提交');
  });

  it('BUY_LAND：现金不足时购买按钮禁用，只能放弃 → DECLINE', async () => {
    const r = renderDialog(BuyLotDialog, 'BUY_LAND', { options: { price: 90000 } });
    expect(screen.getByRole('alert')).toHaveTextContent('现金不足');
    expect(screen.getByTestId('buy-confirm')).toBeDisabled();
    await r.user.click(screen.getByTestId('buy-decline'));
    expectSingleIntent(r.submit, { type: 'DECLINE' });
  });

  it('BUY_FACILITY：显示设施种类与福神加成', async () => {
    const r = renderDialog(BuyLotDialog, 'BUY_FACILITY');
    expect(screen.getByText('福神附身：买下后多送 1 级！', { exact: false })).toBeInTheDocument();
    expect(screen.getByTestId('buy-price')).toHaveTextContent('4,000');
    expect(screen.getByTestId('decision-BUY_FACILITY')).toHaveTextContent('公园');
    await r.user.click(screen.getByTestId('buy-confirm'));
    expectSingleIntent(r.submit, { type: 'CONFIRM' });
  });
});

describe('UpgradeDialog', () => {
  it('UPGRADE_LAND：当前 → 下一级预览、费用、过路费前后', async () => {
    const r = renderDialog(UpgradeDialog, 'UPGRADE_LAND');
    const previews = screen.getAllByTestId('building-preview');
    expect(previews.map((p) => p.getAttribute('data-level'))).toEqual(['2', '3']);
    expect(screen.getByTestId('upgrade-cost')).toHaveTextContent('500');
    expect(screen.getByTestId('upgrade-toll')).toHaveTextContent(/2,500.*6,000/);
    await r.user.click(screen.getByTestId('upgrade-confirm'));
    await r.user.click(screen.getByTestId('upgrade-decline'));
    expectSingleIntent(r.submit, { type: 'CONFIRM' });
  });

  it('UPGRADE_FACILITY：显示设施与等级上限；不盖 → DECLINE', async () => {
    const r = renderDialog(UpgradeDialog, 'UPGRADE_FACILITY');
    expect(screen.getByTestId('decision-UPGRADE_FACILITY')).toHaveTextContent('旅馆');
    expect(screen.getByTestId('decision-UPGRADE_FACILITY')).toHaveTextContent('5 级');
    await r.user.click(screen.getByTestId('upgrade-decline'));
    expectSingleIntent(r.submit, { type: 'DECLINE' });
  });
});

describe('FacilityBuildDialog', () => {
  it('BUILD_FACILITY：未选类型时不能兴建；选旅馆 → BUILD_FACILITY{hotel}', async () => {
    const r = renderDialog(FacilityBuildDialog, 'BUILD_FACILITY');
    expect(screen.getByTestId('facility-cost')).toHaveTextContent('800');
    expect(screen.getByTestId('facility-confirm')).toBeDisabled();
    expect(screen.getByTestId('facility-type-hotel')).toHaveTextContent('最高 5 级');
    await r.user.click(screen.getByTestId('facility-type-hotel'));
    expect(screen.getByTestId('facility-type-hotel')).toHaveAttribute('aria-pressed', 'true');
    await r.user.dblClick(screen.getByTestId('facility-confirm'));
    expectSingleIntent(r.submit, { type: 'BUILD_FACILITY', facility: 'hotel' });
  });

  it('BUILD_FACILITY：不建 → DECLINE', async () => {
    const r = renderDialog(FacilityBuildDialog, 'BUILD_FACILITY');
    await r.user.click(screen.getByTestId('facility-decline'));
    expectSingleIntent(r.submit, { type: 'DECLINE' });
  });

  it('FACILITY_TYPE：免费首建，没有放弃按钮 → CHOOSE_FACILITY_TYPE', async () => {
    const r = renderDialog(FacilityBuildDialog, 'FACILITY_TYPE');
    expect(screen.queryByTestId('facility-decline')).toBeNull();
    await r.user.click(screen.getByTestId('facility-type-lab'));
    await r.user.click(screen.getByTestId('facility-confirm'));
    expectSingleIntent(r.submit, { type: 'CHOOSE_FACILITY_TYPE', facility: 'lab' });
  });
});

describe('ResearchDialog', () => {
  it('显示当前研发，改选项目 3 → RESEARCH{3}', async () => {
    const r = renderDialog(ResearchDialog, 'RESEARCH');
    expect(screen.getByTestId('research-current')).toHaveTextContent('机器工人');
    expect(screen.getByTestId('research-1')).toHaveAttribute('aria-pressed', 'true');
    await r.user.click(screen.getByTestId('research-3'));
    expect(screen.getByText('改选其他项目会放弃目前的研发进度。')).toBeInTheDocument();
    await r.user.click(screen.getByTestId('research-confirm'));
    expectSingleIntent(r.submit, { type: 'RESEARCH', project: 3 });
  });

  it('维持现状 → SKIP', async () => {
    const r = renderDialog(ResearchDialog, 'RESEARCH');
    await r.user.click(screen.getByTestId('research-skip'));
    expectSingleIntent(r.submit, { type: 'SKIP' });
  });
});

describe('ShopDialog', () => {
  it('显示点券；买不起的卡置灰并显示原因；选卡后买下 → SHOP_BUY_CARD{shelfIdx}', async () => {
    const r = renderDialog(ShopDialog, 'SHOP');
    expect(screen.getByTestId('shop-points')).toHaveTextContent('350');
    const hib = screen.getByTestId('shop-shelf-6');
    expect(hib).toBeDisabled();
    expect(hib).toHaveTextContent('已经卖完了');
    await r.user.click(screen.getByTestId('shop-shelf-3'));
    await r.user.dblClick(screen.getByTestId('shop-buy-card'));
    expectSingleIntent(r.submit, { type: 'SHOP_BUY_CARD', shelfIdx: 3 });
  });

  it('买道具：数量步进器受 maxQty 限制 → SHOP_BUY_ITEM{item, qty}', async () => {
    const r = renderDialog(ShopDialog, 'SHOP');
    await r.user.click(screen.getByRole('tab', { name: '买道具' }));
    expect(screen.getByTestId(`shop-item-${ITEM.MINE}`)).toBeDisabled();
    await r.user.click(screen.getByTestId(`shop-item-${ITEM.CAR}`));
    const qty = screen.getByRole('spinbutton', { name: '数量' });
    await r.user.clear(qty);
    await r.user.type(qty, '9');
    expect(qty).toHaveValue(2);
    await r.user.click(screen.getByTestId('shop-buy-item'));
    expectSingleIntent(r.submit, { type: 'SHOP_BUY_ITEM', item: ITEM.CAR, qty: 2 });
  });

  it('卖卡与卖道具', async () => {
    const r = renderDialog(ShopDialog, 'SHOP');
    await r.user.click(screen.getByRole('tab', { name: '卖卡片' }));
    await r.user.click(screen.getByTestId('shop-sell-card-1'));
    await r.user.click(screen.getByTestId('shop-sell-card'));
    expect(intents(r.submit)).toEqual([{ type: 'SHOP_SELL_CARD', slot: 1 }]);
  });

  it('卖道具 → SHOP_SELL_ITEM；离开 → LEAVE（新决策 id 到来后解锁）', async () => {
    const r = renderDialog(ShopDialog, 'SHOP');
    await r.user.click(screen.getByRole('tab', { name: '卖道具' }));
    await r.user.click(screen.getByTestId(`shop-sell-item-${ITEM.ROADBLOCK}`));
    await r.user.click(screen.getByRole('button', { name: '增加' }));
    await r.user.click(screen.getByTestId('shop-sell-item'));
    r.rerenderWith({ decision: { ...r.decision, decisionId: 'd-next' } });
    await r.user.click(screen.getByTestId('shop-leave'));
    expect(intents(r.submit)).toEqual([{ type: 'SHOP_SELL_ITEM', item: ITEM.ROADBLOCK, qty: 2 }, { type: 'LEAVE' }]);
  });

  it('交易次数用完时只能离开', async () => {
    renderDialog(ShopDialog, 'SHOP', {
      options: { visit: { entryPoints: 350, trades: [], remaining: 0 } },
    });
    expect(screen.getByText('本次进店的交易次数已用完，只能离开。')).toBeInTheDocument();
  });
});

describe('BailDialog', () => {
  it('保释在押玩家 → BAIL{seat}', async () => {
    const r = renderDialog(BailDialog, 'BAIL');
    expect(screen.getByTestId('bail-seat-2')).toHaveTextContent('还有 3 天');
    await r.user.click(screen.getByTestId('bail-seat-2'));
    expectSingleIntent(r.submit, { type: 'BAIL', seat: 2 });
  });

  it('雇用恶人 → HIRE；已出门的恶人禁用；点券不足时全部禁用', async () => {
    const r = renderDialog(BailDialog, 'BAIL', { options: { points: 400 } });
    expect(screen.getByTestId('bail-hire-thief')).toBeDisabled();
    await r.user.click(screen.getByTestId('bail-hire-robber'));
    expectSingleIntent(r.submit, { type: 'HIRE', villain: 'robber' });
  });

  it('点券不足：雇用禁用，离开 → SKIP', async () => {
    const r = renderDialog(BailDialog, 'BAIL', { options: { points: 20 } });
    expect(screen.getByTestId('bail-hire-robber')).toBeDisabled();
    expect(screen.getByTestId('bail-seat-2')).toBeDisabled();
    await r.user.click(screen.getByTestId('bail-skip'));
    expectSingleIntent(r.submit, { type: 'SKIP' });
  });
});

describe('MinigameIntro', () => {
  it('显示玩法与最高分；不玩了 → MINIGAME_DECLINE', async () => {
    const r = renderDialog(MinigameIntro, 'MINIGAME', { minigame: { startsAt: Date.now() + 3000 } });
    expect(screen.getByTestId('decision-MINIGAME')).toHaveTextContent('企鹅挖宝');
    expect(screen.getByTestId('decision-MINIGAME')).toHaveTextContent('188');
    expect(screen.getByTestId('minigame-start')).toBeInTheDocument();
    await r.user.dblClick(screen.getByTestId('minigame-decline'));
    expectSingleIntent(r.submit, { type: 'MINIGAME_DECLINE' });
  });

  it('开局时间已过则不能再放弃', () => {
    renderDialog(MinigameIntro, 'MINIGAME', { minigame: { startsAt: Date.now() - 10 } });
    expect(screen.getByTestId('minigame-decline')).toBeDisabled();
    expect(ticketStartsAt({ startsAt: 5 })).toBe(5);
    expect(ticketStartsAt(null)).toBeNull();
    expect(ticketStartsAt({ startsAt: 'x' })).toBeNull();
  });
});

describe('MagicHouseDialog', () => {
  it('显示条件与名单；选效果 → MAGIC_CAST{effect}', async () => {
    const r = renderDialog(MagicHouseDialog, 'MAGIC_CAST');
    expect(screen.getByTestId('magic-condition')).toHaveTextContent('财产最多');
    expect(screen.getByTestId('magic-targets')).toHaveTextContent('钱夫人');
    expect(screen.getByTestId('magic-confirm')).toBeDisabled();
    await r.user.click(screen.getByTestId('magic-effect-4'));
    await r.user.click(screen.getByTestId('magic-confirm'));
    expectSingleIntent(r.submit, { type: 'MAGIC_CAST', effect: 4 });
  });
});

describe('LotPickDialog', () => {
  it('候选地块、工程费与租金；选 L5 → PICK_LOT；可跳过', async () => {
    const r = renderDialog(LotPickDialog, 'CONSTRUCTION_PICK');
    expect(screen.getByTestId('construction-L5')).toHaveTextContent('1,200');
    expect(screen.getByTestId('construction-L5')).toHaveTextContent('租金 7,200');
    await r.user.click(screen.getByTestId('construction-L5'));
    await r.user.click(screen.getByTestId('construction-confirm'));
    expectSingleIntent(r.submit, { type: 'PICK_LOT', lot: 'L5' });
  });

  it('董事长免费；不可跳过时没有跳过按钮', () => {
    renderDialog(LotPickDialog, 'CONSTRUCTION_PICK', {
      options: {
        chairman: true,
        levels: 2,
        canSkip: false,
        lots: [{ lot: 'L1', level: 2, cost: 0, rent: 2500 }],
      },
    });
    expect(screen.queryByTestId('construction-skip')).toBeNull();
    expect(screen.getByTestId('construction-L1')).toHaveTextContent('免费');
    expect(screen.getByText(/免费加盖 2 级/)).toBeInTheDocument();
  });
});

describe('SubscribeDialog', () => {
  it('合计 = 认购价 × 股数 → SUBSCRIBE{shares}', async () => {
    const r = renderDialog(SubscribeDialog, 'SUBSCRIBE_SHARES');
    expect(screen.getByTestId('subscribe-total')).toHaveTextContent('8,000'); // 默认 100 股 × 80
    const input = screen.getByRole('spinbutton', { name: '认购股数' });
    await r.user.clear(input);
    await r.user.type(input, '250');
    expect(screen.getByTestId('subscribe-total')).toHaveTextContent('20,000');
    await r.user.click(screen.getByTestId('subscribe-confirm'));
    expectSingleIntent(r.submit, { type: 'SUBSCRIBE', shares: 250 });
  });

  it('上限取 max 与现金可买量的较小值', async () => {
    const r = renderDialog(SubscribeDialog, 'SUBSCRIBE_SHARES', { options: { cash: 1000 } });
    await r.user.click(screen.getByRole('button', { name: '最大' }));
    expect(screen.getByRole('spinbutton', { name: '认购股数' })).toHaveValue(12);
    await r.user.click(screen.getByTestId('subscribe-skip'));
    expectSingleIntent(r.submit, { type: 'SKIP' });
  });
});

describe('PassiveCardDialog', () => {
  it('USE_FREE_CARD：显示场景与金额；使用免费卡 → CONFIRM', async () => {
    const r = renderDialog(PassiveCardDialog, 'USE_FREE_CARD');
    expect(screen.getByTestId('free-text')).toHaveTextContent('过路费 6000');
    expect(screen.getByTestId('free-amount')).toHaveTextContent('6,000');
    await r.user.click(screen.getByTestId('free-confirm'));
    expectSingleIntent(r.submit, { type: 'CONFIRM' });
  });

  it('USE_FREE_CARD：照付 → DECLINE', async () => {
    const r = renderDialog(PassiveCardDialog, 'USE_FREE_CARD');
    await r.user.click(screen.getByTestId('free-decline'));
    expectSingleIntent(r.submit, { type: 'DECLINE' });
  });

  it('SCAPEGOAT：选人 → SCAPEGOAT{target}', async () => {
    const r = renderDialog(PassiveCardDialog, 'SCAPEGOAT');
    expect(screen.getByTestId('scapegoat-text')).toHaveTextContent('坐牢 5 天');
    expect(screen.getByTestId('scapegoat-confirm')).toBeDisabled();
    await r.user.click(screen.getByTestId('scapegoat-seat-2'));
    expect(screen.getByTestId('scapegoat-confirm')).toHaveTextContent('嫁祸给 约翰乔');
    await r.user.click(screen.getByTestId('scapegoat-confirm'));
    expectSingleIntent(r.submit, { type: 'SCAPEGOAT', target: 2 });
  });
});

describe('AuctionDialog', () => {
  it('显示现价与领先者；加价 → BID{inc}；超过现金的档位禁用', async () => {
    const r = renderDialog(AuctionDialog, 'AUCTION_BID', { options: { cash: 3000 } });
    expect(screen.getByTestId('auction-price')).toHaveTextContent('2,300');
    expect(screen.getByTestId('auction-leader')).toHaveTextContent('阿土伯');
    expect(screen.getByTestId('auction-bid-1000')).toBeDisabled(); // 2300 + 1000 > 3000
    await r.user.dblClick(screen.getByTestId('auction-bid-500'));
    expectSingleIntent(r.submit, { type: 'BID', inc: 500 });
  });

  it('新一轮询问（新 decisionId）刷新价格与领先者，并解锁', async () => {
    const r = renderDialog(AuctionDialog, 'AUCTION_BID');
    await r.user.click(screen.getByTestId('auction-bid-100'));
    r.rerenderWith({
      decision: { ...r.decision, decisionId: 'd-ask2', options: { ...r.decision.options, price: 2800, leader: 3 } },
    });
    expect(screen.getByTestId('auction-price')).toHaveTextContent('2,800');
    expect(screen.getByTestId('auction-leader')).toHaveTextContent('钱夫人');
    await r.user.click(screen.getByTestId('auction-pass'));
    expect(intents(r.submit)).toEqual([{ type: 'BID', inc: 100 }, { type: 'PASS' }]);
  });

  it('无人出价时有「按起拍价出价」（inc=0）；退出 → QUIT', async () => {
    const r = renderDialog(AuctionDialog, 'AUCTION_BID', {
      options: { leader: null, price: 0, increments: [0, 100, 500, 1000, 5000, 10000] },
    });
    expect(screen.getByTestId('auction-price')).toHaveTextContent('1,800');
    expect(screen.getByTestId('auction-bid-0')).toHaveTextContent('按起拍价出价');
    await r.user.click(screen.getByTestId('auction-quit'));
    expectSingleIntent(r.submit, { type: 'QUIT' });
    expect(bidPrice({ leader: null, start: 1800, price: 0 }, 0)).toBe(1800);
    expect(bidPrice({ leader: 1, start: 1800, price: 2300 }, 500)).toBe(2800);
  });
});

describe('BirthdayPickDialog', () => {
  it('每位有卡的对手各预选第一张；改选后 → PICK_CARDS', async () => {
    const r = renderDialog(BirthdayPickDialog, 'BIRTHDAY_PICK');
    expect(screen.queryByTestId('birthday-victim-3')).toBeNull(); // 没有卡的不列出
    expect(screen.getByTestId('birthday-1-0')).toHaveAttribute('data-selected', 'true');
    await r.user.click(screen.getByTestId('birthday-1-2'));
    await r.user.click(screen.getByTestId('birthday-confirm'));
    expectSingleIntent(r.submit, {
      type: 'PICK_CARDS',
      picks: [
        { from: 1, slot: 2 },
        { from: 2, slot: 0 },
      ],
    });
  });
});

describe('DiscardDialog', () => {
  it('显示新卡与手牌；选一张 → DISCARD{slot}', async () => {
    const r = renderDialog(DiscardDialog, 'DISCARD_CARD');
    expect(screen.getByTestId('discard-incoming')).toHaveTextContent('怪兽卡');
    expect(screen.getByTestId('discard-confirm')).toBeDisabled();
    await r.user.click(screen.getByTestId('discard-3'));
    expect(screen.getByTestId('discard-confirm')).toHaveTextContent('丢掉 停留卡');
    await r.user.click(screen.getByTestId('discard-confirm'));
    expectSingleIntent(r.submit, { type: 'DISCARD', slot: 3 });
    expect(CARD.STAY).toBe(14);
  });
});

describe('DeathGodTargetDialog', () => {
  it('选对手 → DEATH_GOD_TARGET{seat}', async () => {
    const r = renderDialog(DeathGodTargetDialog, 'DEATH_GOD_TARGET');
    await r.user.click(screen.getByTestId('deathgod-seat-3'));
    await r.user.click(screen.getByTestId('deathgod-confirm'));
    expectSingleIntent(r.submit, { type: 'DEATH_GOD_TARGET', seat: 3 });
  });
});
