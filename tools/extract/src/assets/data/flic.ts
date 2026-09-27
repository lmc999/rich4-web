/**
 * FLIC 动画映射表源数据（Data.mkf 72 段、Panel.mkf 8 段、jump.mkf 25 段，v2.06 编号）。
 *
 * - 格式：标准 Autodesk FLC（magic 0xAF12、8bpp）；帧间隔取头部 +16 的毫秒值；原版时长 = frames × frameMs。
 * - 透明：调色板索引 0；不透明例外只有 Panel#16、Panel#20、jump#42。
 * - 尺寸、帧数、帧间隔是本机文件头的实测值，build 时会按源文件重新核对（flicMap.ts verifyFlicMap）。
 * - 用途：FLIC 播放函数 fcn.0044fc76(flic, x, y, flags, sfx) 的 55 处调用点逐一解出（图号, 音效号）；
 *   调用点落在已知处理函数内（新闻 / 卡片 / 道具 / 神明 switch）的记 exe，只凭样张的记 visual，推断记 guess。
 * @source docs/research/original-assets/audio_video.md §2.3、§4.2；.cache/assets-research/audio/flic.index.json
 * @source exe v2.06 神明降临 switch 0x40e6b2（跳表 0x40e561）、新闻处理函数表 0x473c48、台词表 0x47e03a / 0x47e51a
 */
import type { Confidence } from './types';

export type FlicMkf = 'Data' | 'Panel' | 'jump';
export const FLIC_MKFS: readonly FlicMkf[] = ['Data', 'Panel', 'jump'];

export interface FlicDef {
  mkf: FlicMkf;
  res: number;
  w: number;
  h: number;
  frames: number;
  /** 帧间隔（ms，头部 +16） */
  frameMs: number;
  /** 不透明（整幅画面，不按索引 0 透明） */
  opaque: boolean;
  /** 用途键（A8 按它挑动画与节奏预算） */
  use: string;
  desc: string;
  /** 首帧同步播放的 Effect.mkf 音效号；没有为 null */
  sfx: number | null;
  confidence: Confidence;
  /** 证据：调用点 VA 或样张 */
  evidence: string;
  /** 按角色的动画：角色号 0..11 */
  char?: number;
  /** 神明降临：@rich4/shared/data 的 GodKind */
  god?: number;
}

type Row = readonly [res: number, w: number, h: number, frames: number, frameMs: number];

/** Data 375..398：12 角色 × 2 段表情动画（375+2c、376+2c），语义未核实 */
const EMOTES: readonly Row[] = [
  [375, 100, 100, 10, 71],
  [376, 156, 156, 23, 71],
  [377, 98, 100, 10, 71],
  [378, 98, 100, 8, 71],
  [379, 74, 110, 6, 71],
  [380, 102, 102, 10, 71],
  [381, 64, 64, 6, 71],
  [382, 132, 122, 6, 71],
  [383, 92, 92, 10, 71],
  [384, 86, 86, 8, 71],
  [385, 94, 94, 16, 71],
  [386, 64, 64, 21, 71],
  [387, 74, 110, 5, 71],
  [388, 74, 110, 8, 71],
  [389, 100, 100, 21, 71],
  [390, 95, 95, 32, 71],
  [391, 104, 92, 11, 71],
  [392, 104, 96, 20, 71],
  [393, 64, 64, 8, 71],
  [394, 104, 96, 12, 71],
  [395, 192, 192, 15, 71],
  [396, 74, 108, 8, 71],
  [397, 80, 80, 16, 71],
  [398, 80, 80, 21, 71],
];

/** Data 518..529：12 角色棋盘上的降落伞（按角色号） */
const BOARD_CHUTES: readonly Row[] = [
  [518, 440, 440, 34, 42],
  [519, 440, 440, 35, 42],
  [520, 440, 440, 34, 42],
  [521, 440, 440, 39, 42],
  [522, 440, 440, 30, 42],
  [523, 440, 440, 40, 42],
  [524, 440, 440, 33, 42],
  [525, 440, 440, 39, 42],
  [526, 440, 440, 30, 42],
  [527, 440, 440, 39, 42],
  [528, 440, 440, 33, 42],
  [529, 440, 440, 35, 42],
];

