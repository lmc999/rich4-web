// 建筑生成器（design/client.md §3.5）：BuildingSpec → Pixi 显示树 → 缓存纹理。
// 住宅 0–5 级、设施（空地/公园/旅馆/购物中心/加油站/研究所）、地标与企业（银行/医院/监狱/新闻/乐透/魔法屋/
// 卡片屋/百货/游乐园/景点/写字楼）共用一套等角挤出几何；footprint 用视图网格的 w×d（旋转后宽深互换）。
import { Container, Graphics, Text } from 'pixi.js';
import { FONT_TITLE } from '../../../ui/theme/fontFamilies';
import type { TextureCache } from '../textureCache';
import {
  drawBox,
  drawDome,
  drawDoor,
  drawGableRoof,
  drawParapet,
  drawSpire,
  drawWindows,
  faceQuad,
  fillPoly,
  INK_STROKE,
  iso3,
  leftFaceFrame,
  rightFaceFrame,
  shade,
} from './geometry';
import {
  FACILITY_FLOORS,
  FACILITY_MAX_LEVEL,
  type FacilityStyle,
  FLOOR_PX,
  HOUSE_LEVELS,
  INK,
  LANDMARK_LOOKS,
  type LandmarkStyle,
  MAX_HOUSE_LEVEL,
  NEUTRAL_ROOF,
  PALETTE,
  PLAYER_COLORS,
  PLAYER_MARKS,
} from './styles';

export type BuildingKind = 'house' | `facility:${FacilityStyle}` | `landmark:${LandmarkStyle}`;

export interface BuildingSpec {
  kind: BuildingKind;
  /** 住宅 0..5；设施按 FACILITY_MAX_LEVEL；地标忽略 */
  level: number;
  /** 视图网格 footprint（格） */
  w: number;
  d: number;
  /** 座位号 0..3（决定玩家色），null 为无主 */
  owner: number | null;
  variant: number;
  /** 门开在哪个可见面：left=朝 SW，right=朝 SE，none=门在背面 */
  door: 'left' | 'right' | 'none';
  /** 招牌文字（缺省取主题兜底文字） */
  sign?: string;
  /** 强调色（企业行业色） */
  accent?: number;
}

export interface BuildingInfo {
  /** 建筑最高点距地面的像素高度（用于遮挡淡化、头顶气泡定位） */
  heightPx: number;
}

export function buildingKey(s: BuildingSpec): string {
  return [
    s.kind,
    `L${s.level}`,
    `${s.w}x${s.d}`,
    `o${s.owner ?? '-'}`,
    `v${s.variant}`,
    s.door,
    s.sign ?? '',
    s.accent?.toString(16) ?? '',
  ].join('|');
}

export function clampLevel(kind: BuildingKind, level: number): number {
  const max = kind === 'house' ? MAX_HOUSE_LEVEL : kind.startsWith('facility:') ? facilityMax(kind) : 0;
  return Math.max(0, Math.min(max, Math.trunc(level)));
}

function facilityMax(kind: BuildingKind): number {
  const style = kind.slice('facility:'.length) as FacilityStyle;
  return FACILITY_MAX_LEVEL[style] ?? 0;
}

function ownerColor(owner: number | null): number | null {
  return owner === null ? null : (PLAYER_COLORS[owner % PLAYER_COLORS.length] ?? null);
}

/** 内缩后的盒子尺寸 */
function inset(s: BuildingSpec, m: number): { w: number; d: number } {
  return { w: Math.max(0.2, s.w - m * 2), d: Math.max(0.2, s.d - m * 2) };
}

// ───────────────────────── 小部件 ─────────────────────────

function label(text: string, size: number, color: number = INK): Text {
  const t = new Text({
    text,
    style: {
      fontFamily: FONT_TITLE,
      fontSize: size,
      fill: color,
      stroke: { color: 0xffffff, width: Math.max(2, size * 0.18), join: 'round' },
      align: 'center',
    },
    resolution: 2,
  });
  t.anchor.set(0.5);
  return t;
}

