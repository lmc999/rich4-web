/**
 * 原版皮肤 A2：v2.06 图像资源目录（docs/design/original-skin.md §5 A2；design-draft §2.4）。
 *
 * 逻辑键 → (mkf, 资源号, kind, 帧语义, 透明规则, 分组, 置信度, 证据)。编号权威：
 * docs/research/original-assets/{sprites,render,ui}.md，帧数为本机 v2.06 Steam 文件实测（build 时逐项核对，不符即失败）。
 *
 * - 置信度：exe = 有反汇编证据；visual = 只凭目视；guess = 推测（前端默认回退程序化）。
 * - 只收录原版皮肤要用的资源；其余逐段列入 exclusions 并写明原因（其他地图的专属资源、地图结构数据、help 文本），
 *   覆盖率 = (收录 + 明确排除) / 总资源数，未收录清单由 build 输出到 .cache。
 * - FLIC 的用途、尺寸、帧数、同步音效来自 A3 的 data/flic.ts（exe 调用点逐一解出），这里只决定逻辑键与分组。
 * - 客户端只认逻辑键；原版资源号只作为证据（src 第一项 `<mkf>#<res>`）。
 */
import type { AssetCategory, Confidence } from '@rich4/shared/assets';
import { FLIC_DEFS, type FlicDef, type FlicMkf } from './data/flic';

export type CatalogMkf = 'Data' | 'Panel' | 'jump' | 'map' | 'help';
export const CATALOG_MKFS: readonly CatalogMkf[] = ['Data', 'Panel', 'jump', 'map', 'help'];

/** 相对 original/ 的路径（大小写不敏感查找） */
export const CATALOG_MKF_FILES: Readonly<Record<CatalogMkf, string>> = {
  Data: 'Game/Data.mkf',
  Panel: 'Game/Panel.mkf',
  jump: 'Game/jump.mkf',
  map: 'Game/map.mkf',
  help: 'Game/help.mkf',
};

/** v2.06 各图像 MKF 的资源总数（containers.md §2；build 时核对） */
export const V206_RESOURCE_COUNTS: Readonly<Record<CatalogMkf, number>> = {
  Data: 561,
  Panel: 113,
  jump: 67,
  map: 150,
  help: 100,
};

/** `assets build --only` 的图像部分：board 棋盘与棋子 · ui 界面/场所/卡片/插图/标题 · fx FLIC 特效 · minigame 小游戏 */
export type ImageToken = 'board' | 'ui' | 'fx' | 'minigame';
export const IMAGE_TOKENS: readonly ImageToken[] = ['board', 'ui', 'fx', 'minigame'];

/** 帧语义（ls / preview 显示用） */
export type FrameRule =
  | 'actor-8dir'
  | 'building-8'
  | 'road-object-8'
  | 'decor'
  | 'by-character'
  | 'anim'
  | 'ui-parts'
  | 'static';

interface ItemBase {
  /** manifest.entries 的逻辑键 */
  key: string;
  mkf: CatalogMkf;
  res: number;
  group: string;
  token: ImageToken;
  confidence: Confidence;
  /** 证据（`<mkf>#<res>` 由 build 自动放在第一项） */
  src: readonly string[];
  desc: string;
}

export interface SpriteItem extends ItemBase {
  type: 'sprite';
  kind: 'SPR' | 'SMP';
  /** 期望帧数；'x8' = 8 的整数倍（角色姿态库，各角色帧数不同） */
  frames: number | 'x8';
  dirs: 1 | 8;
  frameRule: FrameRule;
  /** SPR：index0；SMP：rgb0（叠加图）或 rgb0-backdrop（含整屏/整块底图，客户端先铺黑底） */
  transparency: 'index0' | 'rgb0' | 'rgb0-backdrop';
  /** map.mkf 建筑类 SPR：调色板 255 = 主人色描边（另出白色掩膜页） */
  ownerMask: boolean;
  anchor: 'frame' | 'center';
}

export interface ImageItem extends ItemBase {
  type: 'image';
  kind: 'RAW16';
  w: number;
  h: number;
  /**
   * v2.06 的 RAW16 整图全部不透明（卡片插画按 exe 0x440c95 的不透明拷贝核实，见 CARD_ART_EVIDENCE）；
   * corner-rgb0（四角泛洪抠 0 值）只为旧素材包的契约保留，目录里不再使用
   */
  transparency: 'opaque' | 'corner-rgb0';
}

export interface MaskItem extends ItemBase {
  type: 'mask';
  kind: 'DATA';
  w: number;
  h: number;
  /** 最大区号（build 时按数据核对） */
  regions: number;
}

export interface FlicItem extends ItemBase {
  type: 'flic';
  kind: 'FLIC';
  /** A3 的 FLIC 定义（尺寸、帧数、帧间隔、用途、同步音效、不透明） */
  def: FlicDef;
}

export interface GroundItem extends ItemBase {
  type: 'ground';
  kind: 'GND';
  mapId: string;
  /** 切块列数、行数（每块向右、向下多带 1px 重叠） */
  cols: number;
  rows: number;
}

export type CatalogItem = SpriteItem | ImageItem | MaskItem | FlicItem | GroundItem;

export interface CatalogExclusion {
  mkf: CatalogMkf;
  from: number;
  to: number;
  reason: string;
}

export interface Catalog {
  edition: 'v206';
  items: readonly CatalogItem[];
  exclusions: readonly CatalogExclusion[];
  /** 每个 MKF 的资源总数（核对用） */
  counts: Readonly<Record<CatalogMkf, number>>;
}

// ───────────────────────── 分组 → 类别 ─────────────────────────

/** 分组名 → 替换类别（每组一个类别；按前缀判定） */
export function categoryOfGroup(group: string): AssetCategory {
  const head = group.split('.')[0]!;
  if (group.startsWith('audio.voice')) return 'voice';
  if (group.startsWith('audio.sfx')) return 'sfx';
  if (group.startsWith('audio.music')) return 'music';
  switch (head) {
    case 'board':
    case 'map':
      return 'board';
    case 'char':
      return 'actor';
    case 'npc':
      return 'npc';
    case 'object':
      return 'object';
    case 'fx':
      return 'fx';
    case 'ui':
      return 'ui';
    case 'venue':
      return 'venue';
    case 'card':
      return 'card';
    case 'illustration':
      return 'illustration';
    case 'portrait':
      return 'portrait';
    case 'mg':
      return 'minigame';
    case 'title':
      return 'title';
    case 'video':
      return 'video';
    case 'data':
      return 'data';
    default:
      throw new Error(`categoryOfGroup: 未知分组 ${group}`);
  }
}

// ───────────────────────── 常量 ─────────────────────────

/** 台湾图（gm=0）的地图专属资源 */
export const TAIWAN = { mapId: 'taiwan', gm: 0 } as const;

