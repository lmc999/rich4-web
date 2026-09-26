// /dev/gallery 的 Pixi 部分：建筑各等级、设施、地标、企业造型，外加一条角色图集（验证 SVG→Canvas→纹理 管线）。
import type { IndustryKey } from '@rich4/shared/data';
import { Application, Container, Graphics, Sprite, Text } from 'pixi.js';
import { isoToScreen } from '../game/iso/projection';
import { type BuildingSpec, getBuildingTexture } from '../game/procedural/building/generate';
import {
  FACILITY_MAX_LEVEL,
  type FacilityStyle,
  INDUSTRY_LOOKS,
  INK,
  LANDMARK_STYLES,
  MAX_HOUSE_LEVEL,
} from '../game/procedural/building/styles';
import { buildCharacterFrames, type CharacterFrames } from '../game/procedural/character/atlas';
import { characterByKey } from '../game/procedural/character/defs';
import { FACINGS, POSES } from '../game/procedural/character/rig';
import { TextureCache } from '../game/procedural/textureCache';
import { FONT_TITLE } from '../ui/theme/fontFamilies';

export interface GalleryItem {
  spec: BuildingSpec;
  caption: string;
}

export interface GalleryRow {
  title: string;
  items: GalleryItem[];
}

const base = (s: Partial<BuildingSpec> & Pick<BuildingSpec, 'kind'>): BuildingSpec => ({
  level: 1,
  w: 1,
  d: 1,
  owner: null,
  variant: 0,
  door: 'left',
  ...s,
});

/** 画廊内容（纯数据，可单测） */
export function galleryRows(): GalleryRow[] {
  const rows: GalleryRow[] = [];
  rows.push({
    title: '住宅 0–5 级（无主 / 有主）',
    items: [
      ...Array.from({ length: MAX_HOUSE_LEVEL + 1 }, (_, lv) => ({
        spec: base({ kind: 'house', level: lv, owner: lv === 0 ? null : (lv - 1) % 4, variant: lv }),
        caption: `L${lv}${lv === 0 ? ' 出售' : ` P${((lv - 1) % 4) + 1}`}`,
      })),
      { spec: base({ kind: 'house', level: 0, owner: 2 }), caption: 'L0 已购 P3' },
    ],
  });
  rows.push({
    title: '住宅 · 门朝向与玩家色',
    items: [0, 1, 2, 3].map((o) => ({
      spec: base({ kind: 'house', level: 3, owner: o, door: o % 2 ? 'right' : 'left', variant: o }),
      caption: `L3 P${o + 1} ${o % 2 ? '右门' : '左门'}`,
    })),
  });
  const fac = (style: FacilityStyle): GalleryItem[] => {
    const max = FACILITY_MAX_LEVEL[style];
    const levels = style === 'vacant' ? [0] : Array.from({ length: max }, (_, i) => i + 1);
    return levels.map((lv) => ({
      spec: base({ kind: `facility:${style}`, level: lv, w: 2, d: 2, owner: style === 'vacant' ? null : 0 }),
      caption: `${style} L${lv}`,
    }));
  };
  rows.push({ title: '设施：空地 / 公园 / 加油站', items: [...fac('vacant'), ...fac('park'), ...fac('gas')] });
  rows.push({ title: '设施：旅馆 1–5', items: fac('hotel') });
  rows.push({ title: '设施：购物中心 1–5', items: fac('mall') });
  rows.push({ title: '设施：研究所 1–5', items: fac('lab') });
  rows.push({
    title: '地标',
    items: LANDMARK_STYLES.map((s) => ({ spec: base({ kind: `landmark:${s}`, w: 2, d: 2 }), caption: s })),
  });
  rows.push({
    title: '景点变体',
    items: [0, 1, 2, 3].map((v) => ({
      spec: base({ kind: 'landmark:scenery', w: 2, d: 2, variant: v, sign: `景点${v + 1}` }),
      caption: `scenery v${v}`,
    })),
  });
  rows.push({
    title: '企业（按行业）',
    items: (Object.keys(INDUSTRY_LOOKS) as IndustryKey[]).map((k) => {
      const look = INDUSTRY_LOOKS[k];
      return {
        spec: base({ kind: `landmark:${look.style}`, w: 2, d: 2, accent: look.accent, sign: look.sign }),
        caption: k,
      };
    }),
  });
  return rows;
}

