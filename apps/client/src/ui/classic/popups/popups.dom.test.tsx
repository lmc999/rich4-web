// 原版弹窗（client-dom，original-skin.md §4.2 通用、§5 A11）：
// - 演出弹窗按素材逐个判定：新闻板（含插图键）、命运板（插图表 0x473dd8，详见 ./eventCards.dom.test）、神明老虎机（滚动后
//   定格）、终局排名、出卡亮卡、魔法屋消息框；缺素材时整体用程序化弹窗；乐透开奖交给场所组的开关组件（不在经典舞台里时画
//   程序化弹窗）；
// - 事件后演出：FEE_PAID / COMPANY_FEE 的转盘种类与停格、月结名次；显示态日志推进时弹出，instant 不弹；
// - 工具列打开的原版界面：info 面板 → 原版资产表（翻页、切换玩家、EXIT）；托管设置 → 原版托管对话框（提交 game:autopilot）；
//   素材不可用时不接管；
// - PopupLayer 在经典布局（placement = board）里懒加载宿主。
import { CARD_IDS, type CardId, type GameEvent } from '@rich4/shared/engine';
import { CARD_SHOW_MS } from '@rich4/shared/view';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MotionGlobalConfig } from 'motion/react';
import type { ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientProvider } from '../../../app/services';
import { tx } from '../../../i18n/tx';
import { resetSkinStoreForTest } from '../../../skin/skinStore';
import { type LogLine, useGameStore } from '../../../store/gameStore';
import { useRoomStore } from '../../../store/roomStore';
import { useUiStore } from '../../../store/uiStore';
import { makeTestClient } from '../../../test/fakeTransport';
import { roomView } from '../../../test/roomFixtures';
import { fixture, installResizeObserver } from '../../decisions/testing';
import { PopupLayer } from '../../popups/PopupLayer';
import {
  type FatePopupSpec,
  type GameOverPopupSpec,
  type GodPopupSpec,
  type NewsPopupSpec,
  type OpenPopup,
  onPopupSkip,
  opensClassic,
  type PopupSpec,
  usePopupStore,
} from '../../popups/popupStore';
import { openTrusteeSettings, useTrusteeDialog } from '../../system/TrusteeSettings';
import { bindClassicAssets, classicImagePreloadStarted, resetClassicAssetsForTest, useClassicAssets } from '../assets';
import { atlasPackClient, type FakeFrame, fakeCardImages, installSceneAssets } from '../common/testing';
import { CardArt } from '../dialogs/parts';
import { a11FakeSheets, a11PackClient } from '../dialogs/testing';
import { ASSETS_KEYS } from './AssetSheet';
import { CARD_SHOW_LAYOUT, cardShowMode } from './CardCast';
import ClassicPopupHost, {
  CARD_ART_PREFETCH_CONCURRENCY,
  cardArtPrefetchOrder,
  classicPopupReady,
  popupKeys,
  prefetchCardArt,
} from './ClassicPopupHost';
import { eventPopupOf, monthlyRows, useEventPopups, wheelOf } from './eventPopups';
import { companyWheel, reelFrame, slotDigits, WHEELS, wheelFrameFor } from './layout';
import { requestClassicScreen } from './screenRequests';

installResizeObserver();

beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true;
});
afterAll(() => {
  MotionGlobalConfig.skipAnimations = false;
});

beforeEach(() => {
  installSceneAssets({ sprites: a11FakeSheets() });
  resetSkinStoreForTest({ client: a11PackClient() });
});

afterEach(() => {
  cleanup();
  act(() => {
    usePopupStore.getState().clear();
    useEventPopups.getState().clear();
    useUiStore.getState().clear();
    useGameStore.getState().clear();
    useTrusteeDialog.getState().setOpen(false);
  });
  resetClassicAssetsForTest();
  resetSkinStoreForTest();
});

const player = { seat: 0 as const, character: 9 as const, name: '孙小美' };

const news: NewsPopupSpec = {
  kind: 'news',
  id: 11,
  category: 1,
  categoryLabel: '政府公告',
  headline: '所得税',
  body: '全员缴纳现金的 5%。',
  affected: [{ ...player, deltas: [{ field: 'cash', delta: -500 }] }],
};

const fate: FatePopupSpec = {
  kind: 'fate',
  player,
  id: 25,
  title: '继承遗产',
  text: '远房亲戚留给你一笔遗产。',
  amountText: '+10,000',
  tone: 'good',
  blessingText: null,
};

const god: GodPopupSpec = {
  kind: 'god',
  god: 1,
  godName: '小财神',
  player,
  title: '小财神发威',
  line: '发财啦',
  good: true,
  slot: { digits: 3, value: 123 },
  amountText: '+246',
};

function open(spec: PopupSpec, ms = 1000): OpenPopup {
  let p: OpenPopup | null = null;
  act(() => {
    usePopupStore.getState().open(spec, ms, 200);
    p = usePopupStore.getState().current;
  });
  return p!;
}

