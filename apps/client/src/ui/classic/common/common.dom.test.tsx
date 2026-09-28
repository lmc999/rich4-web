// 原版场景公共组件（client-dom）：Stage4x3 的缩放、portal、焦点与只读态；Hotspots 的掩膜命中；Calculator 的输入与边界；
// YesNoBox；NineSlice 切块；ClassicButton 换帧；SpeakerBubble。素材用假精灵表（与原版同尺寸同锚点，不含任何原版像素）。
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetClassicAssetsForTest } from '../assets';
import { ClassicStage } from '../ClassicStage';
import { Calculator } from './Calculator';
import { ClassicButton } from './ClassicButton';
import { Hotspots } from './Hotspots';
import { maskFromRegions } from './mask';
import { NineSlice } from './NineSlice';
import { SpeakerBubble } from './SpeakerBubble';
import { SceneLayer, Stage4x3 } from './Stage4x3';
import { STAGE_BADGE_TOP, type StageBadgeAt, useSceneCoverStore } from './sceneCover';
import { fakeSceneSheets, fakeSheet, installSceneAssets } from './testing';
import { YesNoBox } from './YesNoBox';

const rails = { leftLabel: '左', rightLabel: '右' };

function inStage(size: { w: number; h: number }, scene: ReactNode) {
  return render(
    <ClassicStage size={size} {...rails} overlay={scene}>
      <span />
    </ClassicStage>,
  );
}

beforeEach(() => installSceneAssets({ packId: null }));
afterEach(() => resetClassicAssetsForTest());