/** 原版 12 名角色（下标即 CharacterId） */
export const CHARACTER_COUNT = 12;

/** 角色姿态库 k（Data#87+21c+k）：逻辑名与置信度（render.md §2.6、sprites.md §10、审查修正 8 与第二节第 3 条） */
export const CHAR_POSES: readonly { k: number; name: string; confidence: Confidence; desc: string }[] = [
  { k: 0, name: 'stand', confidence: 'exe', desc: '步行：站（8 方向）' },
  { k: 1, name: 'walk', confidence: 'exe', desc: '步行：走（8 方向 × n 帧）' },
  { k: 2, name: 'dice', confidence: 'exe', desc: '步行：持骰' },
  { k: 3, name: 'moto.stand', confidence: 'exe', desc: '机车：站' },
  { k: 4, name: 'moto.walk', confidence: 'exe', desc: '机车：走' },
  { k: 5, name: 'moto.dice', confidence: 'exe', desc: '机车：持骰' },
  { k: 6, name: 'car.stand', confidence: 'exe', desc: '汽车：站' },
  { k: 7, name: 'car.walk', confidence: 'exe', desc: '汽车：走' },
  { k: 8, name: 'car.dice', confidence: 'exe', desc: '汽车：持骰' },
  {
    k: 9,
    name: 'engineer.stand',
    confidence: 'guess',
    desc: '工程车（履带机械，速度表第 4 项）：站；待 0x40b425 核实',
  },
  { k: 10, name: 'engineer.walk', confidence: 'guess', desc: '工程车：走；待 0x40b425 核实' },
  { k: 11, name: 'engineer.dice', confidence: 'guess', desc: '工程车：持骰；待 0x40b425 核实' },
  { k: 12, name: 'pose12', confidence: 'visual', desc: '用途未定的姿态库（只凭目视）' },
  { k: 13, name: 'boat.stand', confidence: 'exe', desc: '快艇：站（0x40b5cb 检查节点 +0x27&0x80）' },
  { k: 14, name: 'boat.walk', confidence: 'exe', desc: '快艇：走' },
  { k: 15, name: 'boat.dice', confidence: 'exe', desc: '快艇：持骰' },
  { k: 16, name: 'sleepwalk.stand', confidence: 'visual', desc: '梦游：站（只凭目视）' },
  { k: 17, name: 'sleepwalk.walk', confidence: 'visual', desc: '梦游：走（只凭目视）' },
  { k: 18, name: 'beggar', confidence: 'visual', desc: '乞丐（只凭目视）' },
  { k: 19, name: 'hospital', confidence: 'visual', desc: '住院（只凭目视）' },
  { k: 20, name: 'jail', confidence: 'visual', desc: '坐牢（只凭目视）' },
];

/** 路面物件与路上神明（Data#354+t）；t 与 shared/data 的 GodKind 相同（1..12、15），13/14 为礼物/宝箱 */
export const ROAD_OBJECTS: readonly { t: number; name: string; desc: string }[] = [
  { t: 1, name: 'smallWealth', desc: '小财神' },
  { t: 2, name: 'bigWealth', desc: '大财神' },
  { t: 3, name: 'smallFortune', desc: '小福神' },
  { t: 4, name: 'bigFortune', desc: '大福神' },
  { t: 5, name: 'smallPoor', desc: '小穷神' },
  { t: 6, name: 'bigPoor', desc: '大穷神' },
  { t: 7, name: 'smallMisfortune', desc: '小衰神' },
  { t: 8, name: 'bigMisfortune', desc: '大衰神' },
  { t: 9, name: 'angel', desc: '天使' },
  { t: 10, name: 'devil', desc: '恶魔' },
  { t: 11, name: 'dog', desc: '恶犬' },
  { t: 12, name: 'earthGod', desc: '土地公' },
  { t: 13, name: 'gift', desc: '礼物' },
  { t: 14, name: 'chest', desc: '宝箱' },
  { t: 15, name: 'death', desc: '死神' },
];

/** 四大恶人（原版演员 4..7，按 shared/data VILLAIN_KINDS 顺序对应，推断）；p：0 站、1 走、2 快艇（推断）、3 未定 */
export const VILLAINS: readonly string[] = ['thief', 'robber', 'thug', 'spy'];
const VILLAIN_POSES: readonly string[] = ['stand', 'walk', 'boat', 'pose3'];
/** Data#339..354 实测帧数（4 演员 × 4 库） */
const VILLAIN_FRAMES: readonly number[] = [8, 152, 64, 136, 8, 80, 72, 80, 8, 120, 64, 120, 8, 80, 72, 80];

/** 台湾图引用的企业/景观精灵资源号（spriteRes + 26；build 时与 raw 地图交叉核对） */
export const TAIWAN_COMPANY_SPRITES: readonly number[] = [75, 80, 84];
export const TAIWAN_SCENERY_SPRITES: readonly number[] = [
  87, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149,
];
/** map.mkf 企业/景观精灵：资源号 = spriteRes + 3n + 14（v2.06 n=4 → +26） */
export const LANDMARK_SPRITE_OFFSET = 26;

/** 设施精灵：48 公园；48 + (kind−1)·5 + L（旅馆 49–53、购物中心 54–58、加油站 59–63、研究所 64–68） */
export const FACILITY_SPRITE_BASE = 48;
export const FACILITY_KINDS: readonly ('hotel' | 'mall' | 'gas' | 'lab')[] = ['hotel', 'mall', 'gas', 'lab'];

// ───────────────────────── 构造工具 ─────────────────────────

type SpriteOpts = Omit<SpriteItem, 'type' | 'key' | 'mkf' | 'res' | 'dirs' | 'frameRule' | 'ownerMask' | 'anchor'> &
  Partial<Pick<SpriteItem, 'dirs' | 'frameRule' | 'ownerMask' | 'anchor'>>;

function sprite(mkf: CatalogMkf, res: number, key: string, o: SpriteOpts): SpriteItem {
  return {
    type: 'sprite',
    key,
    mkf,
    res,
    dirs: 1,
    frameRule: 'ui-parts',
    ownerMask: false,
    anchor: 'frame',
    ...o,
  };
}

/** SMP 界面资源（ui/venue/title 等） */
function smp(
  mkf: CatalogMkf,
  res: number,
  key: string,
  group: string,
  frames: number,
  transparency: 'rgb0' | 'rgb0-backdrop',
  desc: string,
  token: ImageToken = 'ui',
  confidence: Confidence = 'visual',
): SpriteItem {
  return sprite(mkf, res, key, {
    kind: 'SMP',
    group,
    token,
    frames,
    transparency,
    confidence,
    src: [],
    desc,
  });
}

