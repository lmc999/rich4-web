// 第二组场所屏的布局纯函数（client-unit）：魔法屋的区号 / 按钮 / 提示框摆放，拍卖厅的缩图帧、竞价钮、竞拍者站位，
// 监狱 / 医院的 8 格分配与画点，公佈欄的图钉 / 明细卡 / 类别格 / 表格行；手机热区（≥44px 折成逻辑像素）的几何约束。
import { describe, expect, it } from 'vitest';
import type { Rect } from '../../layout';
import {
  bidButtonFrames,
  bidButtonRect,
  bidderSlots,
  chibiSheet,
  lotArtFrame,
  mapStyleIndex,
  nextPrice,
} from './auctionLayout';
import {
  BAIL_UI,
  bailCell,
  barsAt,
  cellRect,
  JAIL_WINDOWS,
  nameTagAt,
  portraitAt,
  portraitFrame,
  villainIndex,
} from './bailLayout';
import {
  BOARD_AT,
  BOARD_SIZE,
  detailFrame,
  itemsPerPage,
  KIND_ORDER,
  kindCell,
  kindsLayout,
  listingIconFrame,
  pageCount,
  TABLE,
  TILES_PER_PAGE,
  tableRow,
  tileAt,
} from './bulletinLayout';
import {
  conditionFrame,
  EFFECT_BUTTON,
  effectButtonRect,
  effectFrame,
  effectRegion,
  HINT,
  hintPlacement,
  MAGIC_ICON_AT,
  regionEffect,
} from './magicLayout';

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inScene = (r: Rect): boolean => r.x >= 0 && r.y >= 0 && r.x + r.w <= 640 && r.y + r.h <= 480;
/** 手机横屏（舞台 520×390，倍率 0.8125）下 44px 折成的逻辑像素 */
const HIT_LOGICAL = 44 / 0.8125;

describe('魔法屋', () => {
  it('效果 e ↔ 掩膜区 e+1，图标帧 23+e、条件帧 11+c', () => {
    for (let e = 0; e < 12; e++) {
      expect(regionEffect(effectRegion(e as never))).toBe(e);
      expect(effectFrame(e as never)).toBe(23 + e);
      expect(conditionFrame(e as never)).toBe(11 + e);
    }
    expect(regionEffect(0)).toBeNull();
    expect(regionEffect(13)).toBeNull();
  });

  it('12 颗效果按钮以图标为中心、互不重叠、都在场景里，且手机上够 44px', () => {
    expect(EFFECT_BUTTON).toBeGreaterThanOrEqual(HIT_LOGICAL);
    const rects = MAGIC_ICON_AT.map((_, e) => effectButtonRect(e as never));
    for (const [i, r] of rects.entries()) {
      expect(inScene(r), `effect ${i}`).toBe(true);
      for (const [j, q] of rects.entries()) if (i < j) expect(overlaps(r, q), `${i}/${j}`).toBe(false);
    }
  });

  it('提示框在场景里，尾巴朝向图标（上半的框在下方、左半的框在右侧）', () => {
    for (let e = 0; e < 12; e++) {
      const [ix, iy] = MAGIC_ICON_AT[e]!;
      const p = hintPlacement(e as never);
      expect(inScene({ x: p.x, y: p.y, w: HINT.w, h: HINT.h }), `effect ${e}`).toBe(true);
      const tip = HINT.tips[p.frame]!;
      const tx = p.x + tip.x;
      const ty = p.y + tip.y;
      expect(Math.hypot(tx - ix, ty - iy), `effect ${e}`).toBeLessThan(40);
      if (iy < 240) expect(p.y).toBeGreaterThan(iy - 20);
      else expect(p.y + HINT.h).toBeLessThan(iy + 20);
    }
  });
});