const SLOT_W = 190;
const ROW_H = 300;
const TITLE_H = 34;

export interface GalleryHandle {
  app: Application;
  destroy(): void;
}

function caption(text: string, size = 14): Text {
  const t = new Text({ text, style: { fontFamily: FONT_TITLE, fontSize: size, fill: INK }, resolution: 2 });
  t.anchor.set(0.5, 0);
  return t;
}

/** 挂载建筑画廊到 host（宽度取 host 当前宽度，高度按内容） */
export async function mountBuildingGallery(host: HTMLElement, atlasKeys: readonly string[]): Promise<GalleryHandle> {
  const rows = galleryRows();
  const width = Math.max(640, host.clientWidth);
  const perRow = Math.max(1, Math.floor((width - 20) / SLOT_W));
  const layoutRows = rows.flatMap((r) => {
    const chunks: GalleryRow[] = [];
    for (let i = 0; i < r.items.length; i += perRow)
      chunks.push({ title: i === 0 ? r.title : '', items: r.items.slice(i, i + perRow) });
    return chunks;
  });
  const atlasRowH = 150;
  const height = layoutRows.length * (ROW_H + TITLE_H) + atlasKeys.length * FACINGS.length * atlasRowH + 60;
  const app = new Application();
  await app.init({
    width,
    height,
    background: 0xfff6dc,
    antialias: true,
    autoDensity: true,
    resolution: Math.min(2, globalThis.devicePixelRatio || 1),
  });
  host.appendChild(app.canvas);
  const cache = new TextureCache(app.renderer, 2);
  const root = new Container();
  app.stage.addChild(root);

  let y = 10;
  for (const r of layoutRows) {
    if (r.title) {
      const t = caption(r.title, 18);
      t.anchor.set(0, 0);
      t.position.set(12, y);
      root.addChild(t);
    }
    y += TITLE_H;
    r.items.forEach((it, i) => {
      const cx = 10 + SLOT_W * i + SLOT_W / 2;
      const gy = y + ROW_H - 64;
      // 地块底板
      const plate = new Graphics();
      const s = it.spec;
      const pts = [
        isoToScreen(-s.w / 2, -s.d / 2),
        isoToScreen(s.w / 2, -s.d / 2),
        isoToScreen(s.w / 2, s.d / 2),
        isoToScreen(-s.w / 2, s.d / 2),
      ].flatMap((p) => [p.x * (s.w > 1 ? 0.68 : 1), p.y * (s.w > 1 ? 0.68 : 1)]);
      plate.poly(pts, true).fill(0xd7efb0).stroke({ width: 2, color: INK, alpha: 0.4 });
      plate.position.set(cx, gy);
      root.addChild(plate);
      const tex = getBuildingTexture(cache, s);
      const sp = new Sprite(tex.texture);
      sp.anchor.set(tex.anchor.x, tex.anchor.y);
      sp.position.set(cx, gy);
      if (s.w > 1) sp.scale.set(0.68);
      root.addChild(sp);
      const c = caption(it.caption);
      c.position.set(cx, y + ROW_H - 26);
      root.addChild(c);
    });
    y += ROW_H;
  }

  // 角色图集条：每个角色两行（正面 / 背面），11 个姿势
  const frames: CharacterFrames[] = [];
  for (const key of atlasKeys) {
    const f = await buildCharacterFrames(characterByKey(key), 2);
    frames.push(f);
    for (const facing of FACINGS) {
      const t = caption(`${key} · ${facing}（Pixi 图集）`, 15);
      t.anchor.set(0, 0);
      t.position.set(12, y);
      root.addChild(t);
      POSES.forEach((pose, i) => {
        const sp = new Sprite(f.get(pose, facing));
        sp.anchor.set(0.5, 150 / 160);
        sp.scale.set(0.8);
        sp.position.set(50 + i * Math.min(90, (width - 60) / POSES.length), y + atlasRowH - 10);
        root.addChild(sp);
      });
      y += atlasRowH;
    }
  }

  return {
    app,
    destroy() {
      for (const f of frames) f.destroy();
      cache.clear();
      app.destroy({ removeView: true }, { children: true });
    },
  };
}