/** SPR 界面资源 */
function spr(
  mkf: CatalogMkf,
  res: number,
  key: string,
  group: string,
  frames: number,
  desc: string,
  token: ImageToken = 'ui',
  confidence: Confidence = 'visual',
): SpriteItem {
  return sprite(mkf, res, key, {
    kind: 'SPR',
    group,
    token,
    frames,
    transparency: 'index0',
    confidence,
    src: [],
    desc,
  });
}

function image(
  mkf: CatalogMkf,
  res: number,
  key: string,
  group: string,
  size: [number, number],
  transparency: 'opaque' | 'corner-rgb0',
  desc: string,
  token: ImageToken = 'ui',
  confidence: Confidence = 'visual',
): ImageItem {
  return {
    type: 'image',
    kind: 'RAW16',
    key,
    mkf,
    res,
    group,
    token,
    confidence,
    src: [],
    desc,
    w: size[0],
    h: size[1],
    transparency,
  };
}

function mask(
  mkf: CatalogMkf,
  res: number,
  key: string,
  group: string,
  size: [number, number],
  regions: number,
  desc: string,
  token: ImageToken = 'ui',
): MaskItem {
  return {
    type: 'mask',
    kind: 'DATA',
    key,
    mkf,
    res,
    group,
    token,
    confidence: 'visual',
    src: [],
    desc,
    w: size[0],
    h: size[1],
    regions,
  };
}

const range = (lo: number, hi: number): number[] => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);

// ───────────────────────── FLIC：A3 定义 → 逻辑键与分组 ─────────────────────────

const FLIC_MKF_TO_CATALOG: Readonly<Record<FlicMkf, CatalogMkf>> = { Data: 'Data', Panel: 'Panel', jump: 'jump' };
const GOD_NAME: Readonly<Record<number, string>> = Object.fromEntries(ROAD_OBJECTS.map((o) => [o.t, o.name]));

/** FLIC 条目的逻辑键、分组与 --only 归属 */
export function flicPlacementKey(d: FlicDef): { key: string; group: string; token: ImageToken } {
  if (d.use === 'god.arrive') {
    const g = GOD_NAME[d.god ?? -1];
    if (!g) throw new Error(`FLIC ${d.mkf}#${d.res}: 神明号 ${d.god} 未知`);
    return { key: `fx.god.${g}`, group: 'fx.gods', token: 'fx' };
  }
  if (d.char !== undefined) {
    const c = d.char;
    switch (d.use) {
      case 'char.emoteA':
        return { key: `char.${c}.emoteA`, group: `char.${c}`, token: 'fx' };
      case 'char.emoteB':
        return { key: `char.${c}.emoteB`, group: `char.${c}`, token: 'fx' };
      case 'char.parachuteBoard':
        return { key: `char.${c}.parachute`, group: `char.${c}`, token: 'fx' };
      case 'char.freefall':
        return { key: `title.freefall.${c}`, group: 'title.parachute', token: 'fx' };
      case 'char.parachuteOpen':
        return { key: `title.parachuteOpen.${c}`, group: 'title.parachute', token: 'fx' };
      default:
        throw new Error(`FLIC ${d.mkf}#${d.res}: 未知的按角色用途 ${d.use}`);
    }
  }
  if (d.mkf === 'Panel') {
    const byRes: Readonly<Record<number, { key: string; group: string; token: ImageToken }>> = {
      4: { key: 'ui.dice.roll1', group: 'ui.hud', token: 'fx' },
      5: { key: 'ui.dice.roll2', group: 'ui.hud', token: 'fx' },
      6: { key: 'ui.dice.roll3', group: 'ui.hud', token: 'fx' },
      14: { key: 'venue.lottery.marquee', group: 'venue.lottery', token: 'fx' },
      16: { key: 'venue.lottery.machine', group: 'venue.lottery', token: 'fx' },
      17: { key: 'venue.lottery.streamers', group: 'venue.lottery', token: 'fx' },
      20: { key: 'venue.magic.cast', group: 'venue.magic', token: 'fx' },
      78: { key: 'mg.ready', group: 'mg.common', token: 'minigame' },
    };
    const hit = byRes[d.res];
    if (!hit) throw new Error(`FLIC Panel#${d.res} 未分组`);
    return hit;
  }
  if (d.mkf === 'jump') {
    if (d.res === 42) return { key: 'title.cabinDoor', group: 'title.parachute', token: 'fx' };
    throw new Error(`FLIC jump#${d.res} 未分组`);
  }
  // Data 棋盘特效
  const key = d.use.startsWith('fx.') ? d.use : `fx.${d.use}`;
  return { key, group: 'fx.board', token: 'fx' };
}

function flicItems(): FlicItem[] {
  return FLIC_DEFS.map((d) => {
    const { key, group, token } = flicPlacementKey(d);
    return {
      type: 'flic',
      kind: 'FLIC',
      key,
      mkf: FLIC_MKF_TO_CATALOG[d.mkf],
      res: d.res,
      group,
      token,
      confidence: d.confidence,
      src: [d.evidence],
      desc: d.desc,
      def: d,
    };
  });
}

// ───────────────────────── 各档案 ─────────────────────────