describe('拍卖厅', () => {
  it('拍卖品缩图：住宅按地图与等级、连锁店、设施按类型与等级、空地画「售」', () => {
    expect(lotArtFrame({ facility: null, chain: false }, 1, 0)).toBe(30);
    expect(lotArtFrame({ facility: null, chain: false }, 5, 0)).toBe(34);
    expect(lotArtFrame({ facility: null, chain: false }, 3, 2)).toBe(42);
    expect(lotArtFrame({ facility: null, chain: false }, 0, 0)).toBe(103);
    expect(lotArtFrame({ facility: null, chain: true }, 3, 0)).toBe(50);
    expect(lotArtFrame({ facility: 'park', chain: false }, 0, 0)).toBe(51);
    expect(lotArtFrame({ facility: 'hotel', chain: false }, 1, 0)).toBe(52);
    expect(lotArtFrame({ facility: 'mall', chain: false }, 5, 0)).toBe(61);
    expect(lotArtFrame({ facility: 'gas', chain: false }, 2, 0)).toBe(63);
    expect(lotArtFrame({ facility: 'lab', chain: false }, 5, 0)).toBe(71);
    expect(lotArtFrame({ facility: 'lab', chain: false }, 0, 0)).toBe(103);
    expect(lotArtFrame(null, 2, 0)).toBe(31);
    expect(mapStyleIndex('taiwan')).toBe(0);
    expect(mapStyleIndex('japan')).toBe(2);
    expect(mapStyleIndex(undefined)).toBe(0);
  });

  it('7 颗竞价钮：常态帧 3+2i、悬停帧 4+2i，排成一排不重叠、都在场景里', () => {
    const rects = Array.from({ length: 7 }, (_, i) => bidButtonRect(i));
    for (const [i, r] of rects.entries()) {
      expect(bidButtonFrames(i)).toEqual({ normal: 3 + 2 * i, hover: 4 + 2 * i });
      expect(inScene(r)).toBe(true);
      if (i > 0) expect(overlaps(r, rects[i - 1]!)).toBe(false);
      // 手机：宽度本身够 44px，高度向上补（上方只有装饰）
      expect(r.w).toBeGreaterThanOrEqual(HIT_LOGICAL);
    }
  });

  it('竞拍者站位居中、间距不小于小人宽度；新价格 = 无人领先时起拍价 + 档位，否则现价 + 档位', () => {
    expect(bidderSlots(0)).toEqual([]);
    expect(bidderSlots(1)).toEqual([365]);
    const four = bidderSlots(4);
    expect(four).toHaveLength(4);
    for (let i = 1; i < 4; i++) expect(four[i]! - four[i - 1]!).toBeGreaterThanOrEqual(70);
    expect(nextPrice({ leader: null, start: 1000, price: 1000 }, 0)).toBe(1000);
    expect(nextPrice({ leader: 1, start: 1000, price: 1500 }, 500)).toBe(2000);
    expect(chibiSheet(9)).toBe('venue.chibi.9.1');
    expect(chibiSheet(99)).toBe('venue.chibi.11.1');
  });
});

describe('监狱 / 医院', () => {
  it('8 格：前 4 格是座位 0–3，后 4 格是小偷、强盗、流氓、间谍', () => {
    expect([0, 1, 2, 3].map((i) => bailCell(i))).toEqual([0, 1, 2, 3].map((seat) => ({ k: 'seat', seat })));
    expect([4, 5, 6, 7].map((i) => bailCell(i))).toEqual(
      ['thief', 'robber', 'thug', 'spy'].map((kind) => ({ k: 'villain', kind })),
    );
    expect(villainIndex('thug')).toBe(2);
  });

  it('格子的可点矩形互不重叠、都在场景里、手机上够 44px；名字牌在格子下方 / 名牌上', () => {
    for (const where of ['jail', 'hospital'] as const) {
      const rects = Array.from({ length: 8 }, (_, i) => cellRect(where, i));
      for (const [i, r] of rects.entries()) {
        expect(inScene(r), `${where} ${i}`).toBe(true);
        expect(Math.min(r.w, r.h)).toBeGreaterThanOrEqual(HIT_LOGICAL);
        for (const [j, q] of rects.entries()) if (i < j) expect(overlaps(r, q), `${where} ${i}/${j}`).toBe(false);
        expect(inScene(nameTagAt(where, i))).toBe(true);
      }
    }
    // 监狱人像画点 = 窗洞左上角；铁栏水平居中盖住窗洞
    expect(portraitAt('jail', 0)).toEqual({ x: JAIL_WINDOWS[0]!.x, y: JAIL_WINDOWS[0]!.y });
    const w = JAIL_WINDOWS[1]!;
    const b = barsAt(1);
    expect(b.x).toBeLessThanOrEqual(w.x);
    expect(b.x + 132).toBeGreaterThanOrEqual(w.x + w.w);
  });

  it('人像帧：监狱大头 5+角色 / 17+恶人，医院病床 14+角色 / 26+恶人', () => {
    expect(portraitFrame('jail', { k: 'seat', character: 9 })).toBe(14);
    expect(portraitFrame('jail', { k: 'villain', kind: 'spy' })).toBe(20);
    expect(portraitFrame('hospital', { k: 'seat', character: 0 })).toBe(14);
    expect(portraitFrame('hospital', { k: 'villain', kind: 'thief' })).toBe(26);
  });

  it('下方的讲话框、YES/NO、点券框不压住格子', () => {
    for (const where of ['jail', 'hospital'] as const) {
      const ui = BAIL_UI[where];
      const parts: Rect[] = [
        { x: ui.yesno.x, y: ui.yesno.y, w: 96, h: 48 },
        { x: ui.points.x, y: ui.points.y, w: 90, h: 40 },
      ];
      for (const p of parts) {
        expect(inScene(p)).toBe(true);
        for (let i = 0; i < 8; i++) expect(overlaps(p, cellRect(where, i)), `${where} ${i}`).toBe(false);
      }
    }
  });
});