/** 立在 (x,y) 屏幕点上的招牌：木桩 + 圆角板 + 文字 */
function signBoard(root: Container, g: Graphics, text: string, x: number, y: number, color: number, post = 18): number {
  const t = label(text, 15);
  const bw = Math.max(34, t.width + 12);
  const bh = 24;
  const top = y - post - bh;
  if (post > 0)
    g.moveTo(x, y)
      .lineTo(x, y - post)
      .stroke({ width: 4, color: INK, cap: 'round' });
  g.roundRect(x - bw / 2, top, bw, bh, 6)
    .fill(color)
    .stroke({ width: 2.5, color: INK });
  t.position.set(x, top + bh / 2);
  root.addChild(t);
  return top;
}

/** 旗杆 + 三角旗（玩家色 + 形状标记） */
function flag(root: Container, g: Graphics, x: number, y: number, owner: number, height = 34): void {
  const color = ownerColor(owner) ?? PALETTE.red;
  const top = y - height;
  g.moveTo(x, y).lineTo(x, top).stroke({ width: 3, color: INK, cap: 'round' });
  g.poly([x, top, x + 24, top + 8, x, top + 16], true)
    .fill(color)
    .stroke({ width: 2, color: INK, join: 'round' });
  const m = label(PLAYER_MARKS[owner % PLAYER_MARKS.length] ?? '', 9, 0xffffff);
  m.style.stroke = { color, width: 0 };
  m.position.set(x + 8, top + 8);
  root.addChild(m);
}

function tree(g: Graphics, x: number, y: number, r: number, color: number = PALETTE.green): void {
  g.rect(x - 2, y - r * 0.9, 4, r * 0.9)
    .fill(PALETTE.door)
    .stroke({ width: 1.5, color: INK });
  g.circle(x, y - r * 1.3, r)
    .fill(color)
    .stroke({ width: 2.5, color: INK });
  g.circle(x - r * 0.3, y - r * 1.55, r * 0.3).fill({ color: 0xffffff, alpha: 0.35 });
}

// ───────────────────────── 住宅 ─────────────────────────

function drawHouse(root: Container, g: Graphics, s: BuildingSpec): BuildingInfo {
  const level = clampLevel('house', s.level);
  const oc = ownerColor(s.owner);
  if (level === 0) {
    // 空地：出售木牌 / 已购插旗
    const c = iso3(0, 0);
    if (s.owner === null) {
      signBoard(root, g, s.sign ?? '出售', c.x, c.y + 4, PALETTE.cream, 16);
      return { heightPx: 44 };
    }
    flag(root, g, c.x - 4, c.y + 6, s.owner);
    return { heightPx: 40 };
  }
  const st = HOUSE_LEVELS[level]!;
  const b = inset(s, level >= 4 ? 0.12 : 0.16);
  const h = st.floors * FLOOR_PX;
  const walls = [st.wall, PALETTE.wallCream, PALETTE.wallMint, PALETTE.wallPink];
  const wall = walls[s.variant % walls.length] ?? st.wall;
  const zTop = drawBox(g, b.w, b.d, h, wall);
  const lf = leftFaceFrame(b.w, b.d, 0, h);
  const rf = rightFaceFrame(b.w, b.d, 0, h);
  const lit = st.details.includes('lights') ? PALETTE.windowLit : undefined;
  drawWindows(g, lf, st.floors, st.cols, PALETTE.glass, { skipDoor: s.door === 'left', lit, litEvery: 3 });
  drawWindows(g, rf, st.floors, st.cols, shade(PALETTE.glass, 0.85), {
    skipDoor: s.door === 'right',
    lit,
    litEvery: 4,
  });
  if (s.door === 'left') drawDoor(g, lf, st.floors, st.cols, PALETTE.door);
  if (s.door === 'right') drawDoor(g, rf, st.floors, st.cols, PALETTE.door);
  const accent = oc ?? NEUTRAL_ROOF;
  if (st.details.includes('awning') && s.door !== 'none') {
    const f = s.door === 'left' ? lf : rf;
    const dv = 1 / st.floors;
    fillPoly(g, faceQuad(f, 0.02, dv * 0.78, 1 / st.cols - 0.02, dv * 0.95), accent);
  }
  if (st.details.includes('balcony') && st.floors >= 2) {
    const dv = 1 / st.floors;
    fillPoly(g, faceQuad(lf, 0.1, dv * 1.02, 0.9, dv * 1.22), shade(accent, 1.05));
  }
  let top = zTop;
  if (st.roof === 'gable') {
    drawGableRoof(g, b.w, b.d, zTop, 18 + level * 4, accent);
    top += 18 + level * 4;
  } else if (st.roof === 'flat') {
    drawParapet(g, b.w, b.d, zTop, wall);
  }
  if (st.details.includes('sign')) {
    const p = iso3(0, 0, zTop);
    signBoard(root, g, s.owner === null ? '洋房' : (PLAYER_MARKS[s.owner] ?? ''), p.x, p.y, oc ?? PALETTE.sun, 8);
    top += 34;
  }
  if (st.details.includes('waterTower')) {
    const p = iso3(-b.w * 0.18, -b.d * 0.18, zTop);
    g.rect(p.x - 3, p.y - 10, 2, 10).fill(INK);
    g.rect(p.x + 7, p.y - 10, 2, 10).fill(INK);
    g.roundRect(p.x - 6, p.y - 26, 18, 16, 5)
      .fill(PALETTE.wallGrey)
      .stroke({ width: 2, color: INK });
    top += 26;
  }
  if (st.details.includes('antenna')) {
    drawSpire(g, zTop, 34, PALETTE.red);
    top += 34;
  }
  if (st.details.includes('flag') && s.owner !== null) {
    const p = iso3(b.w * 0.22, b.d * 0.05, zTop);
    flag(root, g, p.x, p.y, s.owner, 26);
  }
  return { heightPx: top };
}

