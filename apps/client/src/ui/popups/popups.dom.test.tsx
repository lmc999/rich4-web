// 演出弹窗渲染（client-dom）：NewsPopup / FatePopup / GameOverScreen / 出卡 / 神明 / 乐透 / 魔法屋、弹窗层的跳过、
// 公开竞价横幅，以及 HUD 的 GodBadge / StatusBadges。
import type { GameView, PendingView, PlayerView } from '@rich4/shared/view';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useGameStore } from '../../store/gameStore';
import { GodBadge } from '../hud/GodBadge';
import { StatusBadges, statusBadges } from '../hud/StatusBadges';
import { CardCastPopup } from './CardCastPopup';
import { FatePopup } from './FatePopup';
import { GameOverScreen } from './GameOverScreen';
import { GodArrivePopup } from './GodArrivePopup';
import { LotteryDrawPopup } from './LotteryDrawPopup';
import { MagicPopup } from './MagicPopup';
import { NewsPopup } from './NewsPopup';
import { PopupLayer } from './PopupLayer';
import {
  type FatePopupSpec,
  type GameOverPopupSpec,
  type NewsPopupSpec,
  onPopupSkip,
  type PlayerRef,
  usePopupStore,
} from './popupStore';

const P0: PlayerRef = { seat: 0, character: 9, name: '孙小美' };
const P1: PlayerRef = { seat: 1, character: 4, name: '阿土伯' };

afterEach(() => {
  act(() => usePopupStore.getState().clear());
  vi.useRealTimers();
});

const news: NewsPopupSpec = {
  kind: 'news',
  id: 8,
  category: 1,
  categoryLabel: '政府公告',
  headline: '公开表扬第一大地主\n孙小美获得10000元奖励',
  affected: [{ ...P0, deltas: [{ field: 'cash', delta: 10000 }] }],
};

describe('NewsPopup', () => {
  it('主播、分类、原文标题（读屏完整，两行）与受影响玩家', () => {
    render(<NewsPopup spec={news} />);
    const root = screen.getByTestId('news-popup');
    expect(root).toHaveAttribute('data-news', '8');
    expect(screen.getByRole('img', { name: '新闻主播' })).toBeInTheDocument();
    expect(within(root).getByText(/政府公告/)).toBeInTheDocument();
    expect(screen.getByTestId('news-headline').textContent).toBe('公开表扬第一大地主\n孙小美获得10000元奖励');
    expect(screen.queryByTestId('news-body')).toBeNull();
    const affected = screen.getByTestId('news-affected');
    expect(within(affected).getByText('孙小美')).toBeInTheDocument();
    expect(within(affected).getByText(/\+10,000/)).toBeInTheDocument();
  });

  it('税 / 储金红利：原版的逐人行代替名字与金额变化', () => {
    render(
      <NewsPopup
        spec={{
          ...news,
          id: 11,
          headline: '所有人缴交所得税５％',
          affected: [{ ...P0, deltas: [], line: '孙小美缴交1234元' }],
        }}
      />,
    );
    const affected = screen.getByTestId('news-affected');
    expect(within(affected).getByText('孙小美缴交1234元')).toBeInTheDocument();
  });

  it('经弹窗层打开：data-news 是新闻编号，不被弹窗实例号覆盖', () => {
    render(<PopupLayer />);
    act(() => {
      usePopupStore
        .getState()
        .open({ kind: 'news', id: 1, category: 0, categoryLabel: '无责任新闻', headline: 'x', affected: [] }, 1000);
      usePopupStore.getState().open({ ...news, id: 11 }, 1000);
    });
    expect(screen.getByTestId('news-popup')).toHaveAttribute('data-news', '11');
  });

  it('打字机：标题逐字出现，最后完整显示', () => {
    vi.useFakeTimers();
    const { container } = render(<NewsPopup spec={{ ...news, affected: [] }} ms={3400} />);
    const visual = () => container.querySelector('[aria-hidden="true"]')?.textContent ?? '';
    expect(visual().replace('▌', '')).toBe('');
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(visual()).toBe('公开表扬第一大地主\n孙小美获得10000元奖励');
  });
});

