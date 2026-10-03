// 随机事件的原版画面（client-dom）：命运板（Panel#66 图1 + 命运插图表 exe 0x473dd8 选的插图 + 表情头像，加持消息框）、
// 卡片格 / 聖誕節得卡亮卡（卡片插画 + 宝石消息框；私密手牌下别人只有消息框）、魔法屋消息框，以及空闲预取（新闻 / 命运板
// 图集页与插图）。每类弹窗断言用到的素材键与帧、插图文件与画点。
import type { CardId } from '@rich4/shared/engine';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import type { ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { tx } from '../../../i18n/tx';
import { resetSkinStoreForTest } from '../../../skin/skinStore';
import { fixture, installResizeObserver } from '../../decisions/testing';
import {
  type CardCastPopupSpec,
  type FatePopupSpec,
  type MagicPopupSpec,
  type OpenPopup,
  onPopupSkip,
  type PopupSpec,
  usePopupStore,
} from '../../popups/popupStore';
import { bindClassicAssets, classicImagePreloadStarted, resetClassicAssetsForTest, useClassicAssets } from '../assets';
import { atlasPackClient, type FakeFrame, fakeCardImages, fakeFateImages, fakeNewsImages } from '../common/testing';
import { a11FakeSheets } from '../dialogs/testing';
import { shouldHandleHotkey } from '../keyboard';
import { cardShowMode } from './CardCast';
import ClassicPopupHost, { boardShield, fateArtPrefetchKeys, NEWS_ART_KEYS, popupKeys } from './ClassicPopupHost';
import { fateBodySize } from './FateBoard';
import { FATE_ART_TABLE, FATE_BOARD, FATE_FACE, fateArtKey } from './layout';

installResizeObserver();

beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true;
});
afterAll(() => {
  MotionGlobalConfig.skipAnimations = false;
});

afterEach(() => {
  cleanup();
  act(() => usePopupStore.getState().clear());
  resetClassicAssetsForTest();
  resetSkinStoreForTest();
});

const player = { seat: 0 as const, character: 9 as const, name: '孙小美' };