// ───────────────────────── 设施 ─────────────────────────

function drawFacility(root: Container, g: Graphics, s: BuildingSpec, style: FacilityStyle): BuildingInfo {
  const level = clampLevel(s.kind, s.level);
  const oc = ownerColor(s.owner) ?? PALETTE.sun;
  const c = iso3(0, 0);
  switch (style) {
    case 'vacant': {
      // 大块空地：四角木桩 + 「招商」牌
      for (const [x, y] of [
        [-0.42, -0.42],
        [0.42, -0.42],
        [0.42, 0.42],
        [-0.42, 0.42],
      ] as const) {
        const p = iso3(x * s.w, y * s.d);
        g.rect(p.x - 2, p.y - 12, 4, 12)
          .fill(PALETTE.door)
          .stroke({ width: 1.5, color: INK });
      }
      signBoard(root, g, s.sign ?? '招商', c.x, c.y + 6, PALETTE.cream, 20);
      if (s.owner !== null) flag(root, g, c.x + 36, c.y + 10, s.owner);
      return { heightPx: 50 };
    }
    case 'park': {
      // 公园：树、喷泉、长椅
      const pond = iso3(0, 0);
      g.ellipse(pond.x, pond.y, 34, 17).fill(PALETTE.water).stroke({ width: 2.5, color: INK });
      g.ellipse(pond.x, pond.y - 10, 5, 12).fill({ color: 0xffffff, alpha: 0.85 });
      const spots = [
        [-0.35, -0.3],
        [0.35, -0.32],
        [-0.38, 0.3],
        [0.3, 0.36],
      ] as const;
      spots.forEach(([x, y], i) => {
        const p = iso3(x * s.w, y * s.d);
        tree(g, p.x, p.y, 13 + ((s.variant + i) % 3) * 2, i % 2 ? PALETTE.green : PALETTE.grassDark);
      });
      const bench = iso3(0.05 * s.w, 0.32 * s.d);
      g.rect(bench.x - 14, bench.y - 8, 28, 6)
        .fill(PALETTE.door)
        .stroke({ width: 2, color: INK });
      return { heightPx: 50 };
    }
    case 'gas': {
      const b = inset(s, 0.22);
      // 雨棚立柱 + 顶棚 + 两台油枪
      for (const [x, y] of [
        [-0.3, -0.3],
        [0.3, 0.3],
      ] as const) {
        const p = iso3(x * b.w, y * b.d);
        g.rect(p.x - 3, p.y - 46, 6, 46)
          .fill(PALETTE.wallGrey)
          .stroke({ width: 2, color: INK });
      }
      for (const x of [-0.18, 0.18]) {
        const p = iso3(x * b.w, 0.1 * b.d);
        g.roundRect(p.x - 7, p.y - 22, 14, 22, 3)
          .fill(PALETTE.red)
          .stroke({ width: 2, color: INK });
      }
      drawBox(g, b.w, b.d, 8, oc, { z0: 46 });
      const p = iso3(b.w / 2, 0, 50);
      signBoard(root, g, s.sign ?? '加油', p.x, p.y, PALETTE.cream, 0);
      return { heightPx: 80 };
    }
    case 'hotel':
    case 'mall':
    case 'lab': {
      const floors = FACILITY_FLOORS[style][level] ?? 2;
      const pool = style === 'hotel' && level >= 4;
      const b = inset(s, 0.14);
      const bd = pool ? b.d * 0.62 : b.d;
      const shift = pool ? -(b.d - bd) / 2 : 0;
      if (pool) {
        const q = [
          iso3(-b.w * 0.42, b.d * 0.12),
          iso3(b.w * 0.42, b.d * 0.12),
          iso3(b.w * 0.42, b.d * 0.48),
          iso3(-b.w * 0.42, b.d * 0.48),
        ];
        fillPoly(g, q, PALETTE.water);
      }
      const body = new Graphics();
      const off = iso3(0, shift);
      body.position.set(off.x, off.y);
      root.addChild(body);
      const wall = style === 'hotel' ? PALETTE.wallPink : style === 'mall' ? PALETTE.glass : PALETTE.white;
      const h = Math.max(1, floors) * FLOOR_PX;
      const zTop = drawBox(body, b.w, bd, h, wall);
      const lf = leftFaceFrame(b.w, bd, 0, h);
      const rf = rightFaceFrame(b.w, bd, 0, h);
      const cols = Math.max(2, Math.round(b.w * 2.4));
      if (style === 'mall') {
        // 玻璃幕墙：横向条带
        for (let i = 0; i < floors; i++) {
          const v0 = (i + 0.35) / floors;
          const v1 = (i + 0.85) / floors;
          fillPoly(body, faceQuad(lf, 0.04, v0, 0.96, v1), PALETTE.glassDark, { width: 1.5, color: INK });
          fillPoly(body, faceQuad(rf, 0.04, v0, 0.96, v1), shade(PALETTE.glassDark, 0.85), { width: 1.5, color: INK });
        }
      } else {
        drawWindows(body, lf, floors, cols, PALETTE.glass, { lit: PALETTE.windowLit, litEvery: 5 });
        drawWindows(body, rf, floors, cols, shade(PALETTE.glass, 0.85));
      }
      drawParapet(body, b.w, bd, zTop, wall);
      const fg = new Graphics();
      root.addChild(fg);
      let top = zTop;
      if (style === 'lab') {
        const domes = 1 + Math.floor(level / 2);
        for (let i = 0; i < domes; i++) {
          const t = domes === 1 ? 0 : i / (domes - 1) - 0.5;
          drawDome(body, t * b.w * 0.5, -t * bd * 0.3, zTop, 0.22, PALETTE.wallGrey);
        }
        drawSpire(body, zTop, 30, PALETTE.red);
        top += 36;
      }
      const sp = iso3(0, shift, zTop);
      const signText = s.sign ?? (style === 'hotel' ? 'HOTEL' : style === 'mall' ? '商场' : '研究所');
      signBoard(root, fg, signText, sp.x, sp.y, style === 'hotel' ? PALETTE.pink : oc, style === 'lab' ? 4 : 10);
      if (s.owner !== null) {
        const fp = iso3(b.w * 0.36, shift + bd * 0.2, zTop);
        flag(root, fg, fp.x, fp.y, s.owner, 24);
      }
      return { heightPx: top + 40 };
    }
  }
}

