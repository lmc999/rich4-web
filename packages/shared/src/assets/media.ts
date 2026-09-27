/**
 * 音频与 FLIC 映射表（素材包 data/ 下的 JSON；design-draft §2.6「自动生成的映射表」、§3.5、§3.7；audio_video.md）。
 *
 * - voice-map（'rich4.voicemap/1'）：角色 × 27 事件槽、按道具号 / 卡号索引的道具与卡片台词、NPC 与新闻播报 → 语音条目逻辑键；
 * - sfx-sets（'rich4.sfxsets/1'）：场景音效集 → 音效条目逻辑键（进入场景时整组预载，与原版一致）；
 * - music-map（'rich4.musicmap/1'）：棋盘轮播曲与场景 → 音乐条目逻辑键（附原版 CD 轨号作证据）；
 * - flic-map（'rich4.flicmap/1'）：FLIC 条目 → 用途、尺寸、帧数、帧间隔、原版时长 ms、同步音效、摆放方式。
 *
 * 所有值都引用 manifest.entries 的逻辑键；原版资源号只出现在 src 与 track 等证据字段里。
 */
import { z } from 'zod';
import {
  ASSET_SCHEMA,
  type AssetParseResult,
  ConfidenceSchema,
  type ContractIssue,
  EvidenceSchema,
  LogicalKeySchema,
  NonNegIntSchema,
  PosIntSchema,
  reportIssues,
  runParse,
  runSafeParse,
  sortedKeys,
} from './common';

// ───────────────────────── 常量 ─────────────────────────

/** 原版 12 名角色（下标即 shared/data 的 CharacterId） */
export const CHARACTER_COUNT = 12;
/** 每名角色的事件槽数（1050+27c+slot） */
export const VOICE_SLOT_COUNT = 27;
/** 每名角色的卡片台词数（Speaking 分段 426+52c+k；k 只是分段内序号，与卡号的对应见 cardLines） */
export const VOICE_CARD_LINES = 52;
/** 每名角色的道具台词数（Speaking 分段 234+16c+k；k 只是分段内序号，与道具号的对应见 itemLines） */
export const VOICE_ITEM_LINES = 16;
/** 道具种数：道具号 1..13（与 shared/data 的 ItemId 同号；itemLines 下标 = 道具号 − 1） */
export const VOICE_ITEM_COUNT = 13;
/** 卡片种数：卡号 1..30（与 shared/data 的 CardId 同号；cardLines.* 下标 = 卡号 − 1） */
export const VOICE_CARD_COUNT = 30;
/**
 * 路面道具的反应台词（exe 道具台词表 j = 14..16）：hitRoadblock 被路障挡住 · hitMine 踩到地雷 ·
 * bombAttached 定时炸弹转到自己身上（推断）
 */
export const VOICE_ITEM_REACTIONS = ['hitRoadblock', 'hitMine', 'bombAttached'] as const;
export type VoiceItemReaction = (typeof VOICE_ITEM_REACTIONS)[number];
/** 卡片台词的场合：use 使用卡片 · self 对自己使用 · target 被施用者的反应 */
export const VOICE_CARD_MODES = ['use', 'self', 'target'] as const;
export type VoiceCardMode = (typeof VOICE_CARD_MODES)[number];

/**
 * 事件槽名（下标即槽号；触发门槛与概率见 design-draft §3.7，语义来自 r_minigames_chars §2.4，属推断）：
 * 0–2 得点券 >100 / 51–100 / 1–50 · 3–5 小额支出 · 6–8 进账 ≥9000×PI / 5000–9000 / 2000–5000 · 9–11 付钱（分档同进账）·
 * 12–14 罚款、医药费 · 15 盖到 5 级 · 16 买地后同街独占 ≥3 块 · 17 在独占街区加盖 · 18 被最敌对玩家拿走 ≥5000×PI ·
 * 19 坐牢 · 20 住院 · 21 梦游 · 22 坏神附身 · 23 坏神离身 · 24 胜利 · 25 破产 · 26 开局
 */
export const VOICE_SLOTS = [
  'pointsHigh',
  'pointsMid',
  'pointsLow',
  'spendSmall0',
  'spendSmall1',
  'spendSmall2',
  'incomeHigh',
  'incomeMid',
  'incomeLow',
  'payHigh',
  'payMid',
  'payLow',
  'fine0',
  'fine1',
  'fine2',
  'buildLevel5',
  'monopolyBuy',
  'monopolyBuild',
  'robbedByRival',
  'jail',
  'hospital',
  'sleepwalk',
  'badGodAttach',
  'badGodLeave',
  'win',
  'bankrupt',
  'gameStart',
] as const;
export type VoiceSlot = (typeof VOICE_SLOTS)[number];