/** jump 43..54：12 角色自由落体（全屏）；55..66：12 角色开伞（全屏） */
const JUMP_FALL: readonly Row[] = [
  [43, 640, 480, 40, 28],
  [44, 640, 480, 48, 28],
  [45, 640, 480, 43, 28],
  [46, 640, 480, 48, 28],
  [47, 640, 480, 48, 28],
  [48, 640, 480, 48, 28],
  [49, 640, 480, 49, 28],
  [50, 640, 480, 45, 28],
  [51, 640, 480, 48, 28],
  [52, 640, 480, 44, 28],
  [53, 640, 480, 42, 28],
  [54, 640, 480, 48, 28],
];
const JUMP_OPEN: readonly Row[] = [
  [55, 640, 480, 37, 42],
  [56, 640, 480, 42, 42],
  [57, 640, 480, 36, 42],
  [58, 640, 480, 42, 42],
  [59, 640, 480, 45, 42],
  [60, 640, 480, 43, 42],
  [61, 640, 480, 40, 42],
  [62, 640, 480, 41, 42],
  [63, 640, 480, 36, 42],
  [64, 640, 480, 43, 71],
  [65, 640, 480, 42, 42],
  [66, 640, 480, 43, 42],
];

/** 神明降临：GodKind → FLIC（exe switch 逐项解出）与音效 */
const GOD_ARRIVALS: readonly (readonly [god: number, key: string, row: Row, sfx: number, site: string])[] = [
  [1, '小财神', [499, 440, 440, 21, 100], 102, '0x40e6e5'],
  [2, '大财神', [500, 440, 440, 21, 100], 103, '0x40e7b9'],
  [3, '小福神', [501, 440, 440, 21, 128], 104, '0x40e851'],
  [4, '大福神', [502, 440, 440, 35, 100], 105, '0x40e90f'],
  [5, '小穷神', [503, 440, 440, 28, 100], 106, '0x40ea05'],
  [6, '大穷神', [504, 440, 440, 30, 100], 107, '0x40eac8'],
  [7, '小衰神', [505, 440, 440, 14, 100], 108, '0x40eb61'],
  [8, '大衰神', [506, 440, 440, 19, 100], 109, '0x40ec2d'],
  [9, '天使', [507, 440, 440, 16, 100], 110, '0x40ecad'],
  [10, '恶魔', [508, 440, 440, 12, 100], 112, '0x40ed00'],
  [12, '土地公', [509, 440, 440, 23, 71], 111, '0x40ed48'],
  [15, '死神', [510, 440, 440, 15, 100], 113, '0x40edbd'],
];

function def(
  mkf: FlicMkf,
  row: Row,
  use: string,
  desc: string,
  sfx: number | null,
  confidence: Confidence,
  evidence: string,
  extra: Partial<Pick<FlicDef, 'opaque' | 'char' | 'god'>> = {},
): FlicDef {
  const [res, w, h, frames, frameMs] = row;
  return {
    mkf,
    res,
    w,
    h,
    frames,
    frameMs,
    opaque: extra.opaque ?? false,
    use,
    desc,
    sfx,
    confidence,
    evidence,
    ...extra,
  };
}