describe('FatePopup', () => {
  const fate: FatePopupSpec = {
    kind: 'fate',
    player: P1,
    id: 25,
    title: '继承遗产',
    text: '意外获得遗产10000元',
    textAmount: '10000',
    amountText: '+10,000',
    tone: 'good',
    blessingText: '财运亨通，奖金加倍！',
  };

  it('卡片正面：标题、内容、金额、加持；背面是问号', () => {
    render(<FatePopup spec={fate} />);
    const root = screen.getByTestId('fate-popup');
    expect(root).toHaveAttribute('data-tone', 'good');
    expect(within(root).getByRole('heading', { name: '继承遗产' })).toBeInTheDocument();
    expect(screen.getByTestId('fate-text')).toHaveTextContent('意外获得遗产10000元');
    expect(screen.getByTestId('fate-amount')).toHaveTextContent('+10,000');
    expect(screen.getByTestId('fate-blessing')).toHaveTextContent('财运亨通');
    expect(within(root).getByText('阿土伯')).toBeInTheDocument();
  });

  it('没有金额与加持时不显示', () => {
    render(<FatePopup spec={{ ...fate, amountText: null, blessingText: null, tone: 'bad' }} />);
    expect(screen.queryByTestId('fate-amount')).toBeNull();
    expect(screen.queryByTestId('fate-blessing')).toBeNull();
  });
});

describe('GameOverScreen', () => {
  const spec: GameOverPopupSpec = {
    kind: 'gameOver',
    title: '游戏结束',
    subtitle: '孙小美 获胜',
    winner: P0,
    rows: [
      {
        ...P0,
        rank: 1,
        netWorth: 500000,
        alive: true,
        parts: { cash: 100000, deposit: 200000, stocks: 50000, estate: 150000, loan: 0 },
      },
      {
        ...P1,
        rank: 2,
        netWorth: 20000,
        alive: false,
        parts: { cash: 0, deposit: 30000, stocks: 0, estate: 0, loan: 10000 },
      },
    ],
  };

  it('排名、总资产、资产构成条与图例；有烟花', () => {
    render(<GameOverScreen spec={spec} />);
    expect(screen.getByRole('heading', { name: /游戏结束/ })).toBeInTheDocument();
    expect(screen.getByText('孙小美 获胜')).toBeInTheDocument();
    const first = screen.getByTestId('over-rank-1');
    expect(first).toHaveAttribute('data-seat', '0');
    expect(within(first).getByText('500,000')).toBeInTheDocument();
    const bar = screen.getByTestId('over-parts-0');
    expect(bar).toHaveAccessibleName(/现金 100,000/);
    expect(bar.querySelectorAll('[data-part]')).toHaveLength(4);
    const second = screen.getByTestId('over-rank-2');
    expect(within(second).getByText(/已出局/)).toBeInTheDocument();
    expect(screen.getByTestId('over-parts-1')).toHaveAccessibleName(/贷款 -10,000/);
    expect(screen.getByTestId('fireworks')).toBeInTheDocument();
  });

  it('可以放入操作按钮、关掉烟花', () => {
    render(<GameOverScreen spec={spec} fireworks={false} actions={<button type="button">再来一局</button>} />);
    expect(screen.getByRole('button', { name: '再来一局' })).toBeInTheDocument();
    expect(screen.queryByTestId('fireworks')).toBeNull();
  });
});