function dataItems(): CatalogItem[] {
  const out: CatalogItem[] = [];
  out.push(
    smp(
      'Data',
      0,
      'ui.cursor',
      'ui.hud',
      43,
      'rgb0',
      '棋盘光标与标记：STOP、地雷、炸弹、飞弹、准星、卡片翻转 15 帧、手形、针筒、爪印、8 方向选路箭头',
    ),
    smp(
      'Data',
      1,
      'title.screen',
      'title',
      9,
      'rgb0-backdrop',
      '标题：图0 640×480 底图；图1–6 START/LOAD/OPTION 常态/悬停；图7–8 EXIT',
    ),
    smp('Data', 2, 'portrait.face72', 'portrait', 12, 'rgb0-backdrop', '12 角色 72×72 方形头像，帧 = 角色号'),
    smp(
      'Data',
      3,
      'ui.settings',
      'ui.system',
      16,
      'rgb0-backdrop',
      '游戏设定对话框 347×363、热键页、日期页、LED、箭头、右上三钮组',
    ),
  );
  for (const res of range(4, 27)) {
    out.push(
      image(
        'Data',
        res,
        `illustration.holiday.${res - 4}`,
        'illustration.holiday',
        [200, 200],
        'opaque',
        `台湾图节日插画（Data#4–27 中第 ${res - 4} 张），日历区在节日当天替换季节图`,
      ),
    );
  }
  // 角色 21 套姿态库
  for (let c = 0; c < CHARACTER_COUNT; c++) {
    for (const p of CHAR_POSES) {
      out.push(
        sprite('Data', 87 + 21 * c + p.k, `char.${c}.${p.name}`, {
          kind: 'SPR',
          group: `char.${c}`,
          token: 'board',
          frames: 'x8',
          dirs: 8,
          frameRule: 'actor-8dir',
          transparency: 'index0',
          confidence: p.confidence,
          src: ['VA 0x408433（帧 = ((8−view+dir)&7)·(帧数/8)+anim）'],
          desc: `角色 ${c} ${p.desc}`,
        }),
      );
    }
  }
  // 四大恶人
  for (let a = 0; a < 4; a++) {
    for (let p = 0; p < 4; p++) {
      const res = 339 + 4 * a + p;
      out.push(
        sprite('Data', res, `npc.villain.${VILLAINS[a]}.${VILLAIN_POSES[p]}`, {
          kind: 'SPR',
          group: 'npc',
          token: 'board',
          frames: VILLAIN_FRAMES[4 * a + p]!,
          dirs: 8,
          frameRule: 'actor-8dir',
          transparency: 'index0',
          confidence: 'visual',
          src: ['npc-339-354.png'],
          desc: `恶人演员 ${a + 4}（按 VILLAIN_KINDS 顺序推断为 ${VILLAINS[a]}）的姿态库 ${p}（0 站、1 走、2 快艇、3 未定；只凭目视）`,
        }),
      );
    }
  }
  // 路面物件与路上神明
  for (const o of ROAD_OBJECTS) {
    out.push(
      sprite('Data', 354 + o.t, `object.${o.name}`, {
        kind: 'SPR',
        group: 'object',
        token: 'board',
        frames: 8,
        dirs: 8,
        frameRule: 'road-object-8',
        transparency: 'index0',
        confidence: 'visual',
        src: ['gods-objects-355-372.png', 'VA 0x493ab0（地上物件表，库 = 0x163 + type − 1）'],
        desc: `路上物件 type ${o.t}：${o.desc}；帧 = (8−view+facing)&7`,
      }),
    );
  }
  const exeObj = (res: number, name: string, desc: string, frames: number, dirs: 1 | 8) =>
    sprite('Data', res, `object.${name}`, {
      kind: 'SPR',
      group: 'object',
      token: 'board',
      frames,
      dirs,
      frameRule: dirs === 8 ? 'road-object-8' : 'anim',
      transparency: 'index0',
      confidence: 'exe',
      src: ['VA 0x47cb5c（初始类型表）'],
      desc,
    });
  out.push(
    exeObj(370, 'roadblock', '路障（type 16）；帧 = (8−view+facing)&7', 8, 8),
    exeObj(371, 'mine', '地雷（type 17）', 8, 8),
    exeObj(372, 'bomb', '定时炸弹（type 18）；附身时偏移按 0x47283d', 8, 8),
    exeObj(373, 'zzz', '梦游 ZZZ（6 帧动画，深度层 0xE/0xF）', 6, 1),
    spr('Data', 374, 'ui.cardIcon', 'ui.hud', 1, '通用卡片小图标 20×26'),
    smp(
      'Data',
      399,
      'ui.yesno',
      'ui.dialog',
      3,
      'rgb0',
      'YES/NO 96×48（常态 / YES 亮 / NO 亮），置于 Data#476 图5 消息框内',
    ),
  );
  for (const res of range(400, 435)) {
    out.push(
      image(
        'Data',
        res,
        `illustration.news.${res - 400}`,
        'illustration.news',
        [388, 251],
        'opaque',
        `新闻 ${res - 400} 插图（新闻编号 i → Data#400+i，36 条逐一目视对上）`,
      ),
    );
  }
  for (const res of range(436, 475)) {
    out.push(
      image(
        'Data',
        res,
        `illustration.fate.${res - 436}`,
        'illustration.fate',
        [388, 251],
        'opaque',
        `命运插图 ${res - 436}（40 张与 37 条命运的对应未核实）`,
        'ui',
        'guess',
      ),
    );
  }
  out.push(
    smp(
      'Data',
      476,
      'ui.common',
      'ui.dialog',
      30,
      'rgb0',
      '共享 UI：图0–3 讲话框、图4 设施类别选择、图5 YES/NO 消息框、图6 云形气泡、图7 名牌、图8–17 绿色大数字、图18–21 小地图旋转钮、图22–29 小地图标记点',
    ),
    smp('Data', 477, 'ui.playerPicker', 'ui.dialog', 3, 'rgb0-backdrop', '选择玩家窗 177/257/337×97（2/3/4 个头像）'),
    smp('Data', 478, 'portrait.emoticons', 'portrait', 21, 'rgb0', '金貝貝等表情图 21 个（心、泪、心碎、星、灯泡…）'),
    smp(
      'Data',
      479,
      'ui.saveLoad',
      'ui.system',
      7,
      'rgb0-backdrop',
      'LOAD/SAVE 窗 555×451 / 555×381 + 4 张地图缩图 72×72',
    ),
    sprite('Data', 480, 'npc.doll.stand', {
      kind: 'SPR',
      group: 'npc',
      token: 'board',
      frames: 8,
      dirs: 8,
      frameRule: 'actor-8dir',
      transparency: 'index0',
      confidence: 'visual',
      src: [],
      desc: '机器娃娃 / 工人：8 方向单帧（推断为站姿；只凭目视）',
    }),
    sprite('Data', 481, 'npc.doll.walk', {
      kind: 'SPR',
      group: 'npc',
      token: 'board',
      frames: 40,
      dirs: 8,
      frameRule: 'actor-8dir',
      transparency: 'index0',
      confidence: 'visual',
      src: [],
      desc: '机器娃娃 / 工人：8 方向 × 5 帧（推断为行走；只凭目视）',
    }),
  );
  // 卡片插画：卡号 k = Data#529+k，不透明整图（黑色双线卡框与回纹角照原样画出，不抠圆角）。
  // 旧版按 corner-rgb0 从四角泛洪抠 0 值，黑框连成一片被整圈抠掉（惡魔 / 拆除 / 停留 / 嫁禍 / 黑卡 / 漲價），陷害、復仇
  // 连插画底部的黑色也被掏空，出卡时透出棋盘与资料栏。
  for (const res of range(530, 559)) {
    out.push({
      ...image(
        'Data',
        res,
        `card.${res - 529}`,
        'card',
        [165, 256],
        'opaque',
        `卡片 ${res - 529} 插画（卡号 k = Data#529+k；30 张逐张目视对上卡表顺序；原版不透明整张贴图）`,
        'ui',
        'exe',
      ),
      src: CARD_ART_EVIDENCE,
    });
  }
  out.push(image('Data', 560, 'title.loading', 'title', [640, 480], 'opaque', 'Loading 画面'));
  return out;
}