describe('Stage4x3', () => {
  it('挂到经典舞台容器上：与舞台同一落点与倍率（1920×1080 → 2.25 平滑），子层按场景坐标绝对定位', () => {
    inStage(
      { w: 1920, h: 1080 },
      <Stage4x3 testId="scene" label="场景">
        <SceneLayer x={10} y={20} w={30} h={40} testId="layer" />
      </Stage4x3>,
    );
    const scene = screen.getByTestId('scene');
    expect(scene.parentElement).toBe(screen.getByTestId('classic-stage'));
    expect([scene.style.left, scene.style.top, scene.style.width, scene.style.height]).toEqual([
      '240px',
      '0px',
      '640px',
      '480px',
    ]);
    expect(scene.style.transform).toBe('scale(2.25)');
    expect(scene).toHaveAttribute('data-pixelated', 'false');
    expect(scene).toHaveAttribute('data-hit', 'normal');
    expect(scene).toHaveAttribute('role', 'dialog');
    expect(scene).toHaveAttribute('aria-label', '场景');
    const layer = screen.getByTestId('layer');
    expect([layer.style.left, layer.style.top, layer.style.width, layer.style.height]).toEqual([
      '10px',
      '20px',
      '30px',
      '40px',
    ]);
  });

  it('整数倍 3 → 最近邻；手机横屏 844×390（倍率 0.8125）→ data-hit=wide，--hit 为 44px 折成的逻辑像素', () => {
    const a = inStage({ w: 2560, h: 1440 }, <Stage4x3 testId="scene" label="场景" />);
    let scene = screen.getByTestId('scene');
    expect(scene.style.transform).toBe('scale(3)');
    expect(scene).toHaveAttribute('data-pixelated', 'true');
    a.unmount();
    inStage({ w: 844, h: 390 }, <Stage4x3 testId="scene" label="场景" />);
    scene = screen.getByTestId('scene');
    expect(scene.style.transform).toBe('scale(0.8125)');
    expect(scene).toHaveAttribute('data-hit', 'wide');
    expect(Number.parseFloat(scene.style.getPropertyValue('--hit')) * 0.8125).toBeCloseTo(46, 5);
  });

  it('不在经典舞台之内时就地渲染，按 scale 缩放', () => {
    const { container } = render(<Stage4x3 testId="scene" label="场景" scale={2} />);
    const scene = screen.getByTestId('scene');
    expect(container.contains(scene)).toBe(true);
    expect(scene.style.transform).toBe('scale(2)');
    expect(scene).toHaveAttribute('data-pixelated', 'true');
  });

  it('模态：焦点移入场景根、Tab 在场景内循环、Esc 与关闭钮调用 onClose、关掉后焦点还给打开它的元素；热键暂停', async () => {
    const closes = vi.fn();
    const user = userEvent.setup();
    function Harness(): ReactNode {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" data-testid="outside" onClick={() => setOpen(true)}>
            open
          </button>
          {open && (
            <Stage4x3
              testId="scene"
              label="场景"
              onClose={() => {
                closes();
                setOpen(false);
              }}
              closeLabel="关闭"
              countdown={{ remainingMs: 9000, totalMs: 10000 }}
            >
              <SceneLayer x={0} y={0}>
                <button type="button" data-testid="b1">
                  1
                </button>
                <button type="button" data-testid="b2">
                  2
                </button>
              </SceneLayer>
            </Stage4x3>
          )}
        </>
      );
    }
    render(<Harness />);
    await user.click(screen.getByTestId('outside'));
    const scene = screen.getByTestId('scene');
    expect(document.activeElement).toBe(scene);
    expect(scene).toHaveAttribute('data-state', 'open');
    expect(scene).toHaveAttribute('aria-modal', 'true');
    expect(within(scene).getByRole('timer')).toBeInTheDocument();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByTestId('b1'));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByTestId('b2'));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '关闭' }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByTestId('b1'));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByTestId('scene-close'));
    await user.keyboard('{Escape}');
    expect(closes).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('scene')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('outside'));
    // 再开一次，点关闭钮
    await user.click(screen.getByTestId('outside'));
    await user.click(screen.getByTestId('scene-close'));
    expect(closes).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(screen.getByTestId('outside'));
  });

  it('回归：焦点在场景外的输入框（聊天框）上时不抢焦点，输入框里的 Esc 不关闭；焦点在场景外的按钮上时照常移入', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    function Harness({ open }: { open: boolean }): ReactNode {
      return (
        <>
          <input data-testid="chat" aria-label="聊天" />
          <div contentEditable data-testid="note" />
          <button type="button" data-testid="outside">
            x
          </button>
          {open && <Stage4x3 testId="scene" label="场景" onClose={onClose} />}
        </>
      );
    }
    const r = render(<Harness open={false} />);
    await user.click(screen.getByTestId('chat'));
    r.rerender(<Harness open />);
    expect(document.activeElement).toBe(screen.getByTestId('chat'));
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    r.rerender(<Harness open={false} />);
    expect(document.activeElement).toBe(screen.getByTestId('chat'));
    // contenteditable 同样算在打字
    act(() => screen.getByTestId('note').focus());
    r.rerender(<Harness open />);
    expect(document.activeElement).toBe(screen.getByTestId('note'));
    r.rerender(<Harness open={false} />);
    // 按钮不是打字的地方：照常移入场景
    act(() => screen.getByTestId('outside').focus());
    r.rerender(<Harness open />);
    expect(document.activeElement).toBe(screen.getByTestId('scene'));
  });

  it('只读：不抢焦点、不挡棋盘、控件禁用、显示状态条，Esc 不关闭', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <>
        <button type="button" data-testid="outside">
          x
        </button>
        <Stage4x3 testId="scene" label="场景" readOnly onClose={onClose} status="等待 孙小美 做决定…" statusTone="wait">
          <SceneLayer x={0} y={0}>
            <button type="button" data-testid="b1">
              1
            </button>
          </SceneLayer>
        </Stage4x3>
      </>,
    );
    const scene = screen.getByTestId('scene');
    expect(scene).toHaveAttribute('data-readonly', 'true');
    expect(scene).toHaveAttribute('data-state', 'closed');
    expect(scene).not.toHaveAttribute('aria-modal');
    expect(document.activeElement).not.toBe(scene);
    expect(screen.getByTestId('b1')).toBeDisabled();
    expect(screen.getByTestId('scene-status')).toHaveTextContent('等待 孙小美 做决定…');
    await user.click(screen.getByTestId('outside'));
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('登记中央倒计时小牌的位置（sceneCover）：opaque / dim 缺省舞台顶端中线；none 缺省不登记；场景可指定或明确不登记；只读不登记', () => {
    const at = (): StageBadgeAt | null => useSceneCoverStore.getState().covers.at(-1)?.at ?? null;
    for (const backdrop of ['opaque', 'dim'] as const) {
      const a = render(<Stage4x3 testId="scene" label="场景" backdrop={backdrop} />);
      expect(at(), backdrop).toEqual(STAGE_BADGE_TOP);
      a.unmount();
      expect(at()).toBeNull();
    }
    const b = render(<Stage4x3 testId="scene" label="场景" backdrop="none" />);
    expect(at()).toBeNull();
    b.unmount();
    const c = render(<Stage4x3 testId="scene" label="场景" backdrop="dim" countdownBadgeAt={{ x: 320, y: 40 }} />);
    expect(at()).toEqual({ x: 320, y: 40 });
    c.unmount();
    const d = render(<Stage4x3 testId="scene" label="场景" backdrop="opaque" countdownBadgeAt={null} />);
    expect(at()).toBeNull();
    d.unmount();
    const e = render(<Stage4x3 testId="scene" label="场景" backdrop="opaque" readOnly />);
    expect(at()).toBeNull();
    e.unmount();
    // 两个场景重叠（进出场动画）：取后登记的；后开的关掉后回到先开的
    const f = render(<Stage4x3 testId="s1" label="一" backdrop="opaque" />);
    const g = render(<Stage4x3 testId="s2" label="二" backdrop="opaque" countdownBadgeAt={{ x: 572, y: 448 }} />);
    expect(at()).toEqual({ x: 572, y: 448 });
    g.unmount();
    expect(at()).toEqual(STAGE_BADGE_TOP);
    f.unmount();
    expect(useSceneCoverStore.getState().covers).toEqual([]);
  });
});

