// 标题 / 开局设置 / 选人画面的几何（original-skin.md §4.3；design-draft §4.3；ui.md §2.3 标题与开局设置）。
// 640×480 逻辑坐标；原版没有逐屏逆向这几屏的坐标，下面的取值来源：
// - 标题三钮（Data#1 图1–6）的画点：本机用 test/w3-title-match.mjs 把常态帧贴到底图烘焙的图标上逐像素比对（visual）；
// - 开局竖栏（jump#4 图1）里 6 个下拉框、OK / EXIT、关卡行：test/w3-setup-boxes.mjs 与 w3-scanline.mjs 找白框与色块（visual）；
// - 12 头像格（jump#4 图0）：6×2 格，每格 68×68 色块 + 1px 白边、间距 72（visual）；
// - 竖栏在整屏上的位置、关卡行的点击区与打勾位置、背景 jump#gm、飞行动画 Fly*.avi：按 exe（@source 见各常量）；
// - 头像格、走动预览、座位牌在整屏上的摆放：按素材尺寸目视排版（visual；头像格原版在 (4,10)，见 GRID 的说明）。
// 纯数据与纯函数，不碰 DOM。
import { CHARACTER_IDS, type CharacterId, type StartVehicle } from '@rich4/shared/engine';
import type { Rect } from '../layout';

// ───────────────────────── 素材键 ─────────────────────────

export const TITLE_SHEET = 'title.screen';
export const SETUP_SHEET = 'title.setup.ui';
/** 开局设置背景：台湾 jump#0（其他地图见 setupBgKey） */
export const SETUP_BG = 'title.setup.bg';
export const LOADING_IMAGE = 'title.loading';
export const INTRO_VIDEO = 'video.start';
export const FACE_SHEET = 'portrait.face72';

/** 选人画面侧视走动（jump#5+3c+v）：v = 步行 / 机车 / 汽车 */
export function sidewalkKey(c: CharacterId | number, v: StartVehicle): string {
  return `title.sidewalk.${c}.${v}`;
}

export const SIDEWALK_VEHICLES: readonly StartVehicle[] = ['walk', 'moto', 'car'];

/** 原版画面整体切换需要的全部条目（任一不可用 → 标题、开局、大厅整体回退程序化） */
export const SCREEN_KEYS: readonly string[] = [
  TITLE_SHEET,
  SETUP_SHEET,
  SETUP_BG,
  FACE_SHEET,
  ...CHARACTER_IDS.flatMap((c) => SIDEWALK_VEHICLES.map((v) => sidewalkKey(c, v))),
];

// ───────────────────────── 标题（Data#1） ─────────────────────────

export type TitleButtonId = 'start' | 'load' | 'option';

export interface TitleButtonSpec {
  id: TitleButtonId;
  /** 常态帧（底图已烘焙同一图标，常态时不另画）、悬停帧 */
  normal: number;
  hover: number;
  /** 画点（帧按各自的锚点落点） */
  x: number;
  y: number;
  /** 命中矩形（悬停帧的外框，底边截到按钮带上方） */
  hit: Rect;
}

/** 按钮带（昵称、加入、单机、公开房间）：y 422..478，高 56（手机横屏 0.8125 倍时约 45 CSS 像素） */
export const BAND_Y = 422;
export const BAND_H = 56;

export const TITLE_BUTTONS: readonly TitleButtonSpec[] = [
  { id: 'start', normal: 1, hover: 2, x: 190, y: 380, hit: { x: 131, y: 323, w: 116, h: BAND_Y - 323 } },
  { id: 'load', normal: 3, hover: 4, x: 328, y: 381, hit: { x: 273, y: 327, w: 114, h: BAND_Y - 327 } },
  { id: 'option', normal: 5, hover: 6, x: 469, y: 377, hit: { x: 416, y: 331, w: 103, h: BAND_Y - 331 } },
];

/** EXIT（图7 常态、图8 悬停，锚点在中心）：标题画面里当作各面板的「关闭」钮 */
export const EXIT_FRAMES = { normal: 7, hover: 8 } as const;

export const TITLE_BAND = {
  nickname: { x: 10, y: BAND_Y, w: 228, h: BAND_H },
  join: { x: 250, y: BAND_Y, w: 124, h: BAND_H },
  solo: { x: 380, y: BAND_Y, w: 124, h: BAND_H },
  public: { x: 510, y: BAND_Y, w: 124, h: BAND_H },
} as const satisfies Record<string, Rect>;

/** 标题上的面板（加入房间、设置）：画面中央 */
export const TITLE_PANEL: Rect = { x: 150, y: 120, w: 340, h: 200 };