function Host({ current }: { current: OpenPopup | null }): ReactNode {
  return (
    <ClassicPopupHost
      current={current}
      map={fixture().map}
      legacy={(p, body) => (
        <div data-testid="legacy-popup" data-kind={p.kind}>
          {body}
        </div>
      )}
    />
  );
}

describe('演出弹窗：原版 / 程序化逐个判定', () => {
  it('素材键：新闻带插图键、命运板带插图键（表 0x473dd8）、老虎机与神明小像、终局排名、亮卡、魔法屋消息框', () => {
    expect(popupKeys(open(news))).toEqual(['ui.newsBoard', 'illustration.news.11']);
    // 命运 25 → Data#458 → illustration.fate.22
    expect(popupKeys(open(fate))).toEqual(['ui.newsBoard', 'illustration.fate.22']);
    expect(popupKeys(open(god))).toEqual(['ui.godSlot', 'ui.common']);
    expect(popupKeys(open({ ...god, slot: null }))).toEqual(['ui.common', 'venue.assets.screen']);
    const cast = open({
      kind: 'cardCast',
      player,
      card: 17,
      cardName: '陷害卡',
      desc: '让对手立刻入狱',
      title: '使用卡片',
      targetText: '阿土伯',
      variant: 'cast',
    });
    expect(popupKeys(cast)).toEqual(['ui.common', 'card.17']);
    const magic = open({ kind: 'magic', caster: player, title: '魔法', line: '现金全部存入', targets: [] });
    expect(popupKeys(magic)).toEqual(['ui.common']);
    expect(classicPopupReady(magic)).toBe(true);
  });

  it('新闻：原版新闻板（data-news、插图框、打字机标题、受影响玩家），根元素 testid=popup 与 data-kind', () => {
    const p = open(news);
    render(<Host current={p} />);
    const scene = screen.getByTestId('popup');
    expect(scene).toHaveAttribute('data-scene', 'classic');
    expect(scene).toHaveAttribute('data-kind', 'news');
    const board = within(scene).getByTestId('news-popup');
    expect(board).toHaveAttribute('data-news', '11');
    expect(board.querySelector('[data-sprite="ui.newsBoard/0"]')).not.toBeNull();
    expect(within(board).getByTestId('news-headline')).toHaveTextContent('所得税');
    expect(within(board).getByTestId('news-affected')).toHaveTextContent('孙小美');
    expect(screen.queryByTestId('legacy-popup')).toBeNull();
  });

  it('新闻插图不在素材包里 → 整个弹窗用程序化版本', () => {
    const keys = Object.keys(a11FakeSheets());
    resetSkinStoreForTest({ client: a11PackClient(keys) });
    render(<Host current={open(news)} />);
    expect(screen.getByTestId('legacy-popup')).toHaveAttribute('data-kind', 'news');
    expect(screen.queryByTestId('news-popup')).toBeNull();
  });

  it('命运：原版命运板（紫板 + 插图），不再回退程序化翻面卡；插图不在素材包里才整体用程序化版本', () => {
    expect(classicPopupReady(open(fate))).toBe(true);
    const { unmount } = render(<Host current={open(fate)} />);
    const board = screen.getByTestId('fate-popup');
    expect(board.closest('[data-scene="classic"]')).not.toBeNull();
    expect(board.querySelector('[data-sprite="ui.newsBoard/1"]')).not.toBeNull();
    // 插图框（这里的假素材仓库没有绑定素材包客户端，整图取不到 URL，先画白框；取到时的画法见 eventCards.dom.test）
    expect(board.querySelector('[data-asset-key="illustration.fate.22"]')).not.toBeNull();
    expect(screen.queryByTestId('legacy-popup')).toBeNull();
    unmount();
    const keys = Object.keys(a11FakeSheets());
    resetSkinStoreForTest({ client: a11PackClient(keys) });
    render(<Host current={open(fate)} />);
    expect(screen.getByTestId('legacy-popup')).toHaveAttribute('data-kind', 'fate');
    expect(screen.queryByTestId('fate-art')).toBeNull();
  });

  it('老虎机：3 位机身，滚轮滚动后从左到右定格在 1 2 3；拉杆先下后上', async () => {
    render(<Host current={open(god, 1000)} />);
    const slot = screen.getByTestId('god-slot');
    expect(slot).toHaveAttribute('data-value', '123');
    expect(slot).toHaveAttribute('data-digits', '3');
    expect(slot.querySelector('[data-sprite="ui.godSlot/1"]')).not.toBeNull();
    await waitFor(() => expect(slot).toHaveAttribute('data-rolling', 'false'), { timeout: 3000 });
    const reels = [...slot.querySelectorAll('[data-sprite^="ui.godSlot/"]')].map((e) => e.getAttribute('data-sprite'));
    expect(reels).toEqual(
      expect.arrayContaining([
        `ui.godSlot/${reelFrame(1)}`,
        `ui.godSlot/${reelFrame(2)}`,
        `ui.godSlot/${reelFrame(3)}`,
      ]),
    );
    expect(reels).toContain('ui.godSlot/2');
    expect(screen.getByTestId('god-line')).toHaveTextContent('发财啦');
    expect(screen.getByTestId('god-amount')).toHaveTextContent('+246');
  });

  it('神明降临（不带老虎机）：神明小像 + 消息框', () => {
    render(<Host current={open({ ...god, god: 9, slot: null, amountText: null })} />);
    const pop = screen.getByTestId('god-popup');
    expect(pop).toHaveAttribute('data-god', '9');
    expect(pop.querySelector('[data-sprite="venue.assets.screen/21"]')).not.toBeNull();
  });

  it('终局：原版排名画面（over-rank-N、Q 版小人、总资产）', () => {
    const over: GameOverPopupSpec = {
      kind: 'gameOver',
      title: '游戏结束',
      subtitle: '孙小美 获胜',
      winner: player,
      rows: [
        {
          ...player,
          rank: 1,
          netWorth: 300000,
          alive: true,
          parts: { cash: 1, deposit: 1, stocks: 0, estate: 0, loan: 0 },
        },
        {
          seat: 1,
          character: 0,
          name: '约翰乔',
          rank: 2,
          netWorth: 0,
          alive: false,
          parts: { cash: 0, deposit: 0, stocks: 0, estate: 0, loan: 0 },
        },
      ],
    };
    render(<Host current={open(over)} />);
    const screenEl = screen.getByTestId('game-over-screen');
    expect(within(screenEl).getByTestId('over-rank-1')).toHaveAttribute('data-seat', '0');
    expect(within(screenEl).getByTestId('over-rank-2')).toHaveTextContent('已出局');
    expect(within(screenEl).getByTestId('over-rank-1-worth')).toHaveAttribute('data-value', '300000');
    expect(screenEl.querySelector('[data-sprite="venue.monthly.screen/74"]')).not.toBeNull();
  });

  it('出卡：原版卡片插画 + 消息框（出卡人与目标）', () => {
    render(
      <Host
        current={open({
          kind: 'cardCast',
          player,
          card: 17,
          cardName: '陷害卡',
          desc: '让对手立刻入狱',
          title: '使用卡片',
          targetText: '阿土伯',
          variant: 'fizzle',
        })}
      />,
    );
    const pop = screen.getByTestId('card-cast-popup');
    expect(pop.closest('[data-scene="classic"]')).not.toBeNull();
    expect(pop).toHaveAttribute('data-variant', 'fizzle');
    expect(pop).toHaveAttribute('data-mode', 'fizzle');
    expect(within(pop).getByTestId('card-cast-box')).toHaveTextContent('阿土伯');
    expect(within(pop).getByTestId('card-cast-line')).toHaveTextContent('孙小美');
    expect(within(pop).getByTestId('card-cast-line')).toHaveTextContent('陷害卡');
    // 卡片说明不上框（原版亮卡只有一句）
    expect(pop).not.toHaveTextContent('让对手立刻入狱');
  });

  it('魔法屋：宝石消息框（原版魔法屋的结果用通用消息框）；乐透开奖交给场所组的开关（不在经典舞台里 → 程序化）', () => {
    const { rerender } = render(
      <Host current={open({ kind: 'magic', caster: player, title: '魔法', line: 'x', targets: [] })} />,
    );
    const magic = screen.getByTestId('magic-popup');
    expect(magic.closest('[data-scene="classic"]')).toHaveAttribute('data-kind', 'magic');
    expect(magic.querySelector('[data-frame="ui.common/5"]')).not.toBeNull();
    expect(screen.queryByTestId('legacy-popup')).toBeNull();
    rerender(
      <Host current={open({ kind: 'lottery', title: '乐透开奖', number: 5, winner: null, subtitle: '无人中奖' })} />,
    );
    const legacy = screen.getByTestId('legacy-popup');
    expect(legacy).toHaveAttribute('data-kind', 'lottery');
    expect(within(legacy).getByTestId('lottery-popup')).toBeInTheDocument();
  });

  it('PopupLayer（经典布局 placement=board）懒加载宿主：新闻换成原版新闻板', async () => {
    render(<PopupLayer placement="board" auction={false} />);
    open(news);
    // 宿主模块加载完成之前先画程序化弹窗（Suspense fallback），加载后换成原版新闻板
    await waitFor(() =>
      expect(document.querySelector('[data-scene="classic"] [data-testid="news-popup"]')).not.toBeNull(),
    );
  });
});

