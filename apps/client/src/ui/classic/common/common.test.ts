// 原版场景公共组件的纯函数（client-unit）：计算器按键与边界、热区命中（掩膜 / 矩形 / 扩展区）、九宫格切块、场景摆放。
import { describe, expect, it } from 'vitest';
import { CLASSIC_FRAMES, sliceParts, sliceSize } from './frames';
import { localPoint, regionBoxes, resolveActivation, spotAt } from './hitTest';
import { maskFromRegions } from './mask';
import {
  type CalcBounds,
  calcPress,
  isValidAmount,
  keyOfKeyboard,
  lcdDigits,
  meterRatio,
  NUMPAD_KEYS,
  NUMPAD_LCD,
  NUMPAD_METER,
  parseTyped,
  snapAmount,
  valueAtRatio,
} from './numpad';
import { hitMinLogical, scenePlacement, wantsWideHit } from './stage';
import { outlineShadow } from './textStyles';
import { messageBoxHeight, yesNoLayout } from './YesNoBox';

describe('计算器（numpad）', () => {
  const b: CalcBounds = { min: 0, max: 5000, step: 1 };

  it('数字键追加一位，超过 max 停在 max；← 去掉末位；C 归零', () => {
    let v = 0;
    for (const k of ['1', '2', '3'] as const) v = calcPress(v, k, b);
    expect(v).toBe(123);
    expect(calcPress(v, '4', b)).toBe(1234);
    expect(calcPress(1234, '5', b)).toBe(5000);
    expect(calcPress(1234, 'back', b)).toBe(123);
    expect(calcPress(7, 'back', b)).toBe(0);
    expect(calcPress(1234, 'clear', b)).toBe(0);
  });

  it('MAX 取最大合法值（按步长向下取整）；↵ 规整为合法值', () => {
    const shares: CalcBounds = { min: 10, max: 1234, step: 10 };
    expect(calcPress(0, 'max', shares)).toBe(1230);
    expect(calcPress(57, 'enter', shares)).toBe(50);
    expect(calcPress(3, 'enter', shares)).toBe(10);
    expect(calcPress(99999, 'enter', shares)).toBe(1230);
    expect(snapAmount(-5, b)).toBe(0);
    expect(isValidAmount(50, shares)).toBe(true);
    expect(isValidAmount(55, shares)).toBe(false);
    expect(isValidAmount(5, shares)).toBe(false);
    // 付不起（max < min）：一律是 min，且不合法
    const broke: CalcBounds = { min: 100, max: 40, step: 10 };
    expect(calcPress(0, 'max', broke)).toBe(100);
    expect(isValidAmount(100, broke)).toBe(false);
  });

  it('输入框文字、计量棒比例、液晶数字、键盘映射', () => {
    expect(parseTyped('1,2a3', b)).toBe(123);
    expect(parseTyped('', b)).toBe(0);
    expect(parseTyped('99999', b)).toBe(5000);
    expect(meterRatio(2500, b)).toBe(0.5);
    expect(meterRatio(9999, b)).toBe(1);
    expect(valueAtRatio(0.5, { min: 0, max: 1000, step: 100 })).toBe(500);
    expect(valueAtRatio(0.46, { min: 0, max: 1000, step: 100 })).toBe(500);
    expect(valueAtRatio(2, { min: 0, max: 1000, step: 100 })).toBe(1000);
    expect(lcdDigits(1203)).toEqual([1, 2, 0, 3]);
    expect(lcdDigits(123456789012345)).toHaveLength(11);
    expect(keyOfKeyboard('7')).toBe('7');
    expect(keyOfKeyboard('Backspace')).toBe('back');
    expect(keyOfKeyboard('Enter')).toBe('enter');
    expect(keyOfKeyboard('x')).toBeNull();
  });

  it('键位：16 区中 MAX、↵、12 键与计量条都有，区号与原版一致；手机扩展热区互不重叠', () => {
    expect(NUMPAD_KEYS.map((k) => k.region).sort((a, c) => a - c)).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
    expect(NUMPAD_METER.region).toBe(16);
    expect(NUMPAD_KEYS.find((k) => k.key === '7')!.region).toBe(7);
    expect(NUMPAD_KEYS.find((k) => k.key === '1')!.region).toBe(13);
    for (const a of NUMPAD_KEYS) {
      // 扩展区包住键区
      expect(a.pad.x <= a.rect.x && a.pad.y <= a.rect.y).toBe(true);
      expect(a.pad.x + a.pad.w >= a.rect.x + a.rect.w && a.pad.y + a.pad.h >= a.rect.y + a.rect.h).toBe(true);
      for (const c of NUMPAD_KEYS) {
        if (a === c) continue;
        const overlap =
          a.pad.x < c.pad.x + c.pad.w &&
          c.pad.x < a.pad.x + a.pad.w &&
          a.pad.y < c.pad.y + c.pad.h &&
          c.pad.y < a.pad.y + a.pad.h;
        expect(overlap, `${a.key}/${c.key}`).toBe(false);
      }
    }
    // 回归：MAX / ↵ 没有别的触控替代，手机横屏（0.8125 倍）下扩展区（含过键中心的横竖两条线）都要 ≥44px；
    // 它们往上补过计量条，但不碰液晶屏（手机上输入框向上补，底边仍是液晶屏底边 y=30）
    for (const id of ['max', 'enter'] as const) {
      const k = NUMPAD_KEYS.find((x) => x.key === id)!;
      expect(k.pad.w * 0.8125, id).toBeGreaterThanOrEqual(44);
      expect(k.pad.h * 0.8125, id).toBeGreaterThanOrEqual(44);
      const cx = k.rect.x + k.rect.w / 2;
      expect(Math.min(cx - k.pad.x, k.pad.x + k.pad.w - cx) * 2 * 0.8125, id).toBeGreaterThanOrEqual(44);
      expect(k.pad.y).toBeGreaterThanOrEqual(NUMPAD_LCD.rect.y + NUMPAD_LCD.rect.h);
      expect(k.pad.y).toBeLessThanOrEqual(NUMPAD_METER.rect.y);
    }
  });
});