describe('其他弹窗', () => {
  it('CardCastPopup：卡名、说明、出卡人与目标', () => {
    render(
      <CardCastPopup
        spec={{
          kind: 'cardCast',
          player: P0,
          card: 17,
          cardName: '陷害卡',
          desc: '让对手立刻入狱 5 天。',
          title: '孙小美 使用卡片',
          targetText: '阿土伯',
          variant: 'cast',
        }}
      />,
    );
    const root = screen.getByTestId('card-cast-popup');
    expect(within(root).getByText('陷害卡')).toBeInTheDocument();
    expect(within(root).getByText('目标：阿土伯')).toBeInTheDocument();
  });

  it('GodArrivePopup：台词与老虎机（滚动后定格、补零）', () => {
    vi.useFakeTimers();
    render(
      <GodArrivePopup
        spec={{
          kind: 'god',
          god: 6,
          godName: '大穷神',
          player: P0,
          title: '大穷神 发威',
          line: '大穷神发威，家财散去！',
          good: false,
          slot: { digits: 5, value: 3721 },
          amountText: '-3,721',
        }}
        ms={2750}
      />,
    );
    expect(screen.getByTestId('god-line')).toHaveTextContent('家财散去');
    expect(screen.getByTestId('god-slot')).toHaveAttribute('data-rolling', 'true');
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByTestId('god-slot')).toHaveAttribute('data-rolling', 'false');
    expect(screen.getByTestId('god-slot')).toHaveTextContent('03721');
  });

  it('LotteryDrawPopup：摇奖后显示号码与中奖人', () => {
    vi.useFakeTimers();
    render(
      <LotteryDrawPopup
        spec={{ kind: 'lottery', title: '乐透开奖', number: 12, winner: P1, subtitle: '开出 12 号：阿土伯 独得' }}
        ms={2800}
      />,
    );
    expect(screen.queryByTestId('lottery-number')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByTestId('lottery-number')).toHaveTextContent('12');
    expect(screen.getByTestId('lottery-subtitle')).toHaveTextContent('阿土伯');
  });

  it('MagicPopup：名单为空时提示', () => {
    render(<MagicPopup spec={{ kind: 'magic', caster: P0, title: '魔法屋', line: '女巫念出条件', targets: [] }} />);
    expect(screen.getByText('没有人符合条件')).toBeInTheDocument();
  });
});