describe('Hotspots', () => {
  // 20×10：区 1 是左边的 L 形，区 2 是右上的块（两者包围盒重叠）
  const mask = maskFromRegions(20, 10, (x, y) => {
    if (x < 4 || (y >= 7 && x < 12)) return 1;
    if (x >= 8 && y < 5) return 2;
    return 0;
  });

  function renderSpots(o: { maskKey?: string; mask?: typeof mask | null; disabledB?: boolean } = {}) {
    const onA = vi.fn();
    const onB = vi.fn();
    const hot = vi.fn();
    const pressed = vi.fn();
    render(
      <Hotspots
        x={5}
        y={6}
        w={20}
        h={10}
        mask={o.maskKey ? undefined : o.mask === undefined ? mask : o.mask}
        maskKey={o.maskKey}
        spots={[
          { id: 'a', rect: { x: 0, y: 0, w: 12, h: 10 }, region: 1, label: '甲', testId: 'hs-a', onActivate: onA },
          {
            id: 'b',
            rect: { x: 8, y: 0, w: 12, h: 5 },
            region: 2,
            label: '乙',
            testId: 'hs-b',
            onActivate: onB,
            disabled: o.disabledB,
            hit: 'right',
          },
        ]}
        onHotChange={hot}
        onPressChange={pressed}
        testId="hs"
        label="热区"
      />,
    );
    const group = screen.getByTestId('hs');
    // 容器在屏幕上放大 2 倍：(100, 50) 起 40×20
    group.getBoundingClientRect = () =>
      ({ left: 100, top: 50, width: 40, height: 20, right: 140, bottom: 70, x: 100, y: 50 }) as DOMRect;
    const at = (x: number, y: number) => ({ clientX: 100 + x * 2, clientY: 50 + y * 2, detail: 1 });
    return { onA, onB, hot, pressed, group, at };
  }

  it('透明按钮摆在矩形上（容器坐标）、可访问名与扩展方向；有掩膜时标记 data-mask', () => {
    const { group } = renderSpots();
    expect([group.style.left, group.style.top, group.style.width, group.style.height]).toEqual([
      '5px',
      '6px',
      '20px',
      '10px',
    ]);
    expect(group).toHaveAttribute('data-mask', 'true');
    const b = screen.getByRole('button', { name: '乙' });
    expect([b.style.left, b.style.top, b.style.width, b.style.height]).toEqual(['8px', '0px', '12px', '5px']);
    expect(b).toHaveAttribute('data-hitpad', 'right');
    expect(screen.getByTestId('hs-a')).toHaveAttribute('data-hitpad', 'grow');
  });

  it('掩膜命中：重叠处按像素找区、空白不触发、键盘触发取自己、禁用的不触发', () => {
    const { onA, onB, at } = renderSpots();
    fireEvent.click(screen.getByTestId('hs-a'), at(10, 2));
    expect(onB).toHaveBeenCalledTimes(1);
    expect(onA).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('hs-a'), at(6, 5));
    expect(onA).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('hs-a'), at(10, 8));
    expect(onA).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('hs-b'), { detail: 0 });
    expect(onB).toHaveBeenCalledTimes(2);
    // 右侧扩展区（容器外）算乙
    fireEvent.click(screen.getByTestId('hs-b'), at(21, 2));
    expect(onB).toHaveBeenCalledTimes(3);
  });

  it('禁用的热区：按钮 disabled，重叠处点到它也不触发', () => {
    const { onA, onB, at } = renderSpots({ disabledB: true });
    expect(screen.getByTestId('hs-b')).toBeDisabled();
    fireEvent.click(screen.getByTestId('hs-a'), at(10, 2));
    expect(onA).not.toHaveBeenCalled();
    expect(onB).not.toHaveBeenCalled();
  });

  it('掩膜从素材仓库按逻辑键取；取不到时按矩形命中', () => {
    installSceneAssets({ masks: { 'test.mask': mask } });
    const r1 = renderSpots({ mask: undefined, maskKey: 'test.mask' });
    expect(r1.group).toHaveAttribute('data-mask', 'true');
    fireEvent.click(screen.getByTestId('hs-a'), r1.at(10, 2));
    expect(r1.onB).toHaveBeenCalledTimes(1);
    cleanup();
    installSceneAssets({ masks: { 'test.mask': null } });
    const r2 = renderSpots({ mask: undefined, maskKey: 'test.mask' });
    expect(r2.group).toHaveAttribute('data-mask', 'false');
    fireEvent.click(screen.getByTestId('hs-a'), r2.at(6, 5));
    expect(r2.onA).toHaveBeenCalledTimes(1);
  });

  it('悬停与按下：指针下的热区（含重叠处按掩膜）；离开清空；键盘焦点也算悬停', () => {
    const { hot, pressed, at } = renderSpots();
    fireEvent.pointerMove(screen.getByTestId('hs-a'), at(10, 2));
    expect(hot).toHaveBeenLastCalledWith('b');
    expect(screen.getByTestId('hs')).toHaveAttribute('data-hot', 'b');
    fireEvent.pointerDown(screen.getByTestId('hs-a'), at(1, 1));
    expect(pressed).toHaveBeenLastCalledWith('a');
    fireEvent.pointerUp(screen.getByTestId('hs-a'), at(1, 1));
    expect(pressed).toHaveBeenLastCalledWith(null);
    fireEvent.pointerLeave(screen.getByTestId('hs'));
    expect(hot).toHaveBeenLastCalledWith(null);
    act(() => screen.getByTestId('hs-a').focus());
    expect(hot).toHaveBeenLastCalledWith('a');
  });
});