describe('热区命中（hitTest）', () => {
  // 20×10：区 1 是左边的 L 形（包围盒 0..11 × 0..9），区 2 是右上的块（包围盒 8..19 × 0..4）——包围盒重叠
  const mask = maskFromRegions(20, 10, (x, y) => {
    if (x < 4 || (y >= 7 && x < 12)) return 1;
    if (x >= 8 && y < 5) return 2;
    return 0;
  });
  const spots = [
    { id: 'a', rect: { x: 0, y: 0, w: 12, h: 10 }, region: 1 },
    { id: 'b', rect: { x: 8, y: 0, w: 12, h: 5 }, region: 2 },
  ];

  it('按掩膜像素找热区；空白处为 null；没有掩膜时按矩形（后面的在上层）', () => {
    expect(spotAt(spots, mask, 1, 1)?.id).toBe('a');
    expect(spotAt(spots, mask, 10, 2)?.id).toBe('b');
    expect(spotAt(spots, mask, 10, 8)?.id).toBe('a');
    expect(spotAt(spots, mask, 6, 5)).toBeNull();
    expect(spotAt(spots, null, 10, 2)?.id).toBe('b');
    expect(spotAt(spots, null, 6, 5)?.id).toBe('a');
    expect(regionBoxes(mask).get(1)).toEqual({ x: 0, y: 0, w: 12, h: 10 });
    expect(regionBoxes(mask).get(2)).toEqual({ x: 8, y: 0, w: 12, h: 5 });
  });

  it('点击判定：键盘触发取自己；重叠处以掩膜为准；自己矩形里的空白不触发；矩形外的扩展区算自己；禁用不触发', () => {
    const [a, b] = spots as [(typeof spots)[0], (typeof spots)[0]];
    expect(resolveActivation(spots, mask, a, null)?.id).toBe('a');
    expect(resolveActivation(spots, mask, a, { x: 10, y: 2 })?.id).toBe('b');
    expect(resolveActivation(spots, mask, a, { x: 6, y: 5 })).toBeNull();
    expect(resolveActivation(spots, mask, b, { x: 21, y: 2 })?.id).toBe('b');
    expect(resolveActivation([a, { ...b, disabled: true }], mask, a, { x: 10, y: 2 })).toBeNull();
    expect(resolveActivation(spots, null, a, { x: 6, y: 5 })?.id).toBe('a');
  });

  it('屏幕坐标换算（舞台缩放）', () => {
    expect(localPoint({ left: 100, top: 50, width: 40, height: 20 }, 120, 60, 20, 10)).toEqual({ x: 10, y: 5 });
    expect(localPoint({ left: 0, top: 0, width: 0, height: 0 }, 1, 1, 20, 10)).toBeNull();
  });
});