/**
 * 卡片插画的 exe 证据（v2.06 亮卡函数 fcn.00440bac；v3.11 对应 0x441fb1 `add eax,0x23a`，即 #571–#600）。
 * @source docs/research/original-assets/ui.md §2.2（卡片插画与亮卡）
 */
const CARD_ART_EVIDENCE: readonly string[] = [
  'VA 0x440bea（add eax,0x211 → fcn.0044ec68 载入 Data#(529+k)）',
  'VA 0x43fe70（图结构模板 {w=165,h=256,锚点 0,0}）',
  'VA 0x440c95（fcn.00454a55 → fcn.0045419a 逐行 rep movsd 不透明拷贝，无色键；画点 (138,200)）',
];

/** Panel#27..62：12 角色 × 3 段 Q 版小人的帧数（实测） */
const CHIBI_FRAMES: readonly number[] = [
  5, 1, 5, 5, 1, 5, 5, 1, 5, 6, 1, 6, 5, 1, 5, 6, 1, 6, 5, 1, 5, 6, 1, 6, 6, 1, 6, 6, 1, 6, 5, 1, 5, 7, 1, 8,
];
/** Panel#82..90 企鹅挖宝精灵帧数 */
const PENGUIN_FRAMES: readonly number[] = [32, 32, 8, 6, 6, 6, 6, 6, 6];
/** Panel#93..99 喜从天降精灵帧数 */
const XICONG_FRAMES: readonly number[] = [19, 12, 8, 8, 8, 8, 8];
/** Panel#100..111 喜从天降 12 角色接物姿态帧数 */
const XICONG_CHAR_FRAMES: readonly number[] = [25, 25, 25, 33, 25, 31, 25, 27, 31, 27, 25, 27];

function panelItems(): CatalogItem[] {
  const out: CatalogItem[] = [
    smp(
      'Panel',
      0,
      'ui.sidebar',
      'ui.hud',
      6,
      'rgb0-backdrop',
      '个人资料栏：图0–3 資金/地產/股票/其他 四页 200×280，图4 200×80，图5 无页签版',
    ),
    smp(
      'Panel',
      1,
      'ui.toolbar',
      'ui.hud',
      23,
      'rgb0-backdrop',
      '工具列：图0 底条 439×40；图1–11 常态、图12–22 悬停（画点 (i·40+20, 20) 减锚点）',
    ),
    smp(
      'Panel',
      2,
      'ui.calendar',
      'ui.hud',
      12,
      'rgb0-backdrop',
      '日历/月历：图0–3 春夏秋冬 200×200、图4–7 月历版、图8/9 太阳钮、图10/11 月亮钮',
    ),
    spr('Panel', 3, 'ui.diceFaces', 'ui.hud', 18, '骰子定格面：3 种尺寸 × 6 面（锚点为相对偏移）'),
    smp(
      'Panel',
      7,
      'ui.goButton',
      'ui.hud',
      12,
      'rgb0',
      'GO 钮 72×67：图0 常态/1 悬停/2 禁止/3 禁止悬停/4–5 乌龟；图6–11 骰子数小图 15×15',
    ),
    mask(
      'Panel',
      8,
      'ui.goButton.mask',
      'ui.hud',
      [72, 67],
      4,
      'GO 钮命中掩膜（逐像素统计：区 1 左侧骰子数竖槽 x7..22/y9..56、区 2 紫色边框、区 3 GO 钮面、区 4 钮外透明四角；没有 0）',
    ),
    smp(
      'Panel',
      9,
      'venue.assets.screen',
      'venue.assets',
      25,
      'rgb0-backdrop',
      '个人资产表 3 页 640×480 + EXIT + 翻页 + 12 神明小像',
    ),
    smp(
      'Panel',
      10,
      'venue.shop.screen',
      'venue.shop',
      38,
      'rgb0-backdrop',
      '百货公司：卡片店/道具店两页、货架、店员立绘与表情',
    ),
    smp(
      'Panel',
      11,
      'ui.itemBar',
      'ui.dialog',
      17,
      'rgb0-backdrop',
      '道具欄/卡片欄 412×180 + 13 道具图标（图2–14）+ 禁用图',
    ),
    smp(
      'Panel',
      12,
      'venue.lottery.bet',
      'venue.lottery',
      10,
      'rgb0-backdrop',
      '乐透投注：底图、猫女立绘与表情、号码选框',
    ),
    smp('Panel', 13, 'ui.digitsYellow', 'ui.hud', 12, 'rgb0', '黄色数字字模 0–9、逗号、$（16×18）'),
    smp(
      'Panel',
      15,
      'venue.lottery.draw',
      'venue.lottery',
      47,
      'rgb0-backdrop',
      '乐透开奖：底图、主持人 6 姿势、号码球、12 角色小头',
    ),
    smp(
      'Panel',
      18,
      'venue.magic.screen',
      'venue.magic',
      35,
      'rgb0-backdrop',
      '魔法屋：六芒星底图、女巫、提示框、24 个选项图标',
    ),
    mask('Panel', 19, 'venue.magic.mask', 'venue.magic', [640, 480], 13, '魔法屋六芒星命中掩膜（12 区 + 中心）'),
    spr('Panel', 21, 'ui.numpad', 'ui.dialog', 26, '计算器 128×192 + MAX/↵/键帽/计量条/LCD 数字'),
    mask('Panel', 22, 'ui.numpad.mask', 'ui.dialog', [128, 192], 16, '计算器按键命中掩膜（16 键）'),
    smp(
      'Panel',
      23,
      'venue.bank.screen',
      'venue.bank',
      24,
      'rgb0-backdrop',
      '银行：柜台底图、百叶窗、董事长、柜员表情、借还款卡',
    ),
    smp('Panel', 24, 'venue.bank.atm', 'venue.bank', 30, 'rgb0-backdrop', '银行 ATM 320×338 + 键帽 + LCD 数字'),
    smp(
      'Panel',
      25,
      'venue.monthly.screen',
      'venue.monthly',
      83,
      'rgb0-backdrop',
      '月结颁奖：底图、MONEY 卡、名次、主持人、Q 版小人',
    ),
    smp(
      'Panel',
      26,
      'venue.auction.screen',
      'venue.auction',
      116,
      'rgb0-backdrop',
      '拍卖：底图、竞价钮、拍卖官、女助手、建筑缩图、占地标志',
    ),
  ];
  for (let c = 0; c < CHARACTER_COUNT; c++) {
    for (let i = 0; i < 3; i++) {
      const res = 27 + 3 * c + i;
      out.push(
        spr(
          'Panel',
          res,
          `venue.chibi.${c}.${i}`,
          'venue.chibi',
          CHIBI_FRAMES[3 * c + i]!,
          `角色 ${c} 的 Q 版正面小人第 ${i} 段（待机 1 帧 + 两段动作；拍卖/结算等界面）`,
        ),
      );
    }
  }
  out.push(
    smp(
      'Panel',
      63,
      'venue.jail.screen',
      'venue.jail',
      22,
      'rgb0-backdrop',
      '监狱：牢房底图（窗洞为 0 值透明孔）、铁栏、12 角色 + 4 恶人大头',
    ),
    smp('Panel', 64, 'venue.jail.villains', 'venue.jail', 4, 'rgb0', '四大恶人全身像'),
    smp('Panel', 65, 'venue.hospital.screen', 'venue.hospital', 31, 'rgb0-backdrop', '医院：病房底图、护士、病床像'),
    smp('Panel', 66, 'ui.newsBoard', 'ui.dialog', 2, 'rgb0-backdrop', '新闻板（蓝 NEWS）/ 命运板（紫 ?）440×480'),
    smp('Panel', 67, 'ui.godSlot', 'ui.dialog', 24, 'rgb0', '神明老虎机 4 位/3 位 + 拉杆 + 滚轮数字'),
  );
  // 盘面按本机真实素材图2 逐格目视核对：#68 = 0,1,2,3,2,1（航空）、#69 = 1–4（旅馆）、#70 = 6,1–5（购物中心）、
  // #71 = 3,5,10,15,20,30（保险）；客户端 ui/classic/popups/layout.ts 的 WHEELS 同此
  const wheels = ['航空', '旅馆', '购物中心', '保险'] as const;
  for (let i = 0; i < 4; i++) {
    out.push(
      smp(
        'Panel',
        68 + i,
        `ui.roulette.${i}`,
        'ui.dialog',
        14,
        'rgb0',
        `轮盘 ${i}（${wheels[i]}；#68–71 依次为航空 / 旅馆 / 购物中心 / 保险，按图2 盘面核对）：天使与数字转盘 12 帧旋转`,
      ),
    );
  }
  out.push(
    smp('Panel', 72, 'ui.dicePicker', 'ui.hud', 7, 'rgb0', '遥控骰子选点窗 256×55 + 6 钮'),
    smp(
      'Panel',
      73,
      'venue.bulletin.screen',
      'venue.bulletin',
      20,
      'rgb0-backdrop',
      '公佈欄：软木板、挂牌格、详情框、类别图标',
    ),
    smp('Panel', 74, 'ui.itemIcons', 'ui.hud', 13, 'rgb0', '13 个道具小图标 24×20'),
    smp(
      'Panel',
      75,
      'venue.stock.screen',
      'venue.stock',
      12,
      'rgb0-backdrop',
      '股市：两页表格 640×480、公司详情、行业图 × 9',
    ),
    smp('Panel', 76, 'venue.stock.holdings', 'venue.stock', 1, 'rgb0-backdrop', '持股汇总表 592×432'),
    smp('Panel', 77, 'ui.autoplay', 'ui.system', 18, 'rgb0-backdrop', '托管 AI 对话框 435×355 + 12 圆头像'),
    smp('Panel', 79, 'mg.common.hud', 'mg.common', 20, 'rgb0', '小游戏 HUD 数字与部件', 'minigame'),
    smp(
      'Panel',
      80,
      'mg.penguin.screen',
      'mg.penguin',
      10,
      'rgb0-backdrop',
      '企鹅挖宝：冰原底图 640×480 + 部件',
      'minigame',
    ),
    mask(
      'Panel',
      81,
      'mg.penguin.mask',
      'mg.penguin',
      [640, 480],
      77,
      '企鹅挖宝冰格命中掩膜（64 格，区号不连续、最大 77；只做诊断对拍，输入命中走 sim 的 pickCell）',
      'minigame',
    ),
  );
  PENGUIN_FRAMES.forEach((n, i) => {
    out.push(
      spr('Panel', 82 + i, `mg.penguin.${82 + i}`, 'mg.penguin', n, '企鹅挖宝精灵（企鹅、宝物、特效）', 'minigame'),
    );
  });
  out.push(
    smp(
      'Panel',
      91,
      'mg.balloon.screen',
      'mg.balloon',
      14,
      'rgb0-backdrop',
      '七彩气球：底图 640×480 + 气球',
      'minigame',
    ),
    image('Panel', 92, 'mg.xicong.bg', 'mg.xicong', [640, 480], 'opaque', '喜从天降背景（南天门）', 'minigame'),
  );
  XICONG_FRAMES.forEach((n, i) => {
    out.push(spr('Panel', 93 + i, `mg.xicong.${93 + i}`, 'mg.xicong', n, '喜从天降精灵（财神、金币等）', 'minigame'));
  });
  XICONG_CHAR_FRAMES.forEach((n, c) => {
    out.push(spr('Panel', 100 + c, `mg.xicong.char.${c}`, 'mg.xicong', n, `喜从天降：角色 ${c} 接物姿态`, 'minigame'));
  });
  out.push(smp('Panel', 112, 'mg.common.playAgain', 'mg.common', 11, 'rgb0', 'PLAY AGAIN 与数字', 'minigame'));
  return out;
}