describe('Calculator', () => {
  function Harness(p: {
    min?: number;
    max?: number;
    step?: number;
    initial?: number;
    onEnter?: (v: number) => void;
    disabled?: boolean;
  }): ReactNode {
    const [v, setV] = useState(p.initial ?? 0);
    return (
      <Calculator
        value={v}
        onChange={setV}
        min={p.min ?? 0}
        max={p.max ?? 5000}
        step={p.step}
        onEnter={p.onEnter}
        x={100}
        y={50}
        label="金额"
        disabled={p.disabled}
      />
    );
  }
  const lcd = () => Number(screen.getByTestId('calc-lcd').getAttribute('data-value'));

  it('数字键追加、超过上限停在上限、← 去末位、C 归零；↵ 提交规整后的值', async () => {
    const onEnter = vi.fn();
    const user = userEvent.setup();
    render(<Harness onEnter={onEnter} />);
    const calc = screen.getByTestId('calc');
    expect([calc.style.left, calc.style.top]).toEqual(['100px', '50px']);
    for (const k of ['1', '2', '3']) await user.click(screen.getByTestId(`calc-key-${k}`));
    expect(lcd()).toBe(123);
    await user.click(screen.getByTestId('calc-key-4'));
    await user.click(screen.getByTestId('calc-key-5'));
    expect(lcd()).toBe(5000);
    await user.click(screen.getByTestId('calc-key-back'));
    expect(lcd()).toBe(500);
    await user.click(screen.getByTestId('calc-key-enter'));
    expect(onEnter).toHaveBeenLastCalledWith(500);
    await user.click(screen.getByTestId('calc-key-clear'));
    expect(lcd()).toBe(0);
    expect(screen.getByRole('button', { name: '最大' })).toBe(screen.getByTestId('calc-key-max'));
    expect(screen.getByRole('button', { name: '确定' })).toBe(screen.getByTestId('calc-key-enter'));
  });

  it('步长与 MAX：MAX 取最大的步长整数倍；↵ 把不合法值规整；计量棒方向键 ±step、End 到最大', async () => {
    const onEnter = vi.fn();
    const user = userEvent.setup();
    render(<Harness min={10} max={1234} step={10} onEnter={onEnter} />);
    await user.click(screen.getByTestId('calc-key-max'));
    expect(lcd()).toBe(1230);
    await user.click(screen.getByTestId('calc-key-clear'));
    await user.click(screen.getByTestId('calc-key-5'));
    await user.click(screen.getByTestId('calc-key-7'));
    await user.click(screen.getByTestId('calc-key-enter'));
    expect(onEnter).toHaveBeenLastCalledWith(50);
    expect(lcd()).toBe(50);
    const meter = screen.getByRole('slider', { name: '金额' });
    expect(meter).toHaveAttribute('aria-valuemin', '10');
    expect(meter).toHaveAttribute('aria-valuemax', '1234');
    act(() => meter.focus());
    await user.keyboard('{ArrowRight}');
    expect(lcd()).toBe(60);
    await user.keyboard('{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}');
    expect(lcd()).toBe(10);
    await user.keyboard('{End}');
    expect(lcd()).toBe(1230);
    expect(meter).toHaveAttribute('aria-valuenow', '1230');
  });

  it('液晶屏上的输入框：直接打字（超过上限停在上限）；焦点在键上时数字键与 Backspace 也有效', async () => {
    const user = userEvent.setup();
    render(<Harness max={9000} />);
    const input = screen.getByRole('textbox', { name: '金额' });
    expect(input).toHaveAttribute('inputmode', 'numeric');
    await user.clear(input);
    await user.type(input, '777');
    expect(lcd()).toBe(777);
    await user.type(input, '99');
    expect(lcd()).toBe(9000);
    act(() => screen.getByTestId('calc-key-5').focus());
    await user.keyboard('{Backspace}{Backspace}');
    expect(lcd()).toBe(90);
    await user.keyboard('3');
    expect(lcd()).toBe(903);
  });

  it('计量棒点按按比例取值（场景缩放后的实际宽度）', () => {
    render(<Harness max={1000} step={100} />);
    const meter = screen.getByTestId('calc-meter');
    meter.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 220, height: 28, right: 220, bottom: 28, x: 0, y: 0 }) as DOMRect;
    fireEvent.pointerDown(meter, { clientX: 110, pointerId: 1 });
    expect(lcd()).toBe(500);
  });

  it('禁用：键、输入框、计量棒都不可用', async () => {
    const user = userEvent.setup();
    render(<Harness initial={42} disabled />);
    expect(screen.getByTestId('calc-key-1')).toBeDisabled();
    expect(screen.getByTestId('calc-input')).toBeDisabled();
    expect(screen.getByTestId('calc-meter')).toHaveAttribute('aria-disabled', 'true');
    await user.click(screen.getByTestId('calc-key-1'));
    expect(lcd()).toBe(42);
  });

  it('有素材：画本体、液晶数字帧（16 + 数字）与计量条亮格；没素材：CSS 回退', () => {
    installSceneAssets({ sprites: fakeSceneSheets() });
    const r = render(<Harness initial={2500} />);
    expect(screen.getByTestId('calc')).toHaveAttribute('data-art', 'true');
    const digits = [...screen.getByTestId('calc-lcd').querySelectorAll('[data-sprite]')].map((e) =>
      e.getAttribute('data-sprite'),
    );
    expect(digits).toEqual(['ui.numpad/18', 'ui.numpad/21', 'ui.numpad/16', 'ui.numpad/16']);
    expect(screen.getByTestId('calc-meter')).toHaveAttribute('data-ratio', '0.5000');
    r.unmount();
    installSceneAssets({ packId: null });
    render(<Harness initial={7} />);
    expect(screen.getByTestId('calc')).toHaveAttribute('data-art', 'false');
    expect(screen.getByTestId('calc-lcd')).toHaveTextContent('7');
  });
});