// ───────────────────────── 地标 / 企业 ─────────────────────────

function drawCone(g: Graphics, w: number, d: number, zBase: number, rise: number, color: number): void {
  const apex = iso3(0, 0, zBase + rise);
  const W = iso3(-w / 2, d / 2, zBase);
  const S = iso3(w / 2, d / 2, zBase);
  const E = iso3(w / 2, -d / 2, zBase);
  fillPoly(g, [W, S, apex], shade(color, 0.9));
  fillPoly(g, [S, E, apex], shade(color, 0.7));
}

function drawLandmark(root: Container, g: Graphics, s: BuildingSpec, style: LandmarkStyle): BuildingInfo {
  const look = LANDMARK_LOOKS[style];
  const accent = s.accent ?? look.accent;
  const sign = s.sign ?? look.sign;
  const b = inset(s, 0.14);

  if (style === 'amusement') {
    // 摩天轮：低矮底座 + 轮盘
    const zTop = drawBox(g, b.w, b.d, 14, look.wall);
    const hub = iso3(0, 0, zTop + 46);
    const R = 38;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      g.moveTo(hub.x, hub.y).lineTo(hub.x + Math.cos(a) * R, hub.y + Math.sin(a) * R);
    }
    g.stroke({ width: 2, color: INK });
    g.circle(hub.x, hub.y, R).stroke({ width: 4, color: accent });
    g.circle(hub.x, hub.y, R).stroke({ width: 1.5, color: INK });
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + 0.2;
      g.circle(hub.x + Math.cos(a) * R, hub.y + Math.sin(a) * R, 5)
        .fill([PALETTE.red, PALETTE.blue, PALETTE.sun, PALETTE.green][i % 4]!)
        .stroke({ width: 1.5, color: INK });
    }
    const base = iso3(0, 0, zTop);
    g.moveTo(base.x - 18, base.y)
      .lineTo(hub.x, hub.y)
      .lineTo(base.x + 18, base.y)
      .stroke({ width: 4, color: INK });
    return { heightPx: zTop + 46 + R };
  }

  if (style === 'scenery') {
    return drawScenery(root, g, s, b, accent, sign);
  }

  const h = look.floors * FLOOR_PX;
  const zTop = drawBox(g, b.w, b.d, h, look.wall);
  const lf = leftFaceFrame(b.w, b.d, 0, h);
  const rf = rightFaceFrame(b.w, b.d, 0, h);
  const cols = Math.max(2, Math.round(b.w * 2.2));
  let top = zTop;
  /** 招牌位置（缺省为屋顶中心、高度 top） */
  let signAt: { x: number; y: number } | null = null;
  switch (style) {
    case 'bank': {
      // 立柱 + 三角山花 + $
      for (let i = 0; i < 4; i++) {
        const u = 0.14 + i * 0.24;
        fillPoly(g, faceQuad(lf, u - 0.04, 0.05, u + 0.04, 0.82), 0xffffff, { width: 1.5, color: INK });
      }
      drawWindows(g, rf, look.floors, cols, shade(PALETTE.glass, 0.85));
      drawGableRoof(g, b.w, b.d, zTop, 16, accent, 0.04);
      top += 16;
      break;
    }
    case 'hospital': {
      drawWindows(g, lf, look.floors, cols, PALETTE.glass);
      drawWindows(g, rf, look.floors, cols, shade(PALETTE.glass, 0.85));
      drawParapet(g, b.w, b.d, zTop, look.wall);
      // 屋顶红十字
      const p = iso3(0, 0, zTop);
      g.rect(p.x - 5, p.y - 16, 10, 32).fill(PALETTE.red);
      g.rect(p.x - 16, p.y - 5, 32, 10).fill(PALETTE.red);
      break;
    }
    case 'jail': {
      // 铁窗（深色窗洞 + 竖栏）+ 背角瞭望塔
      for (const f of [lf, rf]) {
        drawWindows(g, f, look.floors, cols, 0x4a5260);
        for (let i = 1; i < cols * 3; i++) {
          const u = i / (cols * 3);
          fillPoly(g, faceQuad(f, u - 0.012, 0.12, u + 0.012, 0.9), 0x2e3440, null);
        }
      }
      drawParapet(g, b.w, b.d, zTop, look.wall);
      // 瞭望塔在背角：插到最底层，避免压住主楼；招牌挪到屋顶前沿，避免挡住塔
      const t = new Graphics();
      const off = iso3(-b.w * 0.32, -b.d * 0.32);
      t.position.set(off.x, off.y);
      root.addChildAt(t, 0);
      const tt = drawBox(t, 0.3, 0.3, h + 44, look.wall);
      drawBox(t, 0.42, 0.42, 10, 0x4a5260, { z0: tt });
      drawCone(t, 0.46, 0.46, tt + 10, 16, PALETTE.steel);
      signAt = iso3(b.w * 0.2, b.d * 0.2, zTop);
      top = Math.max(top, h + 70);
      break;
    }
    case 'news': {
      drawWindows(g, lf, look.floors, cols, PALETTE.glass);
      drawWindows(g, rf, look.floors, cols, shade(PALETTE.glass, 0.85));
      drawParapet(g, b.w, b.d, zTop, look.wall);
      // 碟形天线
      const p = iso3(b.w * 0.15, -b.d * 0.15, zTop);
      g.moveTo(p.x, p.y)
        .lineTo(p.x, p.y - 14)
        .stroke({ width: 3, color: INK });
      g.ellipse(p.x, p.y - 20, 14, 8)
        .fill(0xffffff)
        .stroke({ width: 2, color: INK });
      top += 28;
      break;
    }
    case 'lottery': {
      drawWindows(g, rf, look.floors, cols, shade(PALETTE.glass, 0.85));
      drawDome(g, 0, 0, zTop, Math.min(b.w, b.d) * 0.35, accent);
      top += 40;
      break;
    }
    case 'magic': {
      drawWindows(g, lf, look.floors, 2, 0xfff0a0);
      drawCone(g, b.w, b.d, zTop, 46, accent);
      const apex = iso3(0, 0, zTop + 46);
      g.star(apex.x, apex.y - 6, 5, 8, 4)
        .fill(PALETTE.sun)
        .stroke({ width: 1.5, color: INK });
      top += 56;
      break;
    }
    case 'card': {
      drawWindows(g, rf, look.floors, cols, shade(PALETTE.glass, 0.85));
      drawGableRoof(g, b.w, b.d, zTop, 20, accent);
      top += 20;
      break;
    }
    case 'dept': {
      // 条纹雨棚
      for (let i = 0; i < 6; i++) {
        fillPoly(g, faceQuad(lf, i / 6, 0.2, (i + 1) / 6, 0.3), i % 2 ? 0xffffff : accent, { width: 1, color: INK });
        fillPoly(g, faceQuad(rf, i / 6, 0.2, (i + 1) / 6, 0.3), i % 2 ? 0xffffff : shade(accent, 0.85), {
          width: 1,
          color: INK,
        });
      }
      drawWindows(g, { ...lf, z0: h * 0.32 }, look.floors - 1, cols, PALETTE.glass);
      drawWindows(g, { ...rf, z0: h * 0.32 }, look.floors - 1, cols, shade(PALETTE.glass, 0.85));
      drawParapet(g, b.w, b.d, zTop, look.wall);
      break;
    }
    case 'office': {
      for (let i = 0; i < look.floors; i++) {
        const v0 = (i + 0.3) / look.floors;
        const v1 = (i + 0.8) / look.floors;
        fillPoly(g, faceQuad(lf, 0.05, v0, 0.95, v1), PALETTE.glassDark, { width: 1.2, color: INK });
        fillPoly(g, faceQuad(rf, 0.05, v0, 0.95, v1), shade(PALETTE.glassDark, 0.85), { width: 1.2, color: INK });
      }
      drawParapet(g, b.w, b.d, zTop, look.wall);
      // 企业色腰带
      fillPoly(g, faceQuad(lf, 0, 0.9, 1, 1), accent);
      fillPoly(g, faceQuad(rf, 0, 0.9, 1, 1), shade(accent, 0.8));
      break;
    }
  }
  if (s.door !== 'none') drawDoor(g, s.door === 'left' ? lf : rf, look.floors, cols, PALETTE.door);
  if (sign) {
    const p = signAt ?? iso3(0, 0, top);
    signBoard(root, g, sign, p.x, p.y, style === 'office' ? accent : PALETTE.cream, style === 'magic' ? 4 : 8);
    top += 34;
  }
  if (s.owner !== null) {
    const fp = iso3(b.w * 0.38, b.d * 0.1, zTop);
    flag(root, g, fp.x, fp.y, s.owner, 24);
  }
  return { heightPx: top };
}