describe('九宫格 / 三宫格（frames）', () => {
  it('九宫格：四角原尺寸、边与中间伸缩；目标比切边还小时按比例缩', () => {
    const parts = sliceParts(30, 20, { top: 5, right: 6, bottom: 4, left: 7 }, 100, 50);
    expect(parts.map((p) => p.name)).toEqual(['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br']);
    expect(parts[0]!.dst).toEqual({ x: 0, y: 0, w: 7, h: 5 });
    expect(parts[4]!.src).toEqual({ x: 7, y: 5, w: 17, h: 11 });
    expect(parts[4]!.dst).toEqual({ x: 7, y: 5, w: 87, h: 41 });
    expect(parts[8]!.dst).toEqual({ x: 94, y: 46, w: 6, h: 4 });
    const tiny = sliceParts(30, 20, { top: 10, right: 10, bottom: 10, left: 10 }, 10, 10);
    expect(tiny.map((p) => p.name)).toEqual(['tl', 'tr', 'bl', 'br']);
    expect(tiny[3]!.dst).toEqual({ x: 5, y: 5, w: 5, h: 5 });
  });

  it('宝石消息框是三宫格：宽度固定 195，只在纵向拉伸中段', () => {
    const spec = CLASSIC_FRAMES.messageBox;
    expect(sliceSize(spec, 300, 160)).toEqual({ w: 195, h: 160 });
    const parts = sliceParts(spec.w, spec.h, spec.slice, 195, 160);
    expect(parts.map((p) => p.name)).toEqual(['tc', 'mc', 'bc']);
    expect(parts[0]!.dst).toEqual({ x: 0, y: 0, w: 195, h: 38 });
    expect(parts[1]!.dst.h).toBe(160 - 38 - 12);
    expect(CLASSIC_FRAMES.crossPanel.repeat).toBe('round');
  });
});

describe('场景摆放与文字', () => {
  it('贴在舞台矩形上、同一倍率；独立渲染时按给定缩放；手机补热区', () => {
    const box = { stage: { x: 240, y: 0, w: 1440, h: 1080 }, scale: 2.25, pixelated: false };
    expect(scenePlacement(box)).toEqual({ left: 240, top: 0, scale: 2.25, pixelated: false });
    expect(scenePlacement(null, 2)).toEqual({ left: 0, top: 0, scale: 2, pixelated: true });
    expect(wantsWideHit(0.8125, false)).toBe(true);
    expect(wantsWideHit(2.25, false)).toBe(false);
    expect(wantsWideHit(2.25, true)).toBe(true);
    expect(hitMinLogical(0.5)).toBe(92);
  });

  it('YES/NO 与消息框：缺省画点 (220,333)；行数多时框变高、超出底边时上移', () => {
    const l = yesNoLayout(220, 333, 2);
    expect(l.box).toEqual({ x: 123, y: 252, w: 195, h: 133 });
    expect(l.yesno).toEqual({ x: 172, y: 325, w: 96, h: 48 });
    // YES/NO 整个在框内、底边留出 12px 绳纹边；正文区在 YES/NO 之上
    expect(l.yesno.y + l.yesno.h).toBe(l.box.y + l.box.h - 12);
    expect(l.text.y + l.text.h).toBeLessThanOrEqual(l.yesno.y);
    expect(yesNoLayout(220, 333, 3).box.h).toBe(148);
    expect(messageBoxHeight(5)).toBe(178);
    const tall = yesNoLayout(220, 420, 6);
    expect(tall.box.y + tall.box.h).toBeLessThanOrEqual(476);
  });

  it('8 方向描边', () => {
    expect(outlineShadow('#000').split(', ')).toHaveLength(8);
  });
});
