// toast 落点（layout.classicToastSlot，original-skin.md §4.1「toast」）：舞台缩小时挪到棋盘视窗以外、没被抽屉盖住的
// 第一个空位——边距条（先左后右）→ 舞台右栏底部；桌面不挪。
import { describe, expect, it } from 'vitest';
import {
  classicToastSlot,
  computeClassicLayout,
  drawerWidth,
  type Rect,
  TOAST_GUTTER_MIN,
  TOAST_GUTTER_TOP,
  TOAST_INSET,
} from './layout';

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

describe('classicToastSlot', () => {
  it('844×390（抽屉模式，两侧各 162）：左边距条、抽屉按钮以下；左抽屉开着时换到右边距条；都不碰棋盘视窗与舞台', () => {
    const box = computeClassicLayout(844, 390);
    expect(box.rails).toBe('drawer');
    expect(box.left.w).toBe(162);
    const left = classicToastSlot(box, null);
    expect(left).toEqual({
      x: TOAST_INSET,
      y: TOAST_GUTTER_TOP,
      w: 162 - 2 * TOAST_INSET,
      h: 390 - TOAST_GUTTER_TOP - TOAST_INSET,
      align: 'top',
      place: 'gutter-left',
    });
    // 右抽屉（聊天）开着不影响左边
    expect(classicToastSlot(box, 'right')).toEqual(left);
    const right = classicToastSlot(box, 'left');
    expect(right).toMatchObject({
      x: 682 + TOAST_INSET,
      y: TOAST_GUTTER_TOP,
      w: 150,
      align: 'top',
      place: 'gutter-right',
    });
    for (const s of [left!, right!]) {
      expect(overlaps(s, box.board)).toBe(false);
      expect(overlaps(s, box.stage)).toBe(false);
    }
  });

  it('667×375（边距条只有 84）：舞台右栏底部往上长；只在右栏里，不碰棋盘视窗；左抽屉开着照旧，右抽屉盖住右栏时用缺省位置', () => {
    const box = computeClassicLayout(667, 375);
    expect(box.rails).toBe('drawer');
    expect(box.left.w).toBeLessThan(TOAST_GUTTER_MIN);
    const s = classicToastSlot(box, null)!;
    expect(s.place).toBe('stage-right');
    expect(s.align).toBe('bottom');
    // 右栏 = 舞台 x 440–640（资料栏 + 日历）
    const colX = Math.round(box.stage.x + 440 * box.scale);
    expect(s.x).toBe(colX + TOAST_INSET);
    expect(s.x + s.w).toBe(box.stage.x + box.stage.w - TOAST_INSET);
    expect(s.y + s.h).toBe(box.stage.y + box.stage.h - TOAST_INSET);
    expect(overlaps(s, box.board)).toBe(false);
    expect(classicToastSlot(box, 'left')).toEqual(s);
    expect(box.width - drawerWidth(box.width)).toBeLessThan(colX);
    expect(classicToastSlot(box, 'right')).toBeNull();
  });

  it('手机整栏模式（844×340，侧栏有内容）：舞台右栏底部', () => {
    const box = computeClassicLayout(844, 340);
    expect(box.rails).toBe('full');
    expect(box.scale).toBeLessThan(1);
    const s = classicToastSlot(box, null)!;
    expect(s.place).toBe('stage-right');
    expect(overlaps(s, box.board)).toBe(false);
  });

  it('舞台不缩小（scale ≥ 1）：缺省位置——桌面 1920×1080、笔电 1366×768 / 1440×900、平板 1024×768（后三者是抽屉模式）', () => {
    for (const [w, h] of [
      [1920, 1080],
      [1366, 768],
      [1440, 900],
      [1024, 768],
    ] as const) {
      const box = computeClassicLayout(w, h);
      expect(box.scale, `${w}×${h}`).toBeGreaterThanOrEqual(1);
      expect(classicToastSlot(box, null), `${w}×${h}`).toBeNull();
      expect(classicToastSlot(box, 'left'), `${w}×${h}`).toBeNull();
    }
  });
});