// ───────────────────────── 事件后演出 ─────────────────────────

const fx = fixture();

function line(event: GameEvent, text = '日志'): LogLine {
  return { id: 0, seq: 1, type: event.type, text, date: 0, src: { event, view: fx.view } };
}

// ───────────────────────── 亮卡：卡片插画逐张 ─────────────────────────

/** a11 的假精灵表 → atlasPackClient 的帧表（经典外壳与弹窗的精灵走真实的图集加载路径） */
function a11Frames(): Record<string, FakeFrame[]> {
  const out: Record<string, FakeFrame[]> = {};
  for (const [k, sheet] of Object.entries(a11FakeSheets()))
    out[k] = sheet.frames.map((f) => [f!.w, f!.h, f!.ax, f!.ay]);
  return out;
}

/** 绑定一个带 30 张卡片插画（images/data/<529+k>.png）的假素材包，等弹窗要的 ui.common 加载完 */
async function bindCardPack(): Promise<ReturnType<typeof atlasPackClient>> {
  const client = atlasPackClient(a11Frames(), { images: fakeCardImages() });
  resetClassicAssetsForTest();
  act(() => bindClassicAssets(client, 'card-pack'));
  resetSkinStoreForTest({ client });
  await waitFor(() => expect(useClassicAssets.getState().sprites['ui.common']).toBeTruthy());
  return client;
}