/** jump#5..40：12 角色 × 步行/机车/汽车侧视走动帧数 */
const SIDEWALK_FRAMES: readonly number[] = [
  20, 10, 8, 20, 10, 8, 7, 11, 9, 20, 11, 11, 20, 10, 8, 11, 11, 11, 21, 11, 9, 20, 11, 11, 10, 11, 11, 20, 11, 11, 20,
  10, 8, 18, 11, 21,
];
const SIDEWALK_VEHICLES: readonly string[] = ['walk', 'moto', 'car'];

function jumpItems(): CatalogItem[] {
  const out: CatalogItem[] = [
    image('jump', 0, 'title.setup.bg', 'title', [640, 480], 'opaque', '开局设置背景（台湾）'),
    smp(
      'jump',
      4,
      'title.setup.ui',
      'title',
      16,
      'rgb0-backdrop',
      '开局设置部件：12 头像格、竖栏、OK/EXIT、下拉框、勾/叉/星',
    ),
  ];
  for (let c = 0; c < CHARACTER_COUNT; c++) {
    for (let v = 0; v < 3; v++) {
      const res = 5 + 3 * c + v;
      out.push(
        sprite('jump', res, `title.sidewalk.${c}.${SIDEWALK_VEHICLES[v]}`, {
          kind: 'SPR',
          group: 'title.select',
          token: 'ui',
          frames: SIDEWALK_FRAMES[3 * c + v]!,
          frameRule: 'anim',
          transparency: 'index0',
          confidence: 'visual',
          src: [],
          desc: `选人画面：角色 ${c} ${['步行', '机车', '汽车'][v]}侧视走动（jump#5+3c+v）`,
        }),
      );
    }
  }
  out.push(smp('jump', 41, 'title.cabin', 'title.parachute', 15, 'rgb0-backdrop', '开局飞机：机舱、天空、12 角色背伞'));
  return out;
}