describe('YesNoBox', () => {
  it('消息框（三宫格）+ YES/NO：点左半 YES、右半 NO；悬停 / 焦点换亮帧；Y / N 键；是钮禁用时灰罩', async () => {
    installSceneAssets({ sprites: fakeSceneSheets() });
    const onYes = vi.fn();
    const onNo = vi.fn();
    const user = userEvent.setup();
    const r = render(
      <YesNoBox
        onYes={onYes}
        onNo={onNo}
        yesLabel="购买"
        noLabel="不买"
        yesTestId="y"
        noTestId="n"
        testId="box"
        lines={4}
      >
        <p>地价：2,000元</p>
      </YesNoBox>,
    );
    const frame = screen.getByTestId('box').querySelector('[data-frame="ui.common/5"]') as HTMLElement;
    expect(frame).toHaveAttribute('data-slice', 'parts');
    expect([frame.style.left, frame.style.top, frame.style.width, frame.style.height]).toEqual([
      '123px',
      '252px',
      '195px',
      '163px',
    ]);
    expect(frame.querySelectorAll('[data-part]')).toHaveLength(3);
    expect(screen.getByTestId('box-text')).toHaveTextContent('地价：2,000元');
    const art = () =>
      screen.getByTestId('box').querySelector('[data-sprite^="ui.yesno/"]')?.getAttribute('data-sprite');
    expect(art()).toBe('ui.yesno/0');
    act(() => screen.getByTestId('y').focus());
    expect(art()).toBe('ui.yesno/1');
    act(() => screen.getByTestId('n').focus());
    expect(art()).toBe('ui.yesno/2');
    await user.click(screen.getByRole('button', { name: '购买' }));
    expect(onYes).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTestId('n'));
    expect(onNo).toHaveBeenCalledTimes(1);
    // Y / N 只认框里的按键（焦点在 YES / NO 或所属场景里）；落在 body 上的不认（回归：打字时误提交）
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    fireEvent.keyDown(document.body, { key: 'y' });
    fireEvent.keyDown(document.body, { key: 'N' });
    expect(onYes).toHaveBeenCalledTimes(1);
    expect(onNo).toHaveBeenCalledTimes(1);
    // ← → 在 body 上也可用（只移焦点）
    fireEvent.keyDown(document.body, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(screen.getByTestId('y'));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'y' });
    expect(onYes).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'N' });
    expect(onNo).toHaveBeenCalledTimes(2);
    r.rerender(
      <YesNoBox
        onYes={onYes}
        onNo={onNo}
        yesLabel="购买"
        noLabel="不买"
        yesTestId="y"
        noTestId="n"
        testId="box"
        yesDisabled
      >
        <p>现金不足</p>
      </YesNoBox>,
    );
    expect(screen.getByTestId('y')).toBeDisabled();
    fireEvent.keyDown(screen.getByTestId('n'), { key: 'y' });
    expect(onYes).toHaveBeenCalledTimes(2);
  });

  it('YES / NO 各往外侧补手机热区；素材缺失时画回退', () => {
    render(
      <YesNoBox onYes={() => {}} onNo={() => {}} yesLabel="是" noLabel="否" yesTestId="y" noTestId="n" testId="box" />,
    );
    expect(screen.getByTestId('y')).toHaveAttribute('data-hitpad', 'left');
    expect(screen.getByTestId('n')).toHaveAttribute('data-hitpad', 'right');
    expect(screen.getByTestId('box')).toHaveTextContent('YES');
  });
});