export function voiceSlotIndex(slot: VoiceSlot): number {
  return VOICE_SLOTS.indexOf(slot);
}

/**
 * 音乐场景（music-map.scenes 的键；原版场景曲单曲循环，进入场景时把棋盘曲续播点压栈，离开后续播）。
 * gameOver 为结算画面；xicong / balloon / penguin 为三款小游戏；christmas / lunarNewYear 为节日。
 */
export const MUSIC_SCENES = [
  'title',
  'setup',
  'bankrupt',
  'bank',
  'auction',
  'shop',
  'lotteryBet',
  'gameOver',
  'magic',
  'lotteryDraw',
  'monthly',
  'xicong',
  'balloon',
  'penguin',
  'christmas',
  'lunarNewYear',
  'jail',
  'hospital',
] as const;
export const MusicSceneSchema = z.enum(MUSIC_SCENES);
export type MusicScene = z.output<typeof MusicSceneSchema>;

// ───────────────────────── voice-map ─────────────────────────

export const VoiceLineSchema = z.strictObject({
  /** 语音条目（manifest.entries，type 'audio'） */
  key: LogicalKeySchema,
  /** 台词原文（zh-TW；exe 中找不到文本的 33 条为 null） */
  text: z.string().max(200).nullable(),
  confidence: ConfidenceSchema,
});
export type VoiceLine = z.output<typeof VoiceLineSchema>;

/** 候选台词：空数组表示没有；多于一条时由 AudioEngine 按 (epoch, seq, 事件下标, seat) 的哈希确定性选择 */
const candidates = z.array(VoiceLineSchema).max(16);

/** 按卡号索引的一种场合：下标 = 卡号 − 1；空数组 = 该卡在这个场合没有台词 */
const perCard = z.array(candidates).length(VOICE_CARD_COUNT);

export const CharacterVoicesSchema = z.strictObject({
  /** 下标 = 事件槽号 0..26（VOICE_SLOTS） */
  slots: z.array(candidates).length(VOICE_SLOT_COUNT),
  /**
   * 使用道具时的台词：下标 = 道具号 − 1（道具号 1..13 = ItemId）。来自 exe 道具台词表（v2.06 0x47e03a）的逐角色对应——
   * 角色 0..10 的 Speaking 分段顺序与道具号不同，不能按分段序号推算
   */
  itemLines: z.array(candidates).length(VOICE_ITEM_COUNT),
  /** 路面道具的反应台词（VOICE_ITEM_REACTIONS） */
  itemReactions: z.strictObject({
    hitRoadblock: candidates,
    hitMine: candidates,
    bombAttached: candidates,
  }),
  /** 卡片台词：各场合的数组下标 = 卡号 − 1（卡号 1..30 = CardId；exe 卡片台词表 v2.06 0x47e51a） */
  cardLines: z.strictObject({
    /** 使用卡片（30 张都有） */
    use: perCard,
    /** 对自己使用（只有部分卡有） */
    self: perCard,
    /** 被施用者的反应（只有部分卡有） */
    target: perCard,
  }),
});
export type CharacterVoices = z.output<typeof CharacterVoicesSchema>;

export const VoiceMapV1BaseSchema = z.strictObject({
  schema: z.literal(ASSET_SCHEMA.voiceMap),
  /** 下标 = 角色号 0..11 */
  characters: z.array(CharacterVoicesSchema).length(CHARACTER_COUNT),
  /** NPC 台词：键为场景化的逻辑名（如 `shop.welcome`、`bank.loan`、`lottery.char.3`、`monthly.champion`） */
  npc: z.record(LogicalKeySchema, candidates),
  /** 新闻播报：键为新闻逻辑名（如 `news.4`） */
  news: z.record(LogicalKeySchema, candidates),
  src: EvidenceSchema,
});
export const VoiceMapV1Schema = VoiceMapV1BaseSchema;
export type VoiceMapV1 = z.output<typeof VoiceMapV1Schema>;