describe('公佈欄', () => {
  it('图钉 5×3 一页，都钉在板子里、互不重叠；图标帧按类别与是否本人', () => {
    expect(TILES_PER_PAGE).toBe(15);
    const rects = Array.from({ length: 15 }, (_, i) => ({ ...tileAt(i), w: 72, h: 72 }));
    for (const [i, r] of rects.entries()) {
      expect(r.x).toBeGreaterThanOrEqual(BOARD_AT.x);
      expect(r.y + r.h + 14).toBeLessThanOrEqual(BOARD_AT.y + BOARD_SIZE.h);
      for (const [j, q] of rects.entries()) if (i < j) expect(overlaps(r, q)).toBe(false);
    }
    expect(listingIconFrame('card', false)).toBe(12);
    expect(listingIconFrame('stock', false)).toBe(13);
    expect(listingIconFrame('lot', true)).toBe(10);
    expect(listingIconFrame('item', true)).toBe(11);
    expect(detailFrame('lot')).toMatchObject({ frame: 8, rows: 5 });
    expect(detailFrame('stock')).toMatchObject({ frame: 7, rows: 4 });
    expect(detailFrame('card')).toMatchObject({ frame: 6, rows: 3 });
  });

  it('类别格：手机上放大 1.4 倍后每格 ≥44px 且扩展热区互不重叠；关闭钮在框外', () => {
    for (const wide of [false, true]) {
      const L = kindsLayout(wide);
      const cells = KIND_ORDER.map((_, i) => kindCell(i, L.scale));
      if (wide) for (const c of cells) expect(c.h).toBeGreaterThanOrEqual(HIT_LOGICAL - 4);
      for (const [i, r] of cells.entries())
        for (const [j, q] of cells.entries()) if (i < j) expect(overlaps(r, q)).toBe(false);
      expect(L.close.x).toBeGreaterThanOrEqual(L.x + 144 * L.scale);
      expect(L.close.x + L.close.w).toBeLessThanOrEqual(640);
    }
  });

  it('表格：桌面一项一行（12 项）、手机一项两行（6 项，每项 64 逻辑像素 ≥44px）；分页', () => {
    expect(itemsPerPage(1)).toBe(12);
    expect(itemsPerPage(2)).toBe(6);
    expect(tableRow(0, 2, 300)).toEqual({ x: 0, y: TABLE.rowH, w: 300, h: 64 });
    expect(tableRow(5, 2, 300).y + 64).toBeLessThanOrEqual(TABLE.plain.h);
    expect(64).toBeGreaterThanOrEqual(HIT_LOGICAL);
    expect(pageCount(0, 6)).toBe(1);
    expect(pageCount(13, 6)).toBe(3);
  });
});
