// 第一组场所屏的纯布局（client-unit）：ATM 键位与手机扩展热区、LCD 位数、号码盘格子、货架行、股市表格、开奖阶段与号码球、走势折线。
import { describe, expect, it } from 'vitest';
import type { Rect } from '../../layout';
import {
  ATM,
  atmDigits,
  atmKeyPad,
  DRAW,
  drawBalls,
  drawPhase,
  LOTTERY,
  lotteryCell,
  SHOP,
  STOCK,
  shopRowRect,
  stockCol,
  stockIndustryFrame,
  stockIndustryOf,
  stockRowRect,
  trendPoints,
} from './layout';

const overlap = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (a: Rect, b: Rect): boolean =>
  a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;

describe('ATM（Panel#24）', () => {
  it('14 颗键：图5–16 为 7 8 9 / 4 5 6 / 1 2 3 / C 0 ←，MAX 图17、↵ 图18；键区都在本体内、互不重叠', () => {
    expect(ATM.keys.map((k) => k.key)).toEqual([
      '7',
      '8',
      '9',
      '4',
      '5',
      '6',
      '1',
      '2',
      '3',
      'clear',
      '0',
      'back',
      'max',
      'enter',
    ]);
    expect(ATM.keys.map((k) => k.frame)).toEqual(Array.from({ length: 14 }, (_, i) => 5 + i));
    const body: Rect = { x: 0, y: 0, w: ATM.w, h: ATM.h };
    for (const [i, a] of ATM.keys.entries()) {
      expect(inside(a.rect, body), a.key).toBe(true);
      for (const b of ATM.keys.slice(i + 1)) expect(overlap(a.rect, b.rect), `${a.key}/${b.key}`).toBe(false);
    }
  });

  it('手机扩展热区包住自己的键区，数字键之间互不重叠', () => {
    const digits = ATM.keys.filter((k) => k.key !== 'max' && k.key !== 'enter');
    for (const [i, a] of digits.entries()) {
      expect(inside(a.rect, atmKeyPad(a)), a.key).toBe(true);
      for (const b of digits.slice(i + 1)) expect(overlap(atmKeyPad(a), atmKeyPad(b)), `${a.key}/${b.key}`).toBe(false);
    }
    const max = ATM.keys.find((k) => k.key === 'max')!;
    const enter = ATM.keys.find((k) => k.key === 'enter')!;
    expect(inside(max.rect, atmKeyPad(max))).toBe(true);
    expect(inside(enter.rect, atmKeyPad(enter))).toBe(true);
    expect(overlap(atmKeyPad(max), atmKeyPad(enter))).toBe(false);
  });

  it('业务钮、EXIT、计量条互不重叠；LCD 数字右对齐最多 9 位', () => {
    const parts = [ATM.ops.deposit.rect, ATM.ops.withdraw.rect, ATM.exit.rect, ATM.meter.rect];
    for (const [i, a] of parts.entries()) for (const b of parts.slice(i + 1)) expect(overlap(a, b)).toBe(false);
    expect(atmDigits(30000)).toEqual([3, 0, 0, 0, 0]);
    expect(atmDigits(0)).toEqual([0]);
    expect(atmDigits(1234567890)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 0]);
    expect(ATM.lcd.right - ATM.lcd.cells * ATM.lcd.step).toBeGreaterThanOrEqual(ATM.label.x + 20);
  });
});

describe('乐透号码盘（Panel#12）', () => {
  it('36 格：1 号格心 (60,296)、36 号 (572,439)；格子互不重叠、都在号码盘里', () => {
    expect(lotteryCell(0)).toMatchObject({ cx: 60, cy: 296 });
    expect(lotteryCell(35)).toMatchObject({ cx: 572, cy: 439 });
    const board: Rect = { x: 8, y: 255, w: 624, h: 222 };
    const cells = Array.from({ length: 36 }, (_, i) => lotteryCell(i));
    for (const [i, a] of cells.entries()) {
      expect(inside(a, board), String(i + 1)).toBe(true);
      for (const b of cells.slice(i + 1)) expect(overlap(a, b)).toBe(false);
    }
    // 跑马灯在号码盘上方居中
    expect(Math.abs(LOTTERY.marquee.x + LOTTERY.marquee.w / 2 - 320)).toBeLessThanOrEqual(1);
  });
});

describe('百货货架（Panel#10）', () => {
  it('卡片架 15 行、道具架 8 行都落在货架帧里，行与行不重叠', () => {
    const shelf: Rect = { x: SHOP.shelf.x, y: SHOP.shelf.y, w: SHOP.shelf.w, h: SHOP.shelf.h };
    for (const [page, n] of [
      ['card', SHOP.cardRows.count],
      ['item', SHOP.itemRows.count],
    ] as const) {
      const rows = Array.from({ length: n }, (_, i) => shopRowRect(page, i));
      for (const [i, a] of rows.entries()) {
        expect(inside(a, shelf), `${page}${i}`).toBe(true);
        if (i > 0) expect(overlap(a, rows[i - 1]!)).toBe(false);
      }
    }
  });
});