/** voice-map 引用的全部语音条目键（升序去重），用于与 manifest.entries 交叉检查 */
export function voiceMapKeys(v: VoiceMapV1): string[] {
  const set = new Set<string>();
  const add = (lines: readonly VoiceLine[]): void => {
    for (const l of lines) set.add(l.key);
  };
  for (const c of v.characters) {
    for (const s of c.slots) add(s);
    for (const s of c.itemLines) add(s);
    for (const k of VOICE_ITEM_REACTIONS) add(c.itemReactions[k]);
    for (const m of VOICE_CARD_MODES) for (const s of c.cardLines[m]) add(s);
  }
  for (const k of sortedKeys(v.npc)) add(v.npc[k]!);
  for (const k of sortedKeys(v.news)) add(v.news[k]!);
  return [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function safeParseVoiceMap(json: unknown): AssetParseResult<VoiceMapV1> {
  return runSafeParse(VoiceMapV1Schema, json);
}

export function parseVoiceMap(json: unknown): VoiceMapV1 {
  return runParse(ASSET_SCHEMA.voiceMap, VoiceMapV1Schema, json);
}

// ───────────────────────── sfx-sets ─────────────────────────

export const SfxSetSchema = z.strictObject({
  /** 音效条目（manifest.entries，type 'audio'），按原版表内顺序 */
  sfx: z.array(LogicalKeySchema).min(1),
  confidence: ConfidenceSchema,
  src: EvidenceSchema,
});
export type SfxSet = z.output<typeof SfxSetSchema>;

/**
 * 集合名建议：global（全局 UI）· board（棋盘主界面）· setup · mg.penguin · mg.balloon · mg.xicong · mg.common ·
 * stock · dividend · lottery.bet · lottery.draw · magic · monthly · auction · input.a · input.b
 */
export const SfxSetsV1BaseSchema = z.strictObject({
  schema: z.literal(ASSET_SCHEMA.sfxSets),
  sets: z.record(LogicalKeySchema, SfxSetSchema),
  src: EvidenceSchema,
});

function checkSfxSets(s: z.output<typeof SfxSetsV1BaseSchema>): ContractIssue[] {
  const issues: ContractIssue[] = [];
  for (const name of sortedKeys(s.sets)) {
    const list = s.sets[name]!.sfx;
    if (new Set(list).size !== list.length) issues.push({ path: ['sets', name, 'sfx'], message: '音效集内有重复项' });
  }
  return issues;
}

export const SfxSetsV1Schema = SfxSetsV1BaseSchema.superRefine((s, ctx) => reportIssues(ctx, checkSfxSets(s)));
export type SfxSetsV1 = z.output<typeof SfxSetsV1Schema>;

export function safeParseSfxSets(json: unknown): AssetParseResult<SfxSetsV1> {
  return runSafeParse(SfxSetsV1Schema, json);
}

export function parseSfxSets(json: unknown): SfxSetsV1 {
  return runParse(ASSET_SCHEMA.sfxSets, SfxSetsV1Schema, json);
}

// ───────────────────────── music-map ─────────────────────────

export const MusicTrackRefSchema = z.strictObject({
  /** 音乐条目（manifest.entries，type 'audio'；循环区间写在条目的 loop 上） */
  key: LogicalKeySchema,
  /** 原版 CD 轨号（Steam 版 Media/Music/trackNN.ogg）；替换素材为 null */
  track: z.int().min(1).max(99).nullable(),
  confidence: ConfidenceSchema,
});
export type MusicTrackRef = z.output<typeof MusicTrackRefSchema>;

export const MusicMapV1BaseSchema = z.strictObject({
  schema: z.literal(ASSET_SCHEMA.musicMap),
  /** 棋盘轮播曲（原版 8 首，CD 轨 = idx + 2）；一曲放完接 (idx+1) % length，不循环 */
  board: z.array(MusicTrackRefSchema).min(1),
  /** 场景曲（原版 CD 轨 = arg + 10）；缺省的场景不切歌 */
  scenes: z.partialRecord(MusicSceneSchema, MusicTrackRefSchema),
  src: EvidenceSchema,
});
export const MusicMapV1Schema = MusicMapV1BaseSchema;
export type MusicMapV1 = z.output<typeof MusicMapV1Schema>;

export function safeParseMusicMap(json: unknown): AssetParseResult<MusicMapV1> {
  return runSafeParse(MusicMapV1Schema, json);
}

export function parseMusicMap(json: unknown): MusicMapV1 {
  return runParse(ASSET_SCHEMA.musicMap, MusicMapV1Schema, json);
}

// ───────────────────────── flic-map ─────────────────────────

/**
 * 摆放方式：board = 贴满原版棋盘视窗 440×440（镜头已对准目标，中心对齐锚点投影位置并随镜头缩放）·
 * screen = 原版 640×480 画面坐标 (x, y) 的左上角（如得点券 Ticket (204,180)）· actor = 画在角色旁（表情动画）·
 * fullscreen = 整屏 640×480（魔法屋施法、小游戏 READY、开局跳伞）
 */
export const FlicPlacementSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('board') }),
  z.strictObject({ kind: z.literal('screen'), x: z.int(), y: z.int() }),
  z.strictObject({ kind: z.literal('actor') }),
  z.strictObject({ kind: z.literal('fullscreen') }),
]);
export type FlicPlacement = z.output<typeof FlicPlacementSchema>;

