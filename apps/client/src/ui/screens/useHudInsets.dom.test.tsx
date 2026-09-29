// 程序化布局的镜头 insets（client-dom）：
// - hudInsets：侧栏在右（缺省）遮右边；左手模式侧栏挪到左边缘，遮左边；
// - 与镜头连起来：两种模式下镜头中心（跟随目标、小地图点击 panTo 的落点）都是看得见的棋盘视口正中，
//   即画面正中央决策倒计时层（侧栏以外、顶栏以下、底栏以上）的中心；小地图视口框（画布四角）仍覆盖整块画布；
// - useHudInsets：切换左手模式时重新量（侧栏宽没变、不会有 resize），尺寸没变时返回同一个对象。
// jsdom 没有布局：offsetWidth / offsetHeight 按元素的 data-w / data-h 给；jsdom 也没有 ResizeObserver，走 resize 事件。
import { act, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Camera, type Insets, type Transformable } from '../../game/camera/Camera';
import { hudInsets, useHudInsets } from './useHudInsets';

function fakeTarget(): Transformable {
  const pt = () => {
    const p = {
      x: 0,
      y: 0,
      set(x: number, y?: number) {
        p.x = x;
        p.y = y ?? x;
      },
    };
    return p;
  };
  return { position: pt(), scale: pt() };
}

// 1280×800 桌面：右栏 300、顶栏 62（含上边距）、底栏 78（行动区一行 + 下边距）
const VW = 1280;
const VH = 800;
const SIZES = { top: 62, side: 300, bottom: 78 };

/** 画面正中央倒计时层的中心（countdown.module.css .hudLayer：侧栏以外、顶栏以下、底栏以上） */
function visibleBoardCentre(leftHanded: boolean): { x: number; y: number } {
  const left = leftHanded ? SIZES.side : 0;
  const right = leftHanded ? VW : VW - SIZES.side;
  return { x: (left + right) / 2, y: (SIZES.top + (VH - SIZES.bottom)) / 2 };
}

describe('hudInsets', () => {
  it('缺省：侧栏在右，遮右边', () => {
    expect(hudInsets(SIZES, false)).toEqual({ top: 62, right: 300, bottom: 78, left: 0 });
  });

  it('左手模式：侧栏在左边缘，左右对调', () => {
    expect(hudInsets(SIZES, true)).toEqual({ top: 62, right: 0, bottom: 78, left: 300 });
  });

  it.each([false, true])('镜头中心 = 看得见的棋盘视口正中（左手模式 %s）', (leftHanded) => {
    const cam = new Camera(fakeTarget(), { w: VW, h: VH });
    cam.setInsets(hudInsets(SIZES, leftHanded));
    const centre = visibleBoardCentre(leftHanded);
    expect(cam.screenAnchor()).toEqual(centre);
    // 跟随 / panTo 对准的点显示在这里
    const p = { x: 123, y: -45 };
    cam.lookAt(p);
    expect(cam.worldToScreen(p)).toEqual(centre);
    // 小地图视口框取画布四角：换算回屏幕仍是整块画布
    const corners = [
      { x: 0, y: 0 },
      { x: VW, y: 0 },
      { x: VW, y: VH },
      { x: 0, y: VH },
    ];
    for (const c of corners) {
      const back = cam.worldToScreen(cam.screenToWorld(c));
      expect(back.x).toBeCloseTo(c.x, 6);
      expect(back.y).toBeCloseTo(c.y, 6);
    }
  });

  it('左手模式下旧算法（侧栏总算在右）会偏左半个侧栏宽', () => {
    const cam = new Camera(fakeTarget(), { w: VW, h: VH });
    cam.setInsets(hudInsets(SIZES, false));
    expect(visibleBoardCentre(true).x - cam.screenAnchor().x).toBe(SIZES.side);
  });
});

describe('useHudInsets', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return Number(this.dataset.w ?? 0);
    });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return Number(this.dataset.h ?? 0);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function Harness({ leftHanded, seen }: { leftHanded: boolean; seen: Insets[] }) {
    const top = useRef<HTMLDivElement>(null);
    const side = useRef<HTMLElement>(null);
    const bottom = useRef<HTMLDivElement>(null);
    seen.push(useHudInsets(top, side, bottom, 'default', leftHanded));
    return (
      <>
        <div ref={top} data-testid="top" data-h={SIZES.top} />
        <aside ref={side} data-testid="side" data-w={SIZES.side} />
        <div ref={bottom} data-testid="bottom" data-h={SIZES.bottom} />
      </>
    );
  }

  it('切换左手模式时重新量：左右对调（没有 resize 事件）', () => {
    const seen: Insets[] = [];
    const { rerender } = render(<Harness leftHanded={false} seen={seen} />);
    expect(seen.at(-1)).toEqual({ top: 62, right: 300, bottom: 78, left: 0 });
    rerender(<Harness leftHanded={true} seen={seen} />);
    expect(seen.at(-1)).toEqual({ top: 62, right: 0, bottom: 78, left: 300 });
    rerender(<Harness leftHanded={false} seen={seen} />);
    expect(seen.at(-1)).toEqual({ top: 62, right: 300, bottom: 78, left: 0 });
  });

  it('左手模式下侧栏变宽：宽度记在左边；尺寸没变时返回同一个对象', () => {
    const seen: Insets[] = [];
    const { getByTestId } = render(<Harness leftHanded={true} seen={seen} />);
    const before = seen.at(-1);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(seen.at(-1)).toBe(before);
    getByTestId('side').dataset.w = '200';
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(seen.at(-1)).toEqual({ top: 62, right: 0, bottom: 78, left: 200 });
  });
});
