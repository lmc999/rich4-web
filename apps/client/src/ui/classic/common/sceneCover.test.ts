// 中央决策倒计时在铺满舞台的原版场景里的小牌位置（client-unit）：各场景登记的位置不压场景里的文字与按钮。
// 回归（复审）：曾经一律摆在舞台顶端中线 (320,2)——股市整段时间盖住顶栏「存款」栏名、拍卖压到价格牌标题的「級」字、
// 公布栏只画在中间却被挪到舞台顶端叠在工具列图标上。小牌尺寸按原版布局 stage 档的最大值估（最后 10 秒放大、两位数）。
import { describe, expect, it } from 'vitest';
import type { Rect } from '../layout';
import { STOCK, stockRowRect } from '../venues/a/layout';
import { AUCTION_BADGE, PRICE_BOARD } from '../venues/b/auctionLayout';
import { BOARD_AT, COUNTDOWN_BADGE, SALE_BTN, TABLE } from '../venues/b/bulletinLayout';
import { MAGIC_BADGE } from '../venues/b/magicLayout';
import { STAGE_BADGE_TOP, type StageBadgeAt } from './sceneCover';

/** 小牌（上缘中点 at）的最大外框：宽 46、高 30（最后 10 秒字号 25 + 内边距 + 边框，留余量） */
function badge(at: StageBadgeAt): Rect {
  return { x: at.x - 23, y: at.y, w: 46, h: 30 };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function inStage(r: Rect): boolean {
  return r.x >= 0 && r.y >= 0 && r.x + r.w <= 640 && r.y + r.h <= 480;
}

describe('铺满舞台的场景里倒计时小牌的位置', () => {
  it('缺省舞台顶端中线（Stage4x3 状态条的位置）', () => {
    expect(STAGE_BADGE_TOP).toEqual({ x: 320, y: 2 });
    expect(inStage(badge(STAGE_BADGE_TOP))).toBe(true);
  });

  it('股市：挨在自己的圆环左边，不压顶栏 6 格、表头与详情框', () => {
    const b = badge(STOCK.badge);
    expect(inStage(b)).toBe(true);
    const ring: Rect = { ...STOCK.ring, w: 32, h: 32 };
    expect(overlaps(b, ring)).toBe(false);
    expect(b.x + b.w).toBeLessThanOrEqual(ring.x);
    // 与圆环垂直居中对齐（±4）
    expect(Math.abs(b.y + b.h / 2 - (ring.y + ring.h / 2))).toBeLessThanOrEqual(4);
    for (const h of STOCK.header) expect(overlaps(b, h)).toBe(false);
    // 顶栏第 4 格「存款」：旧位置 (320,2) 压着它
    expect(overlaps(badge(STAGE_BADGE_TOP), STOCK.header[3]!)).toBe(true);
    expect(overlaps(b, stockRowRect(0))).toBe(false);
    const P = STOCK.panel;
    expect(overlaps(b, { x: P.x, y: P.y, w: P.w, h: P.h })).toBe(false);
    // 最后一行只压在「盈虧」栏（数字靠右，被圆环盖住的部分之外是空的）
    expect(b.x).toBeGreaterThanOrEqual(STOCK.cols[5]!);
  });

  it('拍卖：在价格牌与右上角圆环（x 604–636）之间', () => {
    const b = badge(AUCTION_BADGE);
    expect(inStage(b)).toBe(true);
    expect(overlaps(b, PRICE_BOARD)).toBe(false);
    expect(overlaps(badge(STAGE_BADGE_TOP), PRICE_BOARD)).toBe(true);
    expect(b.x + b.w).toBeLessThanOrEqual(604);
  });

  it('公布栏：板面时在工具列（y<40）与软木板之间，不压 SALE / EXIT；选资产的表格时在表格左边', () => {
    const b = badge(COUNTDOWN_BADGE.board);
    expect(b.y).toBeGreaterThanOrEqual(40);
    // 最多压到软木板的木框边（板面内容从框内约 8 起）
    expect(b.y + b.h).toBeLessThanOrEqual(BOARD_AT.y + 6);
    expect(overlaps(b, { x: BOARD_AT.x + SALE_BTN.x, y: BOARD_AT.y + SALE_BTN.y, w: 150, h: SALE_BTN.h })).toBe(false);
    const t = badge(COUNTDOWN_BADGE.table);
    expect(t.y).toBeGreaterThanOrEqual(40);
    for (const tb of [TABLE.plain, TABLE.stock]) {
      expect(overlaps(t, { ...tb.at, w: tb.w, h: tb.h })).toBe(false);
      // 板面位置会压到表格（所以要换位置）
      expect(overlaps(b, { ...tb.at, w: tb.w, h: tb.h })).toBe(true);
    }
  });

  it('魔法屋：避开顶端正中画里的「∽1998∽」（x 约 244–395）', () => {
    const b = badge(MAGIC_BADGE);
    expect(inStage(b)).toBe(true);
    expect(b.x).toBeGreaterThanOrEqual(395);
    expect(b.x + b.w).toBeLessThanOrEqual(604);
  });
});