describe('NineSlice、ClassicButton、SpeakerBubble', () => {
  it('九宫格：9 块背景映射到目标矩形；素材缺失画回退', () => {
    installSceneAssets({
      sprites: {
        'venue.monthly.screen': fakeSheet('venue.monthly.screen', [
          [1, 1, 0, 0],
          [1, 1, 0, 0],
          [278, 98, 139, 49],
        ]),
      },
    });
    const r = render(<NineSlice spec="parchment" x={10} y={20} w={300} h={120} testId="nine" />);
    const nine = screen.getByTestId('nine');
    expect(nine).toHaveAttribute('data-slice', 'parts');
    const parts = nine.querySelectorAll<HTMLElement>('[data-part]');
    expect(parts).toHaveLength(9);
    const br = nine.querySelector<HTMLElement>('[data-part="bb"], [data-part="br"]')!;
    // 右下角块 (284,104) 16×16，朝内侧（左、上）各多画 0.5 与相邻块叠压
    expect([br.style.left, br.style.top, br.style.width, br.style.height]).toEqual([
      '283.5px',
      '103.5px',
      '16.5px',
      '16.5px',
    ]);
    // 源帧在图集页 x=2 处：右下角块的背景偏移 = −(2 + 262)，再补回外扩的 0.5
    expect(br.style.backgroundPosition).toBe('-263.5px -81.5px');
    const tl = nine.querySelector<HTMLElement>('[data-part="tl"]')!;
    expect([tl.style.left, tl.style.top, tl.style.width, tl.style.height]).toEqual(['0px', '0px', '16.5px', '16.5px']);
    r.unmount();
    installSceneAssets({ packId: null });
    render(<NineSlice spec="crossPanel" x={0} y={0} w={100} h={50} testId="nine" />);
    expect(screen.getByTestId('nine')).toHaveAttribute('data-slice', 'fallback');
  });

  it('原版按钮：常态 / 悬停 / 按下 / 禁用换帧；精灵缺失时画带文字的回退钮', () => {
    installSceneAssets({
      sprites: {
        'venue.bank.screen': fakeSheet('venue.bank.screen', [
          [80, 40, 0, 0],
          [80, 40, 0, 0],
          [80, 40, 0, 0],
          [80, 40, 0, 0],
        ]),
      },
    });
    const onClick = vi.fn();
    const r = render(
      <ClassicButton
        sheet="venue.bank.screen"
        frames={{ normal: 0, hover: 1, pressed: 2, disabled: 3 }}
        x={500}
        y={400}
        label="离开"
        onClick={onClick}
        testId="exit"
      />,
    );
    const btn = screen.getByRole('button', { name: '离开' });
    const art = () => btn.querySelector('[data-sprite]')?.getAttribute('data-sprite');
    expect([btn.style.left, btn.style.top, btn.style.width, btn.style.height]).toEqual([
      '500px',
      '400px',
      '80px',
      '40px',
    ]);
    expect(art()).toBe('venue.bank.screen/0');
    fireEvent.pointerEnter(btn);
    expect(art()).toBe('venue.bank.screen/1');
    fireEvent.pointerDown(btn);
    expect(art()).toBe('venue.bank.screen/2');
    fireEvent.pointerUp(btn);
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
    r.rerender(
      <ClassicButton
        sheet="venue.bank.screen"
        frames={{ normal: 0, hover: 1, pressed: 2, disabled: 3 }}
        x={500}
        y={400}
        label="离开"
        onClick={onClick}
        disabled
      />,
    );
    expect(art()).toBe('venue.bank.screen/3');
    r.unmount();
    installSceneAssets({ packId: null });
    render(
      <ClassicButton
        sheet="venue.bank.screen"
        frames={{ normal: 0 }}
        x={0}
        y={0}
        w={80}
        h={40}
        label="离开"
        onClick={onClick}
      />,
    );
    expect(screen.getByRole('button', { name: '离开' })).toHaveTextContent('离开');
  });

  it('讲话头像：大头按 (170,130) 减锚点，表情叠在同一画点；云形气泡与文字', () => {
    installSceneAssets({ sprites: fakeSceneSheets([4]) });
    render(
      <SpeakerBubble character={4} expression={1} testId="sp">
        <p>要买吗？</p>
      </SpeakerBubble>,
    );
    const sp = screen.getByTestId('sp');
    const head = sp.querySelector<HTMLElement>('[data-sprite="portrait.speaker.4/0"]')!;
    expect([head.style.left, head.style.top]).toEqual(['133px', '95px']);
    const face = sp.querySelector<HTMLElement>('[data-sprite="portrait.speaker.4/2"]')!;
    expect([face.style.left, face.style.top]).toEqual(['153px', '113px']);
    const cloud = sp.querySelector<HTMLElement>('[data-sprite="ui.common/6"]')!;
    expect([cloud.style.left, cloud.style.top]).toEqual(['165px', '100px']);
    expect(screen.getByTestId('sp-text')).toHaveTextContent('要买吗？');
  });
});