describe('股市（Panel#75）', () => {
  it('13 行（栏名 + 12 支）从 48 起、行高 32，最后一行到 464；6 列覆盖表格宽度', () => {
    expect(stockRowRect(0)).toEqual({ x: 15, y: 48, w: 609, h: 32 });
    const last = stockRowRect(STOCK.rows.count - 1);
    expect(last.y + last.h).toBe(464);
    const widths = Array.from({ length: 6 }, (_, k) => stockCol(k).w);
    expect(widths.reduce((a, b) => a + b, 0)).toBe(609);
    // 详情框在舞台之内
    const P = STOCK.panel;
    expect(inside({ x: P.x, y: P.y, w: P.w, h: P.h }, { x: 0, y: 0, w: 640, h: 480 })).toBe(true);
  });

  it('行业图按所属企业的行业码查 exe 表 0x4733b7；日本电子业帧 8；没有企业的股票不画', () => {
    // 行业码 1 航空 / 3 电子 / 4 保险 / 5 汽车 / 6 石油 / 7 银行 / 10 百货 / 11 建设
    const want: [number, number][] = [
      [1, 11],
      [3, 7],
      [4, 5],
      [5, 6],
      [6, 9],
      [7, 3],
      [10, 4],
      [11, 10],
    ];
    for (const [industry, frame] of want) {
      for (const gm of [0, 1, 3, null]) expect(stockIndustryFrame(industry, gm), `${industry}@${gm}`).toBe(frame);
    }
    expect(stockIndustryFrame(3, 2)).toBe(8);
    for (const [industry, frame] of want.filter(([i]) => i !== 3)) expect(stockIndustryFrame(industry, 2)).toBe(frame);
    // 没有企业、表中为 0、超出表长：不画
    for (const industry of [null, 0, 2, 8, 9, 12]) expect(stockIndustryFrame(industry, 0)).toBeNull();
    // 帧都在 Panel#75 的行业图 3–11 之内
    for (const [industry] of want) {
      for (const gm of [0, 2]) {
        const f = stockIndustryFrame(industry, gm)!;
        expect(f).toBeGreaterThanOrEqual(3);
        expect(f).toBeLessThanOrEqual(11);
      }
    }
  });

  it('stockIndustryOf：按 companies[].stockIndex 反查行业码（台湾：中國信託 0 银行、臺灣人壽 1 保险、大宇百貨 2 百货）', () => {
    const taiwan = {
      companies: [
        { stockIndex: 1, industry: 4 },
        { stockIndex: 2, industry: 10 },
        { stockIndex: 0, industry: 7 },
      ],
    };
    expect([0, 1, 2, 3].map((i) => stockIndustryOf(taiwan, i))).toEqual([7, 4, 10, null]);
    expect([0, 1, 2].map((i) => stockIndustryFrame(stockIndustryOf(taiwan, i), 0))).toEqual([3, 5, 4]);
    expect(stockIndustryOf(null, 0)).toBeNull();
  });

  it('走势折线：空为空串，单值画在中线，多值铺满宽度且最高点在上', () => {
    expect(trendPoints([], 100, 50)).toBe('');
    expect(trendPoints([500], 100, 50)).toBe('50.0,25.0');
    const pts = trendPoints([100, 300, 200], 100, 50, 0)
      .split(' ')
      .map((p) => p.split(',').map(Number));
    expect(pts).toEqual([
      [0, 50],
      [50, 0],
      [100, 25],
    ]);
  });
});

describe('乐透开奖（Panel#15）', () => {
  it('阶段按寿命比例推进；没有号码直接揭晓', () => {
    expect(drawPhase(0, 1000, true)).toBe('intro');
    expect(drawPhase(DRAW.phase.spin * 1000, 1000, true)).toBe('spin');
    expect(drawPhase(DRAW.phase.reveal * 1000, 1000, true)).toBe('reveal');
    expect(drawPhase(0, 1000, false)).toBe('reveal');
  });

  it('号码 → 十位、个位两颗球', () => {
    expect(drawBalls(12)).toEqual([1, 2]);
    expect(drawBalls(5)).toEqual([0, 5]);
    expect(drawBalls(36)).toEqual([3, 6]);
  });
});

describe('场景音乐（沿用 audio/selectors 的场所曲映射：决策出现即由 audioWiring 挂上场所层）', () => {
  it('银行 ATM / 柜台 → bank，百货 → shop，乐透投注 → lotteryBet；股市没有场所曲（原版只有音效集）', async () => {
    const { venueScene } = await import('../../../../audio/selectors');
    expect(venueScene({ kind: 'BANK_ATM' })).toBe('bank');
    expect(venueScene({ kind: 'BANK_COUNTER' })).toBe('bank');
    expect(venueScene({ kind: 'SHOP' })).toBe('shop');
    expect(venueScene({ kind: 'LOTTERY' })).toBe('lotteryBet');
    expect(venueScene({ kind: 'TURN_MENU' })).toBeNull();
  });
});