function drawScenery(
  root: Container,
  g: Graphics,
  s: BuildingSpec,
  b: { w: number; d: number },
  accent: number,
  sign: string,
): BuildingInfo {
  const kind = s.variant % 4;
  let top = 0;
  if (kind === 0) {
    // 宝塔：逐层收小的盒子 + 坡顶
    let z = 0;
    for (let i = 0; i < 4; i++) {
      const k = 1 - i * 0.18;
      z = drawBox(g, b.w * 0.7 * k, b.d * 0.7 * k, 20, PALETTE.wallCream, { z0: z });
      drawGableRoof(g, b.w * 0.8 * k, b.d * 0.8 * k, z, 10, accent);
      z += 10;
    }
    drawSpire(g, z, 18, PALETTE.sun);
    top = z + 18;
  } else if (kind === 1) {
    // 灯塔：红白条纹高塔
    let z = 0;
    for (let i = 0; i < 5; i++) z = drawBox(g, 0.42, 0.42, 22, i % 2 ? accent : 0xffffff, { z0: z });
    drawBox(g, 0.54, 0.54, 12, PALETTE.windowLit, { z0: z });
    drawCone(g, 0.6, 0.6, z + 12, 18, accent);
    top = z + 30;
  } else if (kind === 2) {
    // 牌坊
    const l = iso3(-b.w * 0.3, b.d * 0.3);
    const r = iso3(b.w * 0.3, -b.d * 0.3);
    for (const p of [l, r])
      g.rect(p.x - 5, p.y - 70, 10, 70)
        .fill(accent)
        .stroke({ width: 2.5, color: INK });
    g.poly([l.x - 22, l.y - 74, r.x + 22, r.y - 74, r.x + 16, r.y - 88, l.x - 16, l.y - 88], true)
      .fill(INK)
      .stroke({ width: 2, color: INK });
    g.moveTo(l.x, l.y - 56)
      .lineTo(r.x, r.y - 56)
      .stroke({ width: 6, color: accent });
    top = 96;
  } else {
    // 纪念碑 + 两棵树
    const z = drawBox(g, b.w * 0.5, b.d * 0.5, 12, PALETTE.wallGrey);
    drawBox(g, 0.22, 0.22, 60, PALETTE.white, { z0: z });
    drawCone(g, 0.22, 0.22, z + 60, 12, PALETTE.wallGrey);
    const t1 = iso3(-b.w * 0.36, b.d * 0.3);
    const t2 = iso3(b.w * 0.3, -b.d * 0.36);
    tree(g, t1.x, t1.y, 12);
    tree(g, t2.x, t2.y, 11, PALETTE.grassDark);
    top = z + 72;
  }
  if (sign) {
    const p = iso3(b.w * 0.3, b.d * 0.3);
    signBoard(root, g, sign, p.x, p.y, PALETTE.cream, 14);
  }
  return { heightPx: top };
}

// ───────────────────────── 入口 ─────────────────────────

/** 把建筑画进 root（局部原点 = footprint 中心地面点） */
export function drawBuilding(root: Container, s: BuildingSpec): BuildingInfo {
  const g = new Graphics();
  root.addChild(g);
  if (s.kind === 'house') return drawHouse(root, g, s);
  if (s.kind.startsWith('facility:')) return drawFacility(root, g, s, s.kind.slice(9) as FacilityStyle);
  return drawLandmark(root, g, s, s.kind.slice(9) as LandmarkStyle);
}

/** 生成（或取缓存的）建筑纹理 */
export function getBuildingTexture(cache: TextureCache, s: BuildingSpec) {
  return cache.get(buildingKey(s), () => {
    const c = new Container();
    drawBuilding(c, s);
    return c;
  });
}

/** 描边常量再导出，供其他绘制模块统一风格 */
export { INK_STROKE };