// ───────────────────────── 开局设置 / 选人（jump#0 + jump#4） ─────────────────────────

/**
 * 竖栏（图1 192×461）贴在整屏 (445, 10)，右边留 3 像素背景（445 + 192 = 637）。
 * 竖栏里的关卡行、OK / EXIT、下拉框都相对它推算，与 exe 点击区表 0x46aac4 对得上：
 * OK (456,176)–(535,215)、EXIT (544,176)–(623,215)、下拉箭头 x 602–625、关卡行 (457,31+32k)–(625,62+32k)。
 * @source exe v2.06 0x404f6f–0x404f83：push 0xa; push 0x1bd; 竖栏表面 [0x4873a4]; 屏幕 [0x487084]; call 0x454a55
 *   （同一段 0x404f55–0x404f67 把头像格表面 [0x4873a8] 贴在 (4,10)）
 */
export const COLUMN = { x: 445, y: 10, w: 192, h: 461 } as const;

/**
 * 竖栏里的关卡行（关卡一–四，底色交替）的点击区：竖栏内 (12, 21+32k)–(180, 52+32k)，
 * 即整屏 (457, 31+32k)–(625, 62+32k)，两端含
 * @source exe v2.06 VA 0x46aac4 开局设置点击区表第 9–12 项（整屏坐标；0x40519e 经跳转表分派到 0x405428）
 */
export function stageRow(k: number): Rect {
  return { x: COLUMN.x + 12, y: COLUMN.y + 21 + 32 * k, w: 180 - 12 + 1, h: 52 - 21 + 1 };
}

/**
 * 关卡 k 的打勾（jump#4 图8，锚点 (0,0)）画在竖栏内 (150, 20+32k)，即整屏 (595, 30+32k)
 * @source exe v2.06 0x405428–0x4054c7：x = 0x96，y = word[0x46ab2c + 2k] = (20, 52, 84, 116)，画在竖栏表面 [0x4873a4] 上
 */
export function stageCheck(k: number): { x: number; y: number } {
  return { x: COLUMN.x + 150, y: COLUMN.y + 20 + 32 * k };
}

/**
 * 关卡 k → 地图 id；下标就是原版地图号 gm（台湾 0、大陆 1、日本 2、美国 3）
 * @source exe v2.06 0x4070e1：按 OK 后 gm = 所选关卡号 [0x46aa00]；与 SaveLoadScreen 的存档缩图顺序一致
 */
export const STAGE_MAPS: readonly string[] = ['taiwan', 'china', 'japan', 'usa'];

/** 原版地图号 gm（不是原版四张图的返回 null） */
export function stageOf(mapId: string | null | undefined): number | null {
  const k = mapId ? STAGE_MAPS.indexOf(mapId) : -1;
  return k < 0 ? null : k;
}

/**
 * 开局设置 / 选人画面的背景（jump#gm）：台湾沿用 title.setup.bg（jump#0），其他三张图 title.setup.bg.<id>（jump#1–3）；
 * 不是原版四张图（fixture）用台湾的。条目不可用时由画面回退到 SETUP_BG（ClassicCreate 的 SetupBg）
 * @source exe v2.06 0x406c05 以 [0x495ec0]（gm）为资源号读 JUMP.MKF；点关卡行后 0x40549c–0x4054c7 重新载入 jump#k
 */
export function setupBgKey(mapId: string | null | undefined): string {
  const k = stageOf(mapId);
  return k === null || k === 0 ? SETUP_BG : `${SETUP_BG}.${STAGE_MAPS[k]}`;
}

/**
 * 进入棋盘前的飞行动画（素材包 video 条目，Media/Fly*.avi 转码）
 * @source exe v2.06 VA 0x472f78 指针表按 gm = FLYTW / FLYCHINA / FLYJP / FLYUS.AVI；0x41523e 查表，0x415246 调播放器
 */
export const FLY_VIDEO: Readonly<Record<string, string>> = {
  taiwan: 'video.flytw',
  china: 'video.flychina',
  japan: 'video.flyjp',
  usa: 'video.flyus',
};

/** 地图的飞行动画条目键（不是原版四张图为 null） */
export function flyVideoKey(mapId: string | null | undefined): string | null {
  return mapId && Object.hasOwn(FLY_VIDEO, mapId) ? FLY_VIDEO[mapId]! : null;
}

/** OK / EXIT（烘焙在竖栏里，77×37）；命中矩形上下补到 56 高（关卡行之下、第一个下拉框之上） */
export const COLUMN_OK: Rect = { x: COLUMN.x + 12, y: COLUMN.y + 158, w: 77, h: 56 };
export const COLUMN_EXIT: Rect = { x: COLUMN.x + 100, y: COLUMN.y + 158, w: 77, h: 56 };