function open(spec: PopupSpec, ms = 1500): OpenPopup {
  let p: OpenPopup | null = null;
  act(() => {
    usePopupStore.getState().open(spec, ms, 0);
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

/** a11 的假精灵表 → atlasPackClient 的帧表 */
function a11Frames(): Record<string, FakeFrame[]> {
  const out: Record<string, FakeFrame[]> = {};
  for (const [k, sheet] of Object.entries(a11FakeSheets()))
    out[k] = sheet.frames.map((f) => [f!.w, f!.h, f!.ax, f!.ay]);
  return out;
}

/** 绑定一个带卡片插画、新闻插图、命运插图（images/data/<res>.png）的假素材包，等板面与消息框的精灵就绪 */
async function bindPack(): Promise<void> {
  const client = atlasPackClient(a11Frames(), {
    images: { ...fakeCardImages(), ...fakeNewsImages(), ...fakeFateImages() },
  });
  resetClassicAssetsForTest();
  act(() => bindClassicAssets(client, 'event-pack'));
  resetSkinStoreForTest({ client });
  // 宿主空闲预取会把 ui.common / ui.newsBoard 载入仓库；测试里直接等它们
  render(<Host current={null} />);
  await waitFor(() => {
    const s = useClassicAssets.getState().sprites;
    expect(s['ui.common']).toBeTruthy();
    expect(s['ui.newsBoard']).toBeTruthy();
  });
  cleanup();
}

const fate = (id: number, slot = id, extra: Partial<FatePopupSpec> = {}): FatePopupSpec => ({
  kind: 'fate',
  player,
  id,
  slot,
  phase: 'board',
  title: '继承遗产',
  text: '远房亲戚留给孙小美一笔遗产：10,000 元。',
  amountText: '+10,000',
  tone: 'good',
  blessingText: null,
  ...extra,
});

// ───────────────────────── 命运板 ─────────────────────────

describe('命运插图表（exe 0x473dd8）与表情表', () => {
  it('49 项；k<33 用表[k]，33–36 按地图：台湾 464–467、大陆 464/468/469/470、日本 471/465/466/472、美国 473/474/469/475', () => {
    expect(FATE_ART_TABLE).toHaveLength(49);
    expect(FATE_FACE).toHaveLength(49);
    expect(new Set(FATE_ART_TABLE).size).toBe(40);
    expect(Math.min(...FATE_ART_TABLE)).toBe(436);
    expect(Math.max(...FATE_ART_TABLE)).toBe(475);
    const byMap = [0, 1, 2, 3].map((gm) => [0, 1, 2, 3].map((j) => FATE_ART_TABLE[33 + 4 * gm + j]));
    expect(byMap).toEqual([
      [464, 465, 466, 467],
      [464, 468, 469, 470],
      [471, 465, 466, 472],
      [473, 474, 469, 475],
    ]);
    // 同一张插图被多条命运共用（20–22 撿錢、23–24 錢包、27–29 發票）
    expect([20, 21, 22].map((k) => FATE_ART_TABLE[k])).toEqual([456, 456, 456]);
    expect(fateArtKey(0)).toBe('illustration.fate.0');
    expect(fateArtKey(48)).toBe('illustration.fate.39');
    // 表情：图1–4；33–36 都是图3
    for (const f of FATE_FACE) expect([1, 2, 3, 4]).toContain(f);
    for (let s = 33; s < 49; s++) expect(FATE_FACE[s]).toBe(3);
  });

  it.each(Array.from({ length: 49 }, (_, s) => s))('slot %i：素材键 = 板面 + 插图表选的那一张', (slot) => {
    const id = slot < 33 ? slot : 33 + ((slot - 33) % 4);
    expect(popupKeys(fate(id, slot))).toEqual(['ui.newsBoard', `illustration.fate.${FATE_ART_TABLE[slot]! - 436}`]);
  });

  it('加持段只要宝石消息框；缺省 slot = 命运编号', () => {
    expect(popupKeys(fate(25, 25, { phase: 'blessing', blessingText: '财神保佑' }))).toEqual(['ui.common']);
    const { slot: _s, ...noSlot } = fate(25);
    expect(popupKeys(noSlot as FatePopupSpec)).toEqual(['ui.newsBoard', 'illustration.fate.22']);
  });
});

describe('命运板画面', () => {
  it('Panel#66 图1 贴 (0,0)；插图是 images/data/<表值>.png 不透明贴 (25,44) 388×251；标题 28px 在 (24,330)；头像图 FATE_FACE 画在 (390,344)', async () => {
    await bindPack();
    // 日本图第 35 条 → slot 43 → Data#466
    render(<Host current={open(fate(35, 43, { title: '走私被查獲', amountText: null, tone: 'bad' }))} />);
    const board = screen.getByTestId('fate-popup');
    expect(board.closest('[data-classic="true"]')).toHaveAttribute('data-kind', 'fate');
    expect(board).toHaveAttribute('data-fate', '35');
    expect(board).toHaveAttribute('data-slot', '43');
    const sheet = within(board).getByTestId('fate-board');
    expect(sheet).toHaveAttribute('data-sprite', 'ui.newsBoard/1');
    expect([sheet.style.left, sheet.style.top, sheet.style.width, sheet.style.height]).toEqual([
      '0px',
      '0px',
      '440px',
      '480px',
    ]);
    // 板面下垫黑（原版 fcn.00454a55 整张不透明拷贝；素材包抠掉的 RGB 0 像素原版是黑色，不能透出棋盘）
    const under = sheet.previousElementSibling as HTMLElement;
    expect([under.style.width, under.style.height, under.style.background]).toEqual(['440px', '480px', 'rgb(0, 0, 0)']);
    const art = within(board).getByTestId('fate-art');
    expect(art).toHaveAttribute('data-asset-key', 'illustration.fate.30');
    expect(art.style.backgroundImage).toBe('url("/pack/images/data/466.png")');
    expect([art.style.left, art.style.top, art.style.width, art.style.height]).toEqual([
      '25px',
      '44px',
      '388px',
      '251px',
    ]);
    const title = within(board).getByTestId('fate-title');
    expect(title).toHaveTextContent('走私被查獲');
    expect([title.style.left, title.style.top, title.style.fontSize]).toEqual(['24px', '330px', '28px']);
    expect(title.style.color).toBe('rgb(240, 240, 240)');
    expect(title.style.letterSpacing).toBe('-1px');
    // 讲话头像 portrait.speaker.9 的图3（34×34，锚点 17,17 → 左上 373,327）
    const face = await within(board).findByTestId('fate-face');
    expect(face).toHaveAttribute('data-sprite', 'portrait.speaker.9/3');
    expect([face.style.left, face.style.top]).toEqual(['373px', '327px']);
    expect(within(board).queryByTestId('fate-amount')).toBeNull();
    expect(screen.queryByTestId('legacy-popup')).toBeNull();
  });

  it('正文与金额在标题下方、头像左侧；字色可读（#F0F0F0 + #101010 阴影），金额按正负上色', async () => {
    await bindPack();
    render(<Host current={open(fate(25))} />);
    const board = screen.getByTestId('fate-popup');
    const text = within(board).getByTestId('fate-text');
    const body = text.parentElement!;
    expect([body.style.left, body.style.top, body.style.width]).toEqual([
      `${FATE_BOARD.body.x}px`,
      `${FATE_BOARD.body.y}px`,
      `${FATE_BOARD.body.w}px`,
    ]);
    expect(FATE_BOARD.body.x + FATE_BOARD.body.w).toBeLessThan(FATE_BOARD.face.x - 17);
    expect(body.style.color).toBe('rgb(240, 240, 240)');
    expect(body.style.textShadow).toMatch(/#101010|rgb\(16, 16, 16\)/);
    expect(within(board).getByTestId('fate-amount')).toHaveTextContent('+10,000');
    expect(fateBodySize('短句', true)).toBe(20);
    expect(fateBodySize('一'.repeat(60), true)).toBe(16);
  });

  it('插图还没取到 URL 时画原版的白框（不回退程序化翻面卡）', async () => {
    const client = atlasPackClient(a11Frames(), { images: fakeCardImages() });
    // 素材包里有命运插图条目，但这个客户端取不到文件 URL（模拟加载慢）
    const usable = client.usableEntry.bind(client);
    client.usableEntry = (k: string) =>
      k.startsWith('illustration.fate.')
        ? ({ type: 'image', group: 'illustration.fate', confidence: 'exe', file: '', w: 388, h: 251 } as never)
        : usable(k);
    client.fileUrl = (lp: string) => (lp ? `/pack/${lp}` : (null as never));
    resetClassicAssetsForTest();
    act(() => bindClassicAssets(client, 'slow-pack'));
    resetSkinStoreForTest({ client });
    render(<Host current={null} />);
    await waitFor(() => expect(useClassicAssets.getState().sprites['ui.newsBoard']).toBeTruthy());
    cleanup();
    render(<Host current={open(fate(0))} />);
    const board = screen.getByTestId('fate-popup');
    expect(within(board).getByTestId('fate-art-blank')).toHaveAttribute('data-asset-key', 'illustration.fate.0');
  });

  it('加持消息框：宝石消息框 Data#476 图5 画在 (220,129)，写加持文案', async () => {
    await bindPack();
    render(<Host current={open(fate(25, 25, { phase: 'blessing', blessingText: '财神保佑，奖金加倍！' }))} />);
    const pop = screen.getByTestId('fate-popup');
    expect(pop).toHaveAttribute('data-phase', 'blessing');
    expect(within(pop).getByTestId('fate-blessing')).toHaveTextContent('财神保佑，奖金加倍！');
    const frame = within(pop).getByTestId('fate-blessing-box-frame');
    expect(frame).toHaveAttribute('data-frame', 'ui.common/5');
    expect([frame.style.left, frame.style.top]).toEqual(['123px', '48px']);
    expect(pop.querySelector('[data-sprite^="ui.newsBoard"]')).toBeNull();
  });

  it('跳过照原版（fcn.00452c39 没有最短时间）：不画跳过钮，任意鼠标键 / 按键放开就结束', async () => {
    await bindPack();
    const p = open(fate(3), 3000);
    const onSkip = vi.fn();
    const off = onPopupSkip(p.popupId, onSkip);
    render(<Host current={p} />);
    const scene = screen.getByTestId('fate-popup').closest('[data-scene="classic"]')!;
    expect(scene).toHaveAttribute('data-skippable', 'true');
    expect(screen.queryByTestId('popup-skip')).toBeNull();
    fireEvent.pointerDown(document.body, { button: 0, pointerId: 7 });
    fireEvent.pointerUp(document.body, { button: 0, pointerId: 7 });
    expect(onSkip).toHaveBeenCalledTimes(1);
    off();
  });

  it('板面 440×480 接住指针（命运板盖着工具列）：点板子只跳过、不往下传，右键不弹菜单；板子期间经典快捷键暂停', async () => {
    await bindPack();
    const p = open(fate(3), 3000);
    const onSkip = vi.fn();
    const off = onPopupSkip(p.popupId, onSkip);
    onTestFinished(off);
    // 板子下面的东西（真实画面里是工具列、棋盘）：React 祖先与窗口上的冒泡监听都不该收到
    const below = vi.fn();
    const onWindow = vi.fn();
    for (const t of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click'] as const)
      window.addEventListener(t, onWindow);
    onTestFinished(() => {
      for (const t of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click'] as const)
        window.removeEventListener(t, onWindow);
    });
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: 测试替身（模拟板子下面会响应点击的元素）
      // biome-ignore lint/a11y/useKeyWithClickEvents: 同上
      <div onClick={below} onPointerDown={below} onPointerUp={below} onMouseDown={below}>
        <Host current={p} />
      </div>,
    );
    const scene = screen.getByTestId('fate-popup').closest('[data-scene="classic"]')!;
    expect(scene).toHaveAttribute('data-input-shield', 'true');
    expect(scene).toHaveAttribute('data-readonly', 'true');
    const shield = screen.getByTestId('popup-shield');
    expect([shield.style.left, shield.style.top, shield.style.width, shield.style.height]).toEqual([
      '0px',
      '0px',
      `${FATE_BOARD.w}px`,
      `${FATE_BOARD.h}px`,
    ]);
    fireEvent.pointerDown(shield, { button: 0, pointerId: 9 });
    fireEvent.mouseDown(shield, { button: 0 });
    fireEvent.pointerUp(shield, { button: 0, pointerId: 9 });
    fireEvent.mouseUp(shield, { button: 0 });
    fireEvent.click(shield, { button: 0 });
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(below).not.toHaveBeenCalled();
    expect(onWindow).not.toHaveBeenCalled();
    // 右键放开同样跳过，但不弹浏览器菜单
    expect(fireEvent.contextMenu(shield)).toBe(false);
    expect(below).not.toHaveBeenCalled();
    // 经典快捷键（M 大地图、< > 转视角…）：窗口捕获阶段就吞掉，useClassicHotkeys 与原版棋盘的 < > 监听都不处理
    for (const key of ['m', ',', '.', 'd', ' ']) {
      const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      document.body.dispatchEvent(ev);
      expect(ev.defaultPrevented, key).toBe(true);
      expect(shouldHandleHotkey(new KeyboardEvent('keydown', { key }))).toBe(false);
    }
    // 不是快捷键的键、输入框里打字：照常
    const other = new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true });
    document.body.dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);
    const input = document.createElement('input');
    document.body.appendChild(input);
    onTestFinished(() => input.remove());
    const typing = new KeyboardEvent('keydown', { key: 'm', bubbles: true, cancelable: true });
    input.dispatchEvent(typing);
    expect(typing.defaultPrevented).toBe(false);
  });

  it('加持消息框、亮卡不盖工具列：不接住指针，快捷键照常（只听不拦）', async () => {
    await bindPack();
    render(<Host current={open(fate(25, 25, { phase: 'blessing', blessingText: '财神保佑，奖金加倍！' }))} />);
    expect(screen.queryByTestId('popup-shield')).toBeNull();
    expect(screen.getByTestId('fate-popup').closest('[data-scene="classic"]')).not.toHaveAttribute('data-input-shield');
    expect(shouldHandleHotkey(new KeyboardEvent('keydown', { key: 'm' }))).toBe(true);
    cleanup();
    render(<Host current={open(gain(17))} />);
    expect(screen.getByTestId('card-cast-popup')).toBeInTheDocument();
    expect(screen.queryByTestId('popup-shield')).toBeNull();
    expect(boardShield(gain(17))).toBeUndefined();
  });
});

describe('新闻板：同样盖着工具列（fcn.0044a173 等待也是 fcn.00452c39）', () => {
  it('板面接住指针：最短时间之前点板子不跳过也不往下传，之后点板子等于点跳过钮；快捷键暂停', async () => {
    await bindPack();
    const spec: PopupSpec = {
      kind: 'news',
      id: 11,
      category: 1,
      categoryLabel: '政府公告',
      headline: '所得税',
      body: '全员缴纳现金的 5%。',
      affected: [],
    };
    expect(boardShield(spec)).toEqual({ x: 0, y: 0, w: 440, h: 480 });
    let p: OpenPopup | null = null;
    act(() => {
      usePopupStore.getState().open(spec, 3400, 1500);
      p = usePopupStore.getState().current;
    });
    const onSkip = vi.fn();
    const off = onPopupSkip(p!.popupId, onSkip);
    onTestFinished(off);
    const below = vi.fn();
    vi.useFakeTimers();
    try {
      // biome-ignore lint/a11y/noStaticElementInteractions: 测试替身（模拟板子下面会响应点击的元素）
      // biome-ignore lint/a11y/useKeyWithClickEvents: 同上
      render(<div onClick={below}>{<Host current={p} />}</div>);
      const shield = screen.getByTestId('popup-shield');
      expect(shield.closest('[data-scene="classic"]')).toHaveAttribute('data-input-shield', 'true');
      fireEvent.click(shield);
      expect(onSkip).not.toHaveBeenCalled();
      expect(below).not.toHaveBeenCalled();
      expect(shouldHandleHotkey(new KeyboardEvent('keydown', { key: 'm' }))).toBe(false);
      act(() => {
        vi.advanceTimersByTime(1501);
      });
      expect(screen.getByTestId('popup-skip')).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('popup-shield'));
      expect(onSkip).toHaveBeenCalledTimes(1);
      expect(below).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ───────────────────────── 得卡亮卡 ─────────────────────────

const gain = (card: CardId | null, gainFrom: 'square' | 'holiday' = 'square'): CardCastPopupSpec => ({
  kind: 'cardCast',
  player,
  card,
  cardName: card === null ? '' : `卡${card}`,
  desc: '',
  title: '孙小美 得到卡片',
  targetText: null,
  variant: 'gain',
  gainFrom,
});

describe('得卡亮卡（卡片格 0x41abfa、聖誕節 0x450e29：同一个亮卡函数 fcn.00440bac）', () => {
  it('句式：卡片格「得到XX！」、聖誕節「聖誕節…得到XX！」；看不到卡号时「得到一张卡片！」', () => {
    expect(cardShowMode('gain', 3, 'square')).toBe('gain');
    expect(cardShowMode('gain', null, 'square')).toBe('gainHidden');
    expect(cardShowMode('gain', 3, 'holiday')).toBe('holiday');
    expect(cardShowMode('gain', null, 'holiday')).toBe('holidayHidden');
    expect(popupKeys(gain(17))).toEqual(['ui.common', 'card.17']);
    expect(popupKeys(gain(null))).toEqual(['ui.common']);
  });

  it.each([1, 17, 30] as CardId[])(
    '卡 %i：本人看到原版卡片插画（不透明贴 (138,200)）+ 消息框「得到XX！」',
    async (k) => {
      await bindPack();
      render(<Host current={open(gain(k))} />);
      const pop = screen.getByTestId('card-cast-popup');
      expect(pop.closest('[data-classic="true"]')).not.toBeNull();
      expect(pop).toHaveAttribute('data-variant', 'gain');
      expect(pop).toHaveAttribute('data-mode', 'gain');
      const art = within(pop).getByTestId('card-cast-art');
      expect(art).toHaveAttribute('data-asset-key', `card.${k}`);
      expect(art.style.backgroundImage).toBe(`url("/pack/images/data/${529 + k}.png")`);
      expect([art.style.left, art.style.top]).toEqual(['138px', '200px']);
      expect(within(pop).getByTestId('card-cast-line').textContent).toBe(
        tx('events:popup.cardShow.gain', { who: player.name, card: `卡${k}` }),
      );
      expect(within(pop).getByTestId('card-cast-frame')).toHaveAttribute('data-frame', 'ui.common/5');
    },
  );

  it('私密手牌下别人：只有消息框，没有卡图（原版没有大卡背），文字不写卡名', async () => {
    await bindPack();
    render(<Host current={open(gain(null, 'holiday'))} />);
    const pop = screen.getByTestId('card-cast-popup');
    expect(pop.closest('[data-classic="true"]')).not.toBeNull();
    expect(pop).not.toHaveAttribute('data-card');
    expect(pop).toHaveAttribute('data-mode', 'holidayHidden');
    expect(within(pop).queryByTestId('card-cast-art')).toBeNull();
    expect(within(pop).getByTestId('card-cast-line').textContent).toBe(
      tx('events:popup.cardShow.holidayHidden', { who: player.name }),
    );
    expect(within(pop).getByTestId('card-cast-frame')).toHaveAttribute('data-frame', 'ui.common/5');
  });
});

// ───────────────────────── 魔法屋 ─────────────────────────

describe('魔法屋：宝石消息框（原版魔法屋的结果用通用消息框 fcn.0043f90f）', () => {
  it('标题、说明与被点到的人；文字多时框往下加高', async () => {
    await bindPack();
    const spec: MagicPopupSpec = {
      kind: 'magic',
      caster: player,
      title: '魔法：现金全部存入',
      line: '身上的现金全部存进银行。',
      targets: [
        { seat: 1, character: 0, name: '阿土伯' },
        { seat: 2, character: 3, name: '金贝贝' },
      ],
    };
    render(<Host current={open(spec)} />);
    const pop = screen.getByTestId('magic-popup');
    expect(pop.closest('[data-classic="true"]')).toHaveAttribute('data-kind', 'magic');
    expect(within(pop).getByTestId('magic-title')).toHaveTextContent('现金全部存入');
    expect(within(pop).getByTestId('magic-targets')).toHaveTextContent('阿土伯、金贝贝');
    const frame = within(pop).getByTestId('magic-box-frame');
    expect(frame).toHaveAttribute('data-frame', 'ui.common/5');
    expect(Number.parseFloat(frame.style.height)).toBeGreaterThanOrEqual(133);
    // 不是程序化的女巫卡片
    expect(pop.querySelector('img')).toBeNull();
  });
});

// ───────────────────────── 预取 ─────────────────────────

describe('空闲预取：新闻 / 命运板的图集页与插图（慢网络下板上的白框、浮字）', () => {
  it('本图会用到的命运插图：台湾 33 张（k<33 共 28 张 + 464–467），日本换成 471/465/466/472', () => {
    const tw = fateArtPrefetchKeys(0);
    expect(tw).toContain('illustration.fate.28');
    expect(tw).toContain('illustration.fate.31');
    expect(tw).not.toContain('illustration.fate.35');
    const jp = fateArtPrefetchKeys(2);
    expect(jp).toContain('illustration.fate.35');
    expect(jp).toContain('illustration.fate.36');
    expect(jp).not.toContain('illustration.fate.31');
    expect(fateArtPrefetchKeys(null)).toEqual(tw);
    expect(NEWS_ART_KEYS).toHaveLength(36);
  });

  it('宿主挂载后空闲时预取 ui.newsBoard 图集页，卡片插画之后再下命运与新闻插图', async () => {
    // jsdom 不下载位图：换成立即 onload 的 Image，预取队列才会往下走
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      decoding = 'auto';
      fetchPriority = 'auto';
      set src(_v: string) {
        setTimeout(() => this.onload?.(), 0);
      }
      decode(): Promise<void> {
        return Promise.resolve();
      }
    }
    vi.stubGlobal('Image', FakeImage);
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const client = atlasPackClient(a11Frames(), {
      images: { ...fakeCardImages(), ...fakeNewsImages(), ...fakeFateImages() },
    });
    resetClassicAssetsForTest();
    act(() => bindClassicAssets(client, 'prefetch-pack'));
    resetSkinStoreForTest({ client });
    render(<Host current={null} />);
    await waitFor(() => expect(classicImagePreloadStarted('url:/pack/ui.newsBoard.png')).toBe(true), {
      timeout: 3000,
    });
    await waitFor(() => expect(classicImagePreloadStarted('illustration.fate.0')).toBe(true), { timeout: 5000 });
    await waitFor(() => expect(classicImagePreloadStarted('illustration.news.35')).toBe(true), { timeout: 5000 });
  });
});