function castSpec(card: CardId, variant: 'cast' | 'passive' | 'fizzle', targetText: string | null = null): PopupSpec {
  return {
    kind: 'cardCast',
    player,
    card,
    cardName: `卡${card}`,
    desc: '说明',
    title: '使用卡片',
    targetText,
    variant,
  };
}

describe('亮卡：卡片 id → 素材键 card.<k> → Data#(529+k) 的插画，30 张逐张（exe fcn.00440bac）', () => {
  it('素材键全表：出卡弹窗要 ui.common（消息框）与 card.<k>', () => {
    for (const k of CARD_IDS) expect(popupKeys(open(castSpec(k, 'cast')))).toEqual(['ui.common', `card.${k}`]);
  });

  it.each(CARD_IDS)(
    '卡 %i：原版画面，插画是 images/data/(529+k).png，不透明贴在 (138,200) 165×256，没有翻面动画',
    async (k) => {
      await bindCardPack();
      render(<Host current={open(castSpec(k, 'cast', '阿土伯'))} />);
      const pop = screen.getByTestId('card-cast-popup');
      expect(pop.closest('[data-classic="true"]')).not.toBeNull();
      expect(pop).toHaveAttribute('data-card', String(k));
      const art = within(pop).getByTestId('card-cast-art');
      expect(art).toHaveAttribute('data-asset-key', `card.${k}`);
      expect(art).toHaveAttribute('data-src', `/pack/images/data/${529 + k}.png`);
      expect(art.style.backgroundImage).toBe(`url("/pack/images/data/${529 + k}.png")`);
      expect([art.style.left, art.style.top, art.style.width, art.style.height]).toEqual([
        '138px',
        '200px',
        '165px',
        '256px',
      ]);
      expect(art.style.transform).toBe('');
      expect(art.style.filter).toBe('');
    },
  );

  it('版式：消息框 Data#476 图5 画在 (220,129)（左上 123,48，195×133），字以 (220,129) 为中心；插画在框下方', async () => {
    expect(CARD_SHOW_LAYOUT).toEqual({ box: { x: 220, y: 129 }, text: { x: 220, y: 129 }, card: { x: 138, y: 200 } });
    await bindCardPack();
    render(<Host current={open(castSpec(1, 'cast'))} />);
    const pop = screen.getByTestId('card-cast-popup');
    const frame = within(pop).getByTestId('card-cast-frame');
    expect(frame).toHaveAttribute('data-frame', 'ui.common/5');
    expect(frame).toHaveAttribute('data-slice', 'parts');
    expect([frame.style.left, frame.style.top, frame.style.width, frame.style.height]).toEqual([
      '123px',
      '48px',
      '195px',
      '133px',
    ]);
    const box = within(pop).getByTestId('card-cast-box');
    expect(box.style.top).toBe('129px');
    expect(box.style.transform).toBe('translateY(-50%)');
    // 框在插画上方（原版消息在上、卡在棋盘视窗下半部）：框底 181 < 卡顶 200
    expect(48 + 133).toBeLessThan(CARD_SHOW_LAYOUT.card.y);
    expect(within(pop).queryByTestId('card-cast-target')).toBeNull();
  });

  it('句式：出卡「使用XX」、免費卡「使用免費卡」、復仇 / 嫁禍 / 免罪「XX生效！」、没有效果置灰', async () => {
    expect(cardShowMode('cast', 6)).toBe('use');
    expect(cardShowMode('passive', 20)).toBe('use');
    for (const c of [18, 19, 21] as CardId[]) expect(cardShowMode('passive', c)).toBe('passive');
    expect(cardShowMode('fizzle', 16)).toBe('fizzle');
    await bindCardPack();
    const { rerender } = render(<Host current={open(castSpec(21, 'passive'))} />);
    let pop = screen.getByTestId('card-cast-popup');
    expect(pop).toHaveAttribute('data-mode', 'passive');
    expect(within(pop).getByTestId('card-cast-line').textContent).toBe(
      tx('events:popup.cardShow.passive', { who: player.name, card: '卡21' }),
    );
    rerender(<Host current={open(castSpec(20, 'passive'))} />);
    pop = screen.getByTestId('card-cast-popup');
    expect(within(pop).getByTestId('card-cast-line').textContent).toBe(
      tx('events:popup.cardShow.use', { who: player.name, card: '卡20' }),
    );
    rerender(<Host current={open(castSpec(16, 'fizzle'))} />);
    pop = screen.getByTestId('card-cast-popup');
    expect(within(pop).getByTestId('card-cast-art').style.filter).toContain('grayscale');
    expect(within(pop).getByTestId('card-cast-art')).toHaveAttribute('data-asset-key', 'card.16');
  });

  it('卡图下垫黑底：旧素材包（corner-rgb0）抠掉的 0 值像素显示成原版的纯黑，插画没下载完时是黑色卡位', async () => {
    await bindCardPack();
    render(<Host current={open(castSpec(10, 'cast'))} />);
    const art = within(screen.getByTestId('card-cast-popup')).getByTestId('card-cast-art');
    expect(art.style.backgroundColor).toBe('rgb(0, 0, 0)');
    await waitFor(() => expect(art.style.backgroundImage).toBe('url("/pack/images/data/539.png")'));
    expect(art.style.backgroundColor).toBe('rgb(0, 0, 0)');
    // 卡片欄悬停、免费卡、嫁祸卡、弃牌对话框里的插画（dialogs/parts 的 CardArt）同样垫黑
    cleanup();
    render(<CardArt card={20} x={0} y={0} testId="free-card-art" />);
    const small = await screen.findByTestId('free-card-art');
    expect(small.style.backgroundColor).toBe('rgb(0, 0, 0)');
    expect(small.style.backgroundImage).toBe('url("/pack/images/data/549.png")');
  });

  it('跳过照原版：不画「点一下跳过」钮、没有最短时间，任意鼠标左 / 右键放开或按键放开就结束；在输入框里打字、亮卡之前按下的不算', async () => {
    await bindCardPack();
    const input = document.createElement('input');
    document.body.appendChild(input);
    try {
      const p = open(castSpec(6, 'cast'), 1500);
      const onSkip = vi.fn();
      const off = onPopupSkip(p.popupId, onSkip);
      render(<Host current={p} />);
      const scene = screen.getByTestId('card-cast-popup').closest('[data-scene="classic"]')!;
      expect(scene).toHaveAttribute('data-skippable', 'true');
      expect(screen.queryByTestId('popup-skip')).toBeNull();
      // 亮卡出现之前就按下的（出卡确认那一下）：放开不算
      fireEvent.keyUp(document.body, { key: 'Enter', code: 'Enter' });
      fireEvent.pointerUp(document.body, { button: 0, pointerId: 1 });
      // 聊天框里打字：不跳过
      fireEvent.keyDown(input, { key: 'a', code: 'KeyA' });
      fireEvent.keyUp(input, { key: 'a', code: 'KeyA' });
      // 中键不算
      fireEvent.pointerDown(document.body, { button: 1, pointerId: 2 });
      fireEvent.pointerUp(document.body, { button: 1, pointerId: 2 });
      expect(onSkip).not.toHaveBeenCalled();
      // 页面上任意位置按下再放开左键 / 右键、任意按键
      fireEvent.pointerDown(document.body, { button: 0, pointerId: 3 });
      fireEvent.pointerUp(document.body, { button: 0, pointerId: 3 });
      fireEvent.pointerDown(document.body, { button: 2, pointerId: 4 });
      fireEvent.pointerUp(document.body, { button: 2, pointerId: 4 });
      fireEvent.keyDown(document.body, { key: ' ', code: 'Space' });
      fireEvent.keyUp(document.body, { key: ' ', code: 'Space' });
      expect(onSkip).toHaveBeenCalledTimes(3);
      off();
    } finally {
      input.remove();
    }
  });

  it('其他原版演出弹窗照旧：最短时间之后出现跳过钮，页面上的点击不跳过', async () => {
    const p = open(news, 1000);
    const onSkip = vi.fn();
    const off = onPopupSkip(p.popupId, onSkip);
    vi.useFakeTimers();
    try {
      render(<Host current={p} />);
      fireEvent.pointerDown(document.body, { button: 0, pointerId: 5 });
      fireEvent.pointerUp(document.body, { button: 0, pointerId: 5 });
      expect(onSkip).not.toHaveBeenCalled();
      expect(screen.queryByTestId('popup-skip')).toBeNull();
      act(() => {
        vi.advanceTimersByTime(p.minMs + 1);
      });
      expect(screen.getByTestId('popup-skip')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
      off();
    }
  });

  it('宿主登记判定（handler 的 opensClassic）与「正以原版画面显示」（toast 暂缓）', async () => {
    expect(opensClassic(castSpec(6, 'cast'))).toBe(false);
    await bindCardPack();
    const p = open(castSpec(6, 'cast'));
    const { unmount } = render(<Host current={p} />);
    // 素材就绪：会用原版画面；没有原版画面的种类（乐透开奖由场所组自己判定）不会
    expect(opensClassic(castSpec(6, 'cast'))).toBe(true);
    expect(opensClassic({ kind: 'lottery', title: '乐透', number: 1, winner: null, subtitle: '' })).toBe(false);
    expect(usePopupStore.getState().classicShown).toEqual({ popupId: p.popupId, kind: 'cardCast' });
    act(() => usePopupStore.getState().close(p.popupId));
    expect(usePopupStore.getState().classicShown).toBeNull();
    unmount();
    // 宿主卸载后注销
    expect(opensClassic(castSpec(6, 'cast'))).toBe(false);
  });

  it('亮卡时长：original 节奏按原版 1.5 秒，compact 1.2 秒', () => {
    expect(CARD_SHOW_MS.original.castMs).toBe(1500);
    expect(CARD_SHOW_MS.compact.castMs).toBe(1200);
  });
});

describe('卡片插画预取（亮卡只停 1.2–1.5 秒，不能等弹窗出现才下载）', () => {
  it('顺序：显示态里看得到的手牌在前（去重），其余按卡号；30 张一张不漏', () => {
    const view = {
      players: [
        { seat: 0, cards: [17, 3, 17] },
        { seat: 1, cards: null },
        { seat: 2, cards: [30] },
      ],
    } as unknown as Parameters<typeof cardArtPrefetchOrder>[0];
    const order = cardArtPrefetchOrder(view);
    expect(order.slice(0, 3)).toEqual([17, 3, 30]);
    expect([...order].sort((a, b) => a - b)).toEqual([...CARD_IDS]);
    expect(cardArtPrefetchOrder(null)).toEqual([...CARD_IDS]);
  });

  it('逐张下载素材包里 card.<k> 的文件（同一张只下一次），同时最多 2 张', async () => {
    const srcs: string[] = [];
    let inflight = 0;
    let peak = 0;
    const priorities: string[] = [];
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      decoding = 'auto';
      set fetchPriority(v: string) {
        priorities.push(v);
      }
      set src(v: string) {
        srcs.push(v);
        inflight++;
        peak = Math.max(peak, inflight);
        setTimeout(() => {
          inflight--;
          this.onload?.();
        }, 1);
      }
      decode(): Promise<void> {
        return Promise.resolve();
      }
    }
    vi.stubGlobal('Image', FakeImage);
    try {
      await bindCardPack();
      const order = cardArtPrefetchOrder(null);
      await prefetchCardArt(order, () => true);
      expect(srcs).toEqual(order.map((k) => `/pack/images/data/${529 + k}.png`));
      expect(peak).toBeLessThanOrEqual(CARD_ART_PREFETCH_CONCURRENCY);
      // 低优先级：不和棋盘、界面素材抢带宽
      expect(new Set(priorities)).toEqual(new Set(['low']));
      for (const k of CARD_IDS) expect(classicImagePreloadStarted(`card.${k}`)).toBe(true);
      await prefetchCardArt(order, () => true);
      expect(srcs).toHaveLength(30);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('宿主挂载后空闲时开始预取亮卡的消息框图集页与卡片插画（不等出卡）', async () => {
    await bindCardPack();
    render(<Host current={null} />);
    await waitFor(() => expect(classicImagePreloadStarted('card.1')).toBe(true), { timeout: 3000 });
    // ui.common 图集页（atlasPackClient 的页位图 = /pack/<键>.png）
    await waitFor(() => expect(classicImagePreloadStarted('url:/pack/ui.common.png')).toBe(true));
  });
});

describe('轮盘与月结（事件后演出）', () => {
  it('转盘种类：旅馆 / 购物中心看收费种类，航空 / 保险看行业；盘面停格与原版一致', () => {
    const fee = (feeKind: 'hotel' | 'mall' | 'gas', wheel: number | null) =>
      ({ type: 'FEE_PAID', payer: 1, lot: 'F1', feeKind, wheel, amount: 100 }) as unknown as GameEvent;
    expect(wheelOf(fee('hotel', 3))).toEqual({ wheel: 'hotel', value: 3, seat: 1 });
    expect(wheelOf(fee('mall', 6))).toEqual({ wheel: 'mall', value: 6, seat: 1 });
    expect(wheelOf(fee('gas', null))).toBeNull();
    const company = (industry: number, wheel: number | null) =>
      ({ type: 'COMPANY_FEE', seat: 2, company: 'C3', industry, amount: 0, wheel }) as unknown as GameEvent;
    expect(companyWheel(1)).toBe('airline');
    expect(companyWheel(4)).toBe('insurance');
    expect(companyWheel(3)).toBeNull();
    expect(wheelOf(company(1, 0))).toEqual({ wheel: 'airline', value: 0, seat: 2 });
    expect(wheelOf(company(4, 30))).toEqual({ wheel: 'insurance', value: 30, seat: 2 });
    // 图2 正上方是第 0 格；第 j 格转到正上方需要 (n−j)·12/n 帧
    expect(wheelFrameFor('hotel', 1)).toBe(2);
    expect(wheelFrameFor('hotel', 4)).toBe(5);
    expect(wheelFrameFor('mall', 5)).toBe(4);
    expect(wheelFrameFor('insurance', 30)).toBe(4);
    expect(wheelFrameFor('airline', 0)).toBe(2);
    expect(wheelFrameFor('airline', 9)).toBeNull();
    expect(WHEELS.hotel.key).toBe('ui.roulette.1');
    expect(slotDigits(7, 3)).toEqual([0, 0, 7]);
  });

  it('月结：按总资产排名；eventPopupOf 给出标题与冠军', () => {
    const rows = monthlyRows(
      [
        { seat: 0, netWorth: 100 },
        { seat: 1, netWorth: 300 },
      ],
      fx.view,
      (s) => `P${s + 1}`,
    );
    expect(rows.map((r) => [r.seat, r.rank])).toEqual([
      [1, 1],
      [0, 2],
    ]);
    const hit = eventPopupOf(
      line({
        type: 'MONTHLY_REPORT',
        rows: [{ seat: 0, netWorth: 5, loss: 0, gain: 0, interest: 0 }],
        champion: 0,
        tragic: null,
      } as unknown as GameEvent),
      tx,
      fx.map,
    );
    expect(hit?.spec.kind).toBe('monthly');
    if (hit?.spec.kind === 'monthly') expect(hit.spec.subtitle).toContain('本月冠军');
  });

  it('显示态日志推进时弹出轮盘（原版场景，停在结果上）；instant 时不弹', async () => {
    act(() => useGameStore.getState().resetTo({ epoch: 1, seq: 1, view: fx.view, pending: [], decision: null }));
    render(<Host current={null} />);
    const event = {
      type: 'FEE_PAID',
      payer: 0,
      lot: 'F1',
      feeKind: 'hotel',
      wheel: 4,
      amount: 300,
    } as unknown as GameEvent;
    act(() =>
      useGameStore
        .getState()
        .pushLog([{ seq: 2, type: 'FEE_PAID', text: '住宿 4 天', date: 0, src: { event, view: fx.view } }]),
    );
    const pop = await screen.findByTestId('roulette-popup');
    expect(pop).toHaveAttribute('data-wheel', 'hotel');
    expect(pop.closest('[data-testid="popup"]')).toHaveAttribute('data-kind', 'roulette');
    await waitFor(() => expect(pop).toHaveAttribute('data-done', 'true'), { timeout: 3000 });
    expect(pop).toHaveAttribute('data-frame', String(wheelFrameFor('hotel', 4)));
    act(() => useEventPopups.getState().clear());
    act(() => useGameStore.getState().setAnim({ playing: false, backlogMs: 0, speed: 1, instant: true }));
    act(() =>
      useGameStore
        .getState()
        .pushLog([{ seq: 3, type: 'FEE_PAID', text: 'x', date: 0, src: { event, view: fx.view } }]),
    );
    expect(screen.queryByTestId('roulette-popup')).toBeNull();
  });
});

// ───────────────────────── 工具列打开的原版界面 ─────────────────────────

function renderScreens() {
  const t = makeTestClient();
  act(() => {
    useGameStore.getState().resetTo({ epoch: 1, seq: 1, view: fx.view, pending: [], decision: null });
    useRoomStore.getState().setRoom(roomView({ phase: 'playing' }));
  });
  const utils = render(
    <ClientProvider client={t.client}>
      <Host current={null} />
    </ClientProvider>,
  );
  return { ...utils, ...t };
}

describe('资产表与托管设置（接管工具列）', () => {
  it('info 面板 → 原版资产表（程序化面板不出现）：三页、切换玩家、EXIT 关闭', async () => {
    renderScreens();
    act(() => useUiStore.getState().openPanel('info'));
    expect(useUiStore.getState().panel).toBeNull();
    const sheet = await screen.findByTestId('classic-assets');
    expect(sheet).toHaveAttribute('data-page', '0');
    const seat = Number(sheet.getAttribute('data-seat'));
    const me = fx.view.players.find((p) => p.seat === seat)!;
    expect(within(sheet).getByTestId('assets-cash')).toHaveAttribute('data-value', String(me.cash));
    await userEvent.click(within(sheet).getByTestId('assets-page-1'));
    expect(sheet).toHaveAttribute('data-page', '1');
    expect(within(sheet).getByTestId('assets-estate-head')).toBeInTheDocument();
    await userEvent.click(within(sheet).getByTestId('assets-page-2'));
    expect(within(sheet).getByTestId('assets-stock-head')).toBeInTheDocument();
    await userEvent.click(within(sheet).getByTestId('assets-next'));
    expect(sheet).not.toHaveAttribute('data-seat', String(seat));
    await userEvent.click(within(sheet).getByTestId('assets-exit'));
    await waitFor(() => expect(screen.queryByTestId('classic-assets')).toBeNull());
  });

  it('回归：资产表精灵还在加载（开局后预取未完成）→ 先收起程序化面板，精灵就绪后开原版资产表（不按早按晚二选一）', async () => {
    const sheets = a11FakeSheets();
    const frames = Object.fromEntries(
      ASSETS_KEYS.map((k) => [k, sheets[k]!.frames.map((f) => [f!.w, f!.h, f!.ax, f!.ay] as const)]),
    );
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    resetSkinStoreForTest({ client: atlasPackClient(frames, { gate }) });
    installSceneAssets({
      sprites: Object.fromEntries(
        Object.entries(sheets).filter(([k]) => !(ASSETS_KEYS as readonly string[]).includes(k)),
      ),
    });
    renderScreens();
    act(() => useUiStore.getState().openPanel('info'));
    expect(useUiStore.getState().panel).toBeNull();
    expect(screen.queryByTestId('classic-assets')).toBeNull();
    await act(async () => {
      release();
      await gate;
    });
    expect(await screen.findByTestId('classic-assets')).toBeInTheDocument();
    expect(useUiStore.getState().panel).toBeNull();
  });

  it('资产表精灵加载失败（或等不到）→ 照旧打开程序化 info 面板，不再接管这一次', async () => {
    const sheets = a11FakeSheets();
    const frames = Object.fromEntries(
      ASSETS_KEYS.map((k) => [k, sheets[k]!.frames.map((f) => [f!.w, f!.h, f!.ax, f!.ay] as const)]),
    );
    const client = atlasPackClient(frames);
    client.loadAtlas = () => Promise.reject(new Error('网络错误'));
    resetSkinStoreForTest({ client });
    installSceneAssets({ sprites: {} });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      renderScreens();
      act(() => useUiStore.getState().openPanel('info'));
      expect(useUiStore.getState().panel).toBeNull();
      await waitFor(() => expect(useUiStore.getState().panel).toBe('info'));
      expect(screen.queryByTestId('classic-assets')).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it('资产表素材不可用时不接管：info 面板照常打开', () => {
    resetSkinStoreForTest({
      client: a11PackClient(Object.keys(a11FakeSheets()).filter((k) => k !== 'venue.assets.screen')),
    });
    renderScreens();
    act(() => useUiStore.getState().openPanel('info'));
    expect(useUiStore.getState().panel).toBe('info');
    expect(screen.queryByTestId('classic-assets')).toBeNull();
  });

  it('托管设置 → 原版托管对话框：改个性、用卡、比例后「开始托管」发 game:autopilot{on, settings}', async () => {
    const { transport } = renderScreens();
    act(() => openTrusteeSettings());
    expect(useTrusteeDialog.getState().open).toBe(false);
    const dlg = await screen.findByTestId('trustee-dialog');
    expect(dlg).toHaveAttribute('data-classic', 'true');
    expect(within(dlg).getByTestId('trustee-status')).toHaveTextContent('未托管');
    await userEvent.click(within(dlg).getByTestId('trustee-personality-2'));
    const cards = within(dlg).getByTestId('trustee-cards');
    const was = cards.getAttribute('aria-pressed') === 'true';
    await userEvent.click(cards);
    fireEvent.change(within(dlg).getByTestId('trustee-cash'), { target: { value: '50' } });
    await userEvent.click(within(dlg).getByTestId('trustee-stock-inc'));
    expect(within(dlg).getByTestId('trustee-cash-value')).toHaveTextContent('50%');
    await userEvent.click(within(dlg).getByTestId('trustee-on'));
    const sent = transport.payloads('game:autopilot');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ on: true, settings: { personality: 2, useCards: !was, cashRatio: 50 } });
    await waitFor(() => expect(screen.queryByTestId('trustee-dialog')).toBeNull());
  });

  it('工具列 SAVE / LOAD → 原版风格的存读档窗（经典外壳自己的存读档窗不出现）', async () => {
    const t = makeTestClient();
    act(() => {
      useGameStore.getState().resetTo({ epoch: 1, seq: 1, view: fx.view, pending: [], decision: null });
      useRoomStore.getState().setRoom(roomView({ phase: 'playing' }));
    });
    let legacyOpened = 0;
    // 与 ClassicLayout 的 onTool('save') 相同：先请求原版界面，没有接管才开程序化窗
    render(
      <ClientProvider client={t.client}>
        <div data-testid="classic-stage">
          <button
            type="button"
            data-tool="save"
            data-testid="tool-save"
            onClick={() => {
              if (!requestClassicScreen({ k: 'saves', mode: 'save' })) legacyOpened++;
            }}
          >
            SAVE
          </button>
        </div>
        <Host current={null} />
      </ClientProvider>,
    );
    await userEvent.click(screen.getByTestId('tool-save'));
    expect(legacyOpened).toBe(0);
    const win = await screen.findByTestId('classic-saves');
    expect(win).toHaveAttribute('data-classic', 'true');
    expect(win).toHaveAttribute('data-mode', 'save');
    expect(win.querySelector('[data-sprite="ui.saveLoad/1"]')).not.toBeNull();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('classic-saves')).toBeNull());
  });
});