describe('PopupLayer', () => {
  it('显示当前弹窗；最短展示时间后出现「跳过」，点击通知 handler', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<PopupLayer />);
    expect(screen.queryByTestId('popup')).toBeNull();
    let id = 0;
    act(() => {
      id = usePopupStore.getState().open(news, 3400, 500);
    });
    expect(screen.getByTestId('popup')).toHaveAttribute('data-kind', 'news');
    expect(screen.queryByTestId('popup-skip')).toBeNull();
    const skipped = vi.fn();
    const off = onPopupSkip(id, skipped);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    await user.click(screen.getByTestId('popup-skip'));
    expect(skipped).toHaveBeenCalledTimes(1);
    off();
    act(() => usePopupStore.getState().close(id));
    expect(screen.queryByTestId('popup')).toBeNull();
  });

  it('3 倍速打开的乐透弹窗：内部滚号按真实寿命（ms ÷ 3）缩短，关闭前号码、中奖人与跳过都能出现', () => {
    vi.useFakeTimers();
    render(<PopupLayer />);
    let id = 0;
    act(() => {
      id = usePopupStore
        .getState()
        .open(
          { kind: 'lottery', title: '乐透开奖', number: 12, winner: P1, subtitle: '开出 12 号：阿土伯 独得' },
          2800,
          1600,
          3,
        );
    });
    expect(usePopupStore.getState().current).toMatchObject({ realMs: 2800 / 3, minMs: 1600 / 3 });
    expect(screen.queryByTestId('lottery-number')).toBeNull();
    // 弹窗按动画时钟 2800ms、3 倍速 ≈ 933ms 真实时间后关闭：此前号码、字幕与跳过都已出现
    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(screen.getByTestId('lottery-number')).toHaveTextContent('12');
    expect(screen.getByTestId('lottery-subtitle')).toHaveTextContent('阿土伯');
    expect(screen.getByTestId('popup-skip')).toBeInTheDocument();
    act(() => usePopupStore.getState().close(id));
  });

  it('公开竞价横幅：有拍卖决策或演出进行中才显示，否则自动收起', () => {
    render(<PopupLayer />);
    act(() => {
      useGameStore.getState().setAnim({ playing: true, backlogMs: 0, speed: 1, instant: false });
      usePopupStore.getState().setAuction({
        lot: 'L1',
        lotName: '测试一路',
        sellerName: null,
        start: 2000,
        price: 2600,
        leader: P1,
        bidders: [
          { ...P0, state: 'active' },
          { ...P1, state: 'quit' },
        ],
        result: null,
        tick: 1,
      });
    });
    expect(screen.getByTestId('auction-banner')).toHaveTextContent('测试一路');
    expect(screen.getByTestId('auction-price')).toHaveTextContent('2,600');
    expect(screen.getByText('领先：阿土伯')).toBeInTheDocument();
    act(() => {
      useGameStore.getState().setAnim({ playing: false, backlogMs: 0, speed: 1, instant: false });
    });
    expect(screen.queryByTestId('auction-banner')).toBeNull();
    expect(usePopupStore.getState().auction).toBeNull();
  });

  it('公开竞价横幅：没有经过演出（后台标签页 / instant / 刷新）时按待决策补一条', () => {
    const view = {
      players: [
        { seat: 0, character: 9 },
        { seat: 1, character: 4 },
      ],
    } as unknown as GameView;
    const bid = (seat: 0 | 1): PendingView => ({
      decisionId: `d${seat}`,
      seat,
      kind: 'AUCTION_BID',
      timing: 'auction',
      deadlineAt: null,
      control: 'human',
      publicInfo: { kind: 'AUCTION_BID', seat, lot: 'L1', amount: 3500, labelKey: null },
    });
    render(<PopupLayer />);
    act(() => {
      useGameStore.getState().setAnim({ playing: false, backlogMs: 0, speed: 1, instant: true });
      useGameStore.getState().commitView(view);
      useGameStore.getState().commitPending([bid(0), bid(1)], null);
    });
    const b = screen.getByTestId('auction-banner');
    expect(b).toHaveAttribute('data-derived', 'true');
    expect(screen.getByTestId('auction-price')).toHaveTextContent('3,500');
    expect(b).toHaveTextContent('竞价中');
    act(() => useGameStore.getState().commitPending([], null));
    expect(screen.queryByTestId('auction-banner')).toBeNull();
  });
});

describe('HUD 徽章', () => {
  const player = {
    seat: 1,
    god: { kind: 2, days: 4 },
    st: { hotel: 0, away: 0, jail: 3, hospital: 0, hibernate: 0x80, sleepwalk: 0, stay: 0, tortoise: 0 },
    bankReject: 0,
    insuranceDays: 0,
    bomb: { fuse: 12 },
    alliance: { seat: 0, days: 5 },
    loan: 0,
    loanDue: 0,
  } as unknown as PlayerView;

  it('GodBadge：名字与天数', () => {
    render(<GodBadge kind={2} days={4} total={5} />);
    const b = screen.getByTestId('god-badge');
    expect(b).toHaveAttribute('data-days', '4');
    expect(b).toHaveTextContent('大财神');
  });

  it('StatusBadges：两段式计数器按显示天数，含炸弹与同盟', () => {
    expect(statusBadges(player).map((x) => [x.key, x.n])).toEqual([
      ['jail', 4],
      ['hibernate', 1],
      ['bomb', 12],
      ['alliance', 5],
    ]);
    render(<StatusBadges player={player} nameOf={() => '孙小美'} />);
    const root = screen.getByTestId('status-badges-1');
    expect(within(root).getByTestId('god-badge')).toBeInTheDocument();
    expect(root.querySelector('[data-status="jail"]')).toHaveTextContent('坐牢 4 天');
    expect(root.querySelector('[data-status="bomb"]')).toHaveTextContent('12');
    expect(root.querySelector('[data-status="alliance"]')).toHaveTextContent('孙小美');
  });
});