export const FLIC_DEFS: readonly FlicDef[] = [
  ...EMOTES.map((row, i) =>
    def(
      'Data',
      row,
      i % 2 === 0 ? 'char.emoteA' : 'char.emoteB',
      `角色 ${i >> 1} 的表情动画 ${i % 2 === 0 ? 'A' : 'B'}（语义未核实，推断为得意 / 沮丧）`,
      null,
      'guess',
      'flic-data-375-398.png',
      { char: i >> 1 },
    ),
  ),
  def(
    'Data',
    [482, 440, 440, 66, 42],
    'fx.fireworks',
    '烟火（节日 1/1，台湾图 10/10）',
    90,
    'exe',
    '0x40acf9；节日表 0x47d6ab',
  ),
  def(
    'Data',
    [483, 440, 74, 62, 100],
    'fx.ambulance',
    '救护车（送医院），贴在 y=210',
    92,
    'exe',
    '0x43da65（医院 fcn.0043d6c0）',
  ),
  def(
    'Data',
    [484, 440, 440, 8, 114],
    'fx.explosion.small',
    '小爆炸（地雷 / 炸弹，紧接踩雷台词）',
    82,
    'exe',
    '0x41afc3、0x41b714',
  ),
  def(
    'Data',
    [485, 110, 110, 8, 114],
    'fx.godLeave',
    '烟雾 110×110（神明离身，推断）；喜從天降接到炸弹时的爆炸也用它，画在 (接物者 x − 55, 295)',
    95,
    'visual',
    '0x40f0b7（fcn.0040edf3）；喜從天降：0x415016 载入（fcn.00414f20，同时载 Panel#78/79/92–99）、0x412d2b 接到炸弹（fcn.00412b66，type 4）时播放',
  ),
  def(
    'Data',
    [486, 440, 440, 41, 71],
    'fx.gasExplosion',
    '碎屑爆炸（新闻：瓦斯气爆）；也可作大爆炸',
    87,
    'exe',
    '0x44900e（新闻 15 处理函数）',
  ),
  def(
    'Data',
    [487, 440, 440, 19, 114],
    'fx.missile',
    '飞弹命中爆炸（道具：飞弹）',
    81,
    'exe',
    '0x445be2 → 0x445c2d（飞弹台词之后）',
  ),
  def(
    'Data',
    [488, 440, 440, 68, 71],
    'fx.demolish',
    '坦克拆屋（卡片：拆除；魔法屋拆屋）',
    97,
    'exe',
    '0x4429f3 → 0x442a15、0x4316d7',
  ),
  def(
    'Data',
    [489, 440, 440, 26, 114],
    'fx.nuke',
    '核子飞弹蘑菇云（道具：核子飞弹，全屏标志）',
    83,
    'exe',
    '0x446706 → 0x446751',
  ),
  def(
    'Data',
    [490, 440, 440, 36, 114],
    'fx.alienAttack',
    '天降光束与穹顶爆炸（新闻：外星人攻打地球）',
    86,
    'exe',
    '0x447df6（新闻 4 处理函数）',
  ),
  def('Data', [491, 440, 440, 38, 114], 'fx.smoke', '烟雾（路面物件相关，推断）', 93, 'guess', '0x41b12e'),
  def(
    'Data',
    [492, 440, 440, 46, 71],
    'fx.ufoAbduct',
    'UFO 光束（被外星人绑架，推断）',
    84,
    'guess',
    '0x40cf5e（与飞机 517 同函数）',
  ),
  def(
    'Data',
    [493, 440, 440, 15, 71],
    'fx.typhoon',
    '龙卷风样式动画（新闻：超级台风）',
    89,
    'exe',
    '0x4496cc（新闻 20 处理函数）',
  ),
  def(
    'Data',
    [494, 440, 440, 15, 71],
    'fx.tornado',
    '龙卷风（新闻：龙卷风）',
    88,
    'exe',
    '0x44986c（新闻 21 处理函数）',
  ),
  def('Data', [495, 28, 40, 14, 71], 'fx.cardGain', '卡片翻出问号（得到卡片），贴在 (208,180)', 99, 'exe', '0x41abb2'),
  def(
    'Data',
    [496, 31, 39, 14, 71],
    'fx.pointsGain',
    '旋转的点券（得到点券），贴在 (204,180)',
    98,
    'exe',
    '0x41aa34、0x41aace、0x41ab52',
  ),
  def('Data', [497, 440, 440, 35, 71], 'fx.policeCar', '警车（押送坐牢）', 94, 'exe', '0x43c3d5（监狱 fcn.0043c03f）'),
  def(
    'Data',
    [498, 440, 440, 46, 71],
    'fx.monster',
    'UFO 光束（新闻：外星怪兽袭击）',
    84,
    'exe',
    '0x448018（新闻 5 处理函数）',
  ),
  ...GOD_ARRIVALS.map(([god, name, row, sfx, site]) =>
    def('Data', row, 'god.arrive', `神明降临：${name}`, sfx, 'exe', `${site}（switch 0x40e6b2）`, { god }),
  ),
  def(
    'Data',
    [511, 440, 440, 18, 71],
    'fx.explosion.alt',
    '小爆炸（另一款，路面物件相关，推断）',
    85,
    'guess',
    '0x41b0e9',
  ),
  def(
    'Data',
    [512, 440, 440, 68, 57],
    'fx.construct',
    '施工（道具：机器工人；加盖房屋）',
    91,
    'exe',
    '0x445ecb → 0x445f0d、0x41a5c4',
  ),
  def('Data', [513, 440, 440, 90, 85], 'holiday.christmas', '圣诞（节日表 12/25）', 114, 'exe', '节日表 0x47d6ab'),
  def('Data', [514, 440, 440, 10, 71], 'fx.bankrupt', '房屋倒塌（破产）', 100, 'exe', '0x40ca83（破产 fcn.0040c84d）'),
  def('Data', [515, 440, 440, 14, 71], 'fx.gameOver', '地图崩裂（游戏结束，推断）', 101, 'visual', '0x407661'),
  def(
    'Data',
    [516, 440, 440, 22, 71],
    'fx.monsterCard',
    '怪兽（卡片：怪兽）',
    80,
    'exe',
    '0x4426c6 → 0x4426e8（卡片 11 处理）',
  ),
  def('Data', [517, 440, 440, 40, 42], 'fx.airplane', '飞机飞过（强迫出国观光，推断）', 96, 'guess', '0x40d053'),
  ...BOARD_CHUTES.map((row, c) =>
    def('Data', row, 'char.parachuteBoard', `角色 ${c} 在棋盘上跳伞落地`, null, 'visual', 'flic-data-482-529.png', {
      char: c,
    }),
  ),
  def('Panel', [4, 189, 285, 36, 14], 'dice.roll1', '掷 1 颗骰子', null, 'visual', 'flic-panel.png'),
  def('Panel', [5, 189, 285, 36, 14], 'dice.roll2', '掷 2 颗骰子', null, 'visual', 'flic-panel.png'),
  def('Panel', [6, 189, 285, 36, 14], 'dice.roll3', '掷 3 颗骰子', null, 'visual', 'flic-panel.png'),
  def('Panel', [14, 213, 68, 5, 71], 'ui.marquee', '跑马灯框', null, 'visual', 'flic-panel.png'),
  def('Panel', [16, 275, 270, 42, 71], 'lottery.machine', '乐透摇奖机', null, 'visual', 'flic-panel.png', {
    opaque: true,
  }),
  def('Panel', [17, 280, 480, 37, 71], 'lottery.streamers', '彩带（开奖庆祝，推断）', null, 'guess', 'flic-panel.png'),
  def('Panel', [20, 640, 480, 25, 71], 'magic.cast', '魔法屋施法', null, 'visual', 'flic-panel.png', { opaque: true }),
  def('Panel', [78, 640, 480, 20, 114], 'mg.ready', '小游戏入场 READY', null, 'visual', 'flic-panel.png'),
  def('jump', [42, 220, 240, 15, 71], 'setup.cabinDoor', '开局：机舱门打开', null, 'visual', 'flic-jump.png', {
    opaque: true,
  }),
  ...JUMP_FALL.map((row, c) =>
    def('jump', row, 'char.freefall', `角色 ${c} 自由落体（全屏开局跳伞）`, null, 'visual', 'flic-jump.png', {
      char: c,
    }),
  ),
  ...JUMP_OPEN.map((row, c) =>
    def('jump', row, 'char.parachuteOpen', `角色 ${c} 开伞（全屏开局跳伞）`, null, 'visual', 'flic-jump.png', {
      char: c,
    }),
  ),
];

/** 每个 MKF 里 FLIC 的数量（调研实测） */
export const FLIC_COUNTS: Readonly<Record<FlicMkf, number>> = { Data: 72, Panel: 8, jump: 25 };