function mapItems(): CatalogItem[] {
  const out: CatalogItem[] = [
    {
      type: 'ground',
      kind: 'GND',
      key: 'map.taiwan.ground',
      mkf: 'map',
      res: 2 * TAIWAN.gm,
      group: 'map.taiwan',
      token: 'board',
      confidence: 'exe',
      src: ['VA 0x40779b（载入器：GND = gm·2）', 'VA 0x407ebd（地面绘制）'],
      desc: '台湾图地面：2304² 正射底图（72×72 块 × 32²），切成 2×2 张 1152²（每块多带 1px 重叠）',
      mapId: TAIWAN.mapId,
      cols: 2,
      rows: 2,
    },
    smp(
      'map',
      8 + TAIWAN.gm,
      'map.taiwan.minimap',
      'map.taiwan',
      2,
      'rgb0-backdrop',
      '台湾图缩小地图：帧0 200×200、帧1 400×400（v2.06 为 map#8+gm）',
      'board',
      'exe',
    ),
    sprite('map', 12, 'board.decor', {
      kind: 'SMP',
      group: 'board.common',
      token: 'board',
      frames: 17,
      frameRule: 'decor',
      transparency: 'rgb0',
      anchor: 'center',
      confidence: 'exe',
      src: ['VA 0x408181（装饰绘制，不参与排序）'],
      desc: '节点装饰圆盘：帧 = decor−1，锚点在图心；PARK/NEWS/?/监狱/医院/GAME×3/乐透/点券/CARD/BANK/On sale/魔法屋/小币',
    }),
    sprite('map', 13, 'board.ownerMark', {
      kind: 'SPR',
      group: 'board.common',
      token: 'board',
      frames: 12,
      frameRule: 'by-character',
      transparency: 'index0',
      confidence: 'exe',
      src: ['VA 0x40779b（资源 13）', 'VA 0x408d60（等级 0 且有主时画，帧 = 角色号）'],
      desc: '空地占地标志：帧 = 角色号（牛仔帽、油桶、手里剑…）',
    }),
    sprite('map', 14, 'board.lotHighlight', {
      kind: 'SPR',
      group: 'board.common',
      token: 'board',
      frames: 5,
      frameRule: 'static',
      transparency: 'index0',
      confidence: 'guess',
      src: ['render-model.json（0/1 小地块两种朝向、2/3 设施大地块、4 圆；OR 混色）'],
      desc: '地块高亮（涨价/查封）：帧语义与颜色表 0x4861d0 未解码',
    }),
  ];
  for (let c = 0; c < CHARACTER_COUNT; c++) {
    out.push(
      smp(
        'map',
        15 + c,
        `portrait.speaker.${c}`,
        'portrait',
        7,
        'rgb0',
        `角色 ${c} 讲话头像：图0 大头、图1–4 表情、图5 小头、图6 地图点（贴 (170,130)，图号 = 表情+1）`,
      ),
    );
  }
  for (let L = 1; L <= 5; L++) {
    out.push(
      sprite('map', 27 + 5 * TAIWAN.gm + (L - 1), `map.taiwan.house.${L}`, {
        kind: 'SPR',
        group: 'map.taiwan',
        token: 'board',
        frames: 8,
        dirs: 8,
        frameRule: 'building-8',
        transparency: 'index0',
        ownerMask: true,
        confidence: 'exe',
        src: ['VA 0x408d60（住宅 27+gm·5+(L−1)）', 'VA 0x409468（调色板 255 = 主人色）'],
        desc: `台湾图 ${L} 级住宅：帧 = (8−(facing+view))&7；调色板 255 为主人色描边`,
      }),
    );
  }
  const building = (res: number, key: string, desc: string) =>
    sprite('map', res, key, {
      kind: 'SPR',
      group: 'board.buildings',
      token: 'board',
      frames: 8,
      dirs: 8,
      frameRule: 'building-8',
      transparency: 'index0',
      ownerMask: true,
      confidence: 'exe',
      src: ['VA 0x408f81（设施绘制）', 'VA 0x409468（调色板 255 = 主人色）'],
      desc,
    });
  out.push(building(47, 'board.chain', '连锁店（v2.06 资源 47）'));
  out.push(building(FACILITY_SPRITE_BASE, 'board.facility.park', '公园（设施等级 0）'));
  const kindName = { hotel: '旅馆', mall: '购物中心', gas: '加油站', lab: '研究所' } as const;
  FACILITY_KINDS.forEach((kind, i) => {
    for (let L = 1; L <= 5; L++) {
      out.push(
        building(
          FACILITY_SPRITE_BASE + i * 5 + L,
          `board.facility.${kind}.${L}`,
          `${kindName[kind]} ${L} 级（48+(kind−1)·5+L）`,
        ),
      );
    }
  });
  for (const res of [...TAIWAN_COMPANY_SPRITES, ...TAIWAN_SCENERY_SPRITES].sort((a, b) => a - b)) {
    const company = TAIWAN_COMPANY_SPRITES.includes(res);
    out.push(
      sprite('map', res, `board.landmark.${res}`, {
        kind: 'SPR',
        group: 'map.taiwan',
        token: 'board',
        frames: 8,
        dirs: 8,
        frameRule: 'building-8',
        transparency: 'index0',
        ownerMask: company,
        confidence: 'exe',
        src: ['VA 0x4091b3 / 0x4092f8（企业 +0x20 / 景观 +0x1a 读 spriteId，资源 = id+26）'],
        desc: company
          ? `台湾图企业精灵（spriteRes ${res - LANDMARK_SPRITE_OFFSET}）：有主人色描边`
          : `台湾图景观精灵（spriteRes ${res - LANDMARK_SPRITE_OFFSET}）：不改色`,
      }),
    );
  }
  return out;
}

function helpItems(): CatalogItem[] {
  return [smp('help', 0, 'ui.help', 'ui.system', 12, 'rgb0-backdrop', '游戏百科窗 400×400 + 按钮/滚动部件')];
}

const OTHER_MAPS = '其他地图（中国/日本/美国）的专属资源；引擎目前只有台湾 MapDef';

