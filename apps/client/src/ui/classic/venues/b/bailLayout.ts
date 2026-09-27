// 监狱（Panel#63）/ 四大恶人（Panel#64）/ 医院（Panel#65）的布局常量与纯函数（ui.md §2.3）。
// - 监狱底图是一面砖墙，8 个窗洞是透明孔（4×2；左上角与尺寸按本机真实素材包逐像素统计）；囚犯大头（图 5+角色、恶人 17+恶人）
//   的锚点是相对窗洞左上角的偏移（负值），所以画点 = 窗洞左上角；铁栏（图3 132×137）盖在窗洞上，选中时换成开着的门（图4）；
// - 医院底图的走廊右侧有 2 列 × 4 行病床（点滴架 + 蓝色名牌）；病人（图 14+角色、恶人 26+恶人）按同一画点叠在名牌上方
//   （画点 = 名牌左上角 + (21, −83)，visual）；
// - 8 格的分配：上排 / 左列是 4 个座位（座位 i 在第 i 格），下排 / 右列是 4 个恶人（小偷、强盗、流氓、间谍）；
// - 图21（监狱）/ 图30（医院）是点券框（左边一叠点券），右边写数字；讲话框（图1，尾巴在右下）写提示与选中目标的说明。
import { type SeatIndex, VILLAIN_KINDS, type VillainKind } from '@rich4/shared/engine';
import type { Rect } from '../../layout';

export const JAIL_SHEET = 'venue.jail.screen';
export const HOSPITAL_SHEET = 'venue.hospital.screen';
export const VILLAIN_SHEET = 'venue.jail.villains';

export type BailWhere = 'jail' | 'hospital';

export const JAIL_FRAME = { bg: 0, bubble: 1, bars: 3, door: 4, head0: 5, villainHead0: 17, points: 21 } as const;
export const HOSPITAL_FRAME = { bg: 0, bubble: 1, nurse: 4, bed0: 14, villainBed0: 26, points: 30 } as const;

/** 监狱 8 个窗洞（x, y, w, h） */
export const JAIL_WINDOWS: readonly Rect[] = [
  { x: 34, y: 25, w: 123, h: 135 },
  { x: 179, y: 25, w: 127, h: 135 },
  { x: 336, y: 25, w: 123, h: 135 },
  { x: 487, y: 25, w: 125, h: 135 },
  { x: 33, y: 184, w: 122, h: 136 },
  { x: 184, y: 184, w: 122, h: 136 },
  { x: 335, y: 184, w: 121, h: 136 },
  { x: 486, y: 184, w: 122, h: 136 },
];

/** 医院 8 张病床的名牌（外框左上角，147×37） */
export const HOSPITAL_PLATES: readonly { x: number; y: number }[] = [
  { x: 297, y: 66 },
  { x: 297, y: 186 },
  { x: 297, y: 306 },
  { x: 297, y: 426 },
  { x: 481, y: 66 },
  { x: 481, y: 186 },
  { x: 481, y: 306 },
  { x: 481, y: 426 },
];
export const PLATE = { w: 147, h: 37 } as const;
/** 病人画点相对名牌左上角 */
export const BED_OFFSET = { x: 21, y: -83 } as const;

/** 格子 → 座位或恶人 */
export type BailCell = { k: 'seat'; seat: SeatIndex } | { k: 'villain'; kind: VillainKind };

export function bailCell(i: number): BailCell {
  return i < 4 ? { k: 'seat', seat: i as SeatIndex } : { k: 'villain', kind: VILLAIN_KINDS[i - 4]! };
}

export function villainIndex(kind: VillainKind): number {
  return VILLAIN_KINDS.indexOf(kind);
}

/** 格子的可点矩形（场景坐标）：监狱 = 窗洞；医院 = 病床（名牌与上方的床位） */
export function cellRect(where: BailWhere, i: number): Rect {
  if (where === 'jail') return JAIL_WINDOWS[i]!;
  const p = HOSPITAL_PLATES[i]!;
  return { x: p.x + 34, y: p.y - 60, w: PLATE.w - 34, h: 60 + PLATE.h };
}

/** 人像画点（锚点落点）：监狱为窗洞左上角；医院为名牌左上角 + BED_OFFSET */
export function portraitAt(where: BailWhere, i: number): { x: number; y: number } {
  if (where === 'jail') {
    const w = JAIL_WINDOWS[i]!;
    return { x: w.x, y: w.y };
  }
  const p = HOSPITAL_PLATES[i]!;
  return { x: p.x + BED_OFFSET.x, y: p.y + BED_OFFSET.y };
}

/** 人像帧：监狱大头 / 医院病床；角色 0–11、恶人按 VILLAIN_KINDS 顺序 */
export function portraitFrame(
  where: BailWhere,
  cell: { k: 'seat'; character: number } | { k: 'villain'; kind: VillainKind },
): number {
  const base =
    where === 'jail'
      ? cell.k === 'seat'
        ? JAIL_FRAME.head0
        : JAIL_FRAME.villainHead0
      : cell.k === 'seat'
        ? HOSPITAL_FRAME.bed0
        : HOSPITAL_FRAME.villainBed0;
  return base + (cell.k === 'seat' ? Math.min(11, Math.max(0, cell.character)) : villainIndex(cell.kind));
}

/** 铁栏（132×137）盖在窗洞上：水平居中、上边对齐 */
export function barsAt(i: number): { x: number; y: number } {
  const w = JAIL_WINDOWS[i]!;
  return { x: w.x + Math.round((w.w - 132) / 2), y: w.y - 1 };
}

/** 开着的门（87×137）：靠窗洞右边 */
export function doorAt(i: number): { x: number; y: number } {
  const w = JAIL_WINDOWS[i]!;
  return { x: w.x + w.w - 87 + 4, y: w.y - 1 };
}

/** 名字牌（格子下方 / 名牌上）的位置：左上角与宽 */
export function nameTagAt(where: BailWhere, i: number): Rect {
  if (where === 'jail') {
    const w = JAIL_WINDOWS[i]!;
    return { x: w.x, y: w.y + w.h + 1, w: w.w, h: 16 };
  }
  const p = HOSPITAL_PLATES[i]!;
  return { x: p.x + 6, y: p.y + 4, w: PLATE.w - 12, h: PLATE.h - 8 };
}

/** 下方的讲话框、YES/NO、点券框、恶人全身像（监狱 / 医院各一套，visual） */
export const BAIL_UI: Readonly<
  Record<
    BailWhere,
    {
      bubble: { x: number; y: number };
      yesno: { x: number; y: number };
      points: { x: number; y: number };
      villain: { x: number; y: number } | null;
      nurse?: { x: number; y: number };
    }
  >
> = {
  jail: {
    bubble: { x: 18, y: 338 },
    yesno: { x: 222, y: 352 },
    points: { x: 330, y: 356 },
    villain: { x: 548, y: 478 },
  },
  hospital: {
    bubble: { x: 4, y: 36 },
    yesno: { x: 8, y: 304 },
    points: { x: 10, y: 364 },
    villain: null,
    nurse: { x: 110, y: 118 },
  },
};

/** 讲话框的文字区（框内；框 185×81，尾巴在右下） */
export const BUBBLE_TEXT: Rect = { x: 11, y: 5, w: 163, h: 60 };
/** 点券框里数字的位置（框内；左边是点券图案） */
export const POINTS_TEXT: Rect = { x: 36, y: 10, w: 48, h: 20 };