export const FlicInfoSchema = z.strictObject({
  /** 用途逻辑名（如 `god.arrive.smallWealth`、`escort.hospital`、`explode.big`、`dice.2`、`parachute.3`），升序且唯一 */
  uses: z.array(LogicalKeySchema).min(1),
  w: PosIntSchema,
  h: PosIntSchema,
  frames: PosIntSchema,
  frameMs: PosIntSchema,
  /** 原版时长 = frames × frameMs（original 节奏下作为事件预算的依据） */
  durationMs: PosIntSchema,
  /** 同步音效条目（manifest.entries，type 'audio'）；无则 null */
  sfx: LogicalKeySchema.nullable(),
  /** 不透明（Panel#16、Panel#20、jump#42） */
  opaque: z.boolean(),
  /** compact 节奏下可截取的区间（帧号，含 startFrame、不含 endFrame）；不截取为 null */
  trim: z.strictObject({ startFrame: NonNegIntSchema, endFrame: PosIntSchema }).nullable(),
  placement: FlicPlacementSchema,
  confidence: ConfidenceSchema,
  src: EvidenceSchema,
});
export type FlicInfo = z.output<typeof FlicInfoSchema>;

export const FlicMapV1BaseSchema = z.strictObject({
  schema: z.literal(ASSET_SCHEMA.flicMap),
  /** 键为 FLIC 条目（manifest.entries，type 'flic'） */
  flics: z.record(LogicalKeySchema, FlicInfoSchema),
  src: EvidenceSchema,
});

function checkFlicMap(m: z.output<typeof FlicMapV1BaseSchema>): ContractIssue[] {
  const issues: ContractIssue[] = [];
  for (const key of sortedKeys(m.flics)) {
    const f = m.flics[key]!;
    const base = ['flics', key];
    if (f.durationMs !== f.frames * f.frameMs) {
      issues.push({ path: [...base, 'durationMs'], message: 'durationMs 必须等于 frames × frameMs' });
    }
    for (let i = 1; i < f.uses.length; i++) {
      if (!(f.uses[i - 1]! < f.uses[i]!)) issues.push({ path: [...base, 'uses'], message: 'uses 必须升序且唯一' });
    }
    if (f.trim && !(f.trim.startFrame < f.trim.endFrame && f.trim.endFrame <= f.frames)) {
      issues.push({ path: [...base, 'trim'], message: 'trim 必须满足 0 ≤ startFrame < endFrame ≤ frames' });
    }
  }
  return issues;
}

export const FlicMapV1Schema = FlicMapV1BaseSchema.superRefine((m, ctx) => reportIssues(ctx, checkFlicMap(m)));
export type FlicMapV1 = z.output<typeof FlicMapV1Schema>;

export function safeParseFlicMap(json: unknown): AssetParseResult<FlicMapV1> {
  return runSafeParse(FlicMapV1Schema, json);
}

export function parseFlicMap(json: unknown): FlicMapV1 {
  return runParse(ASSET_SCHEMA.flicMap, FlicMapV1Schema, json);
}

/** 用途 → FLIC 条目键（升序；同一用途可有多个候选，如 UFO 光束 492/498） */
export function flicsForUse(m: FlicMapV1, use: string): string[] {
  return sortedKeys(m.flics).filter((k) => m.flics[k]!.uses.includes(use));
}

/** 用途 → 候选 FLIC 的反向索引（键与值均升序） */
export function flicUseIndex(m: FlicMapV1): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  for (const k of sortedKeys(m.flics)) {
    for (const use of m.flics[k]!.uses) {
      const list = idx.get(use);
      if (list) list.push(k);
      else idx.set(use, [k]);
    }
  }
  return new Map([...idx.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