function exclusions(): CatalogExclusion[] {
  const taiwanLandmarks = new Set([...TAIWAN_COMPANY_SPRITES, ...TAIWAN_SCENERY_SPRITES]);
  const out: CatalogExclusion[] = [
    { mkf: 'Data', from: 28, to: 86, reason: `${OTHER_MAPS}：节日插画 Data#28–86` },
    { mkf: 'jump', from: 1, to: 3, reason: `${OTHER_MAPS}：开局设置背景` },
    { mkf: 'map', from: 1, to: 1, reason: '地图结构数据（由 map build 处理，不进素材包）' },
    { mkf: 'map', from: 2, to: 2, reason: `${OTHER_MAPS}：地面 GND` },
    { mkf: 'map', from: 3, to: 3, reason: '地图结构数据（由 map build 处理，不进素材包）' },
    { mkf: 'map', from: 4, to: 4, reason: `${OTHER_MAPS}：地面 GND` },
    { mkf: 'map', from: 5, to: 5, reason: '地图结构数据（由 map build 处理，不进素材包）' },
    { mkf: 'map', from: 6, to: 6, reason: `${OTHER_MAPS}：地面 GND` },
    { mkf: 'map', from: 7, to: 7, reason: '地图结构数据（由 map build 处理，不进素材包）' },
    { mkf: 'map', from: 9, to: 11, reason: `${OTHER_MAPS}：缩小地图` },
    { mkf: 'map', from: 32, to: 46, reason: `${OTHER_MAPS}：住宅 27+gm·5+(L−1)` },
    { mkf: 'help', from: 1, to: 99, reason: 'Big5 帮助文本：原版文字由 GDI 绘制，原版皮肤的界面文字走 zh-TW 语言包' },
  ];
  // map#69..149 中台湾图不引用的企业/景观精灵（按连续段合并）
  let start = -1;
  for (let res = 69; res <= 150; res++) {
    const other = res <= 149 && !taiwanLandmarks.has(res);
    if (other && start < 0) start = res;
    if (!other && start >= 0) {
      out.push({
        mkf: 'map',
        from: start,
        to: res - 1,
        reason: `${OTHER_MAPS}：企业/景观精灵（spriteRes+26），台湾图不引用`,
      });
      start = -1;
    }
  }
  return out;
}

/** v2.06 资源目录（纯数据，按 mkf、资源号排序） */
export function catalogV206(): Catalog {
  const order = (m: CatalogMkf) => CATALOG_MKFS.indexOf(m);
  const items = [...dataItems(), ...panelItems(), ...jumpItems(), ...mapItems(), ...helpItems(), ...flicItems()].sort(
    (a, b) => order(a.mkf) - order(b.mkf) || a.res - b.res,
  );
  const ex = exclusions().sort((a, b) => order(a.mkf) - order(b.mkf) || a.from - b.from);
  return { edition: 'v206', items, exclusions: ex, counts: { ...V206_RESOURCE_COUNTS } };
}

// ───────────────────────── 自检与覆盖率 ─────────────────────────

/** 目录结构自检（不读原版文件）：键唯一、资源号不重复、排除段不与条目重叠、分组能映射到类别。返回问题列表 */
export function validateCatalog(cat: Catalog): string[] {
  const issues: string[] = [];
  const keys = new Set<string>();
  const slots = new Map<string, string>();
  for (const it of cat.items) {
    if (keys.has(it.key)) issues.push(`逻辑键重复：${it.key}`);
    keys.add(it.key);
    const slot = `${it.mkf}#${it.res}`;
    const prev = slots.get(slot);
    if (prev) issues.push(`资源 ${slot} 被 ${prev} 与 ${it.key} 重复收录`);
    slots.set(slot, it.key);
    if (it.res < 0 || it.res >= cat.counts[it.mkf]) issues.push(`${it.key}: 资源号 ${slot} 越界`);
    try {
      categoryOfGroup(it.group);
    } catch {
      issues.push(`${it.key}: 分组 ${it.group} 没有类别`);
    }
    if (it.type === 'sprite' && typeof it.frames === 'number' && it.frames % it.dirs !== 0) {
      issues.push(`${it.key}: 帧数 ${it.frames} 不是 dirs=${it.dirs} 的整数倍`);
    }
  }
  for (const ex of cat.exclusions) {
    if (ex.from > ex.to || ex.from < 0 || ex.to >= cat.counts[ex.mkf])
      issues.push(`排除段 ${ex.mkf}#${ex.from}–${ex.to} 非法`);
    for (let r = ex.from; r <= ex.to; r++) {
      const hit = slots.get(`${ex.mkf}#${r}`);
      if (hit) issues.push(`排除段 ${ex.mkf}#${ex.from}–${ex.to} 与条目 ${hit} 重叠`);
    }
  }
  return issues;
}

export interface CoverageArchive {
  total: number;
  cataloged: number;
  excluded: number;
  uncataloged: number[];
}

export interface CoverageReport {
  schema: 'rich4.assets-coverage/1';
  edition: 'v206';
  archives: Record<CatalogMkf, CoverageArchive>;
  totals: { total: number; cataloged: number; excluded: number; uncataloged: number };
  /** (收录 + 明确排除) / 总数，百分比保留两位小数 */
  percent: number;
  /** 只算收录（不含排除） */
  catalogedPercent: number;
  exclusions: CatalogExclusion[];
}

export function catalogCoverage(cat: Catalog): CoverageReport {
  const archives = {} as Record<CatalogMkf, CoverageArchive>;
  let total = 0;
  let cataloged = 0;
  let excluded = 0;
  let unc = 0;
  for (const m of CATALOG_MKFS) {
    const n = cat.counts[m];
    const covered = new Set(cat.items.filter((it) => it.mkf === m).map((it) => it.res));
    const ex = new Set<number>();
    for (const e of cat.exclusions) if (e.mkf === m) for (let r = e.from; r <= e.to; r++) ex.add(r);
    const uncataloged: number[] = [];
    for (let r = 0; r < n; r++) if (!covered.has(r) && !ex.has(r)) uncataloged.push(r);
    archives[m] = { total: n, cataloged: covered.size, excluded: ex.size, uncataloged };
    total += n;
    cataloged += covered.size;
    excluded += ex.size;
    unc += uncataloged.length;
  }
  const pct = (x: number) => (total === 0 ? 100 : Math.trunc((x * 10000) / total + 0.5) / 100);
  return {
    schema: 'rich4.assets-coverage/1',
    edition: cat.edition,
    archives,
    totals: { total, cataloged, excluded, uncataloged: unc },
    percent: pct(cataloged + excluded),
    catalogedPercent: pct(cataloged),
    exclusions: [...cat.exclusions],
  };
}

/** 条目证据：第一项为 `<mkf>#<res>`，其后为目录里的证据 */
export function itemSrc(it: CatalogItem): string[] {
  return [`${it.mkf}#${it.res}`, ...it.src];
}

/** 图集帧名前缀（与证据同形） */
export function frameBase(it: { mkf: CatalogMkf; res: number }): string {
  return `${it.mkf}#${it.res}`;
}

/** 素材包内的目录名（小写 mkf） */
export function mkfDir(mkf: CatalogMkf): string {
  return mkf.toLowerCase();
}