export type SetupField = 'aiCount' | 'initialFund' | 'vehicle' | 'tenure' | 'timeLimitDays' | 'winMultiple';

/** 6 个下拉（人数、总资金、行进方式、土地期限、游戏时间、胜利条件）：白框位置（竖栏内实测），右侧 25 宽为箭头 */
export const SETUP_FIELDS: readonly { field: SetupField; box: Rect }[] = [
  { field: 'aiCount', box: { x: 118, y: 218, w: 38, h: 20 } },
  { field: 'initialFund', box: { x: 93, y: 254, w: 63, h: 20 } },
  { field: 'vehicle', box: { x: 118, y: 290, w: 38, h: 20 } },
  { field: 'tenure', box: { x: 93, y: 326, w: 63, h: 20 } },
  { field: 'timeLimitDays', box: { x: 93, y: 362, w: 63, h: 20 } },
  { field: 'winMultiple', box: { x: 73, y: 398, w: 83, h: 20 } },
];

/** 下拉框（白框 + 箭头）在整屏上的矩形 */
export function fieldRect(box: Rect): Rect {
  return { x: COLUMN.x + box.x, y: COLUMN.y + box.y - 2, w: box.w + 26, h: box.h + 4 };
}

/** 下拉框左边的标签（右对齐到白框左侧 6 像素处） */
export function fieldLabelRect(box: Rect): Rect {
  return { x: COLUMN.x + 8, y: COLUMN.y + box.y, w: box.x - 14, h: box.h };
}

/** 12 头像格（图0 440×155）贴在左下角（原版在 (4,10)，exe 0x404f55–0x404f67；已知不同、未改，见 VERIFY V-U10） */
export const GRID = { x: 4, y: 321, w: 440, h: 155 } as const;

/** 第 id 个角色的格子（6 列 × 2 行，间距 72；头像 72×72 盖住 68×68 色块与白边） */
export function gridCell(id: number): Rect {
  const col = id % 6;
  const row = Math.floor(id / 6);
  return { x: GRID.x + 4 + 72 * col, y: GRID.y + 5 + 72 * row, w: 72, h: 72 };
}

/** 选人预览行：◀、名字、▶、「选这个」；钮宽高 ≥56（手机横屏约 45 CSS 像素） */
export const PREVIEW = {
  prev: { x: 8, y: 76, w: 56, h: 56 },
  name: { x: 66, y: 76, w: 140, h: 56 },
  next: { x: 208, y: 76, w: 56, h: 56 },
  select: { x: 270, y: 76, w: 170, h: 56 },
} as const satisfies Record<string, Rect>;

/** 侧视走动的路线：脚底 y 306，x 在 [WALK_X0, WALK_X1] 之间往返 */
export const WALK_Y = 306;
export const WALK_X0 = 70;
export const WALK_X1 = 380;
/** 走动的帧间隔与速度（原版未核实，目视取值） */
export const WALK_FRAME_MS = 90;
export const WALK_SPEED = { walk: 40, moto: 90, car: 120 } as const satisfies Record<StartVehicle, number>;

/**
 * 走动预览在 t 毫秒时的位置、朝向与帧：从 WALK_X0 走到 WALK_X1 再折返（向左走时水平翻转），帧号按时间循环。
 */
export function walkerAt(
  tMs: number,
  frames: number,
  vehicle: StartVehicle,
): { x: number; frame: number; facingLeft: boolean } {
  const span = WALK_X1 - WALK_X0;
  const speed = WALK_SPEED[vehicle];
  const d = ((Math.max(0, tMs) / 1000) * speed) % (2 * span);
  const back = d > span;
  const x = back ? WALK_X1 - (d - span) : WALK_X0 + d;
  const frame = frames > 0 ? Math.floor(Math.max(0, tMs) / WALK_FRAME_MS) % frames : 0;
  return { x: Math.round(x), frame, facingLeft: back };
}

/** 座位牌（4 个，画面上方；只显示，不可点） */
export function seatPlate(i: number): Rect {
  return { x: 6 + i * 110, y: 6, w: 106, h: 64 };
}

/** 联机设置面板（开局设置画面左侧） */
export const ONLINE_PANEL: Rect = { x: 8, y: 64, w: 428, h: 250 };
/** 手机横屏 / 粗指针：全部设置排成两列（14 项 + 快速局，8 行 × 行高 56） */
export const WIDE_PANEL: Rect = { x: 6, y: 14, w: 436, h: 460 };
export const WIDE_ROW_H = 56;
