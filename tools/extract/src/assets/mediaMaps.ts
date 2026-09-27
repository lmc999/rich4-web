/**
 * 原版皮肤 A2：把 A3 的音视频产物与映射表接入素材包契约（@rich4/shared/assets）。
 *
 * - 音频条目：voice.<id4> / sfx.<id3> / music.track<nn>，每条合并 opus 与 m4a 两种格式；分组按 A3 的载入粒度
 *   （audio.voice.system、audio.voice.char.<c>、audio.sfx、audio.music.track<nn>）。
 * - A3 的映射表（rich4.voice-map/1 等，按原版编号组织，含描述与证据）原样作为「详表」放在 data/detail/；
 *   客户端用的契约版映射表（rich4.voicemap/1、rich4.sfxsets/1、rich4.musicmap/1、rich4.flicmap/1）由详表换算，
 *   值一律是 manifest.entries 的逻辑键。音效「用途」（A3 cues）写成 cue.<用途> 的单用途音效集。
 * - voice-map 的道具、卡片台词按道具号 / 卡号索引（取自 A3 从 exe 台词表解出的对应），不按 Speaking 分段序号。
 * - 不写任何原版台词文本（VoiceLine.text 一律为 null）。
 */
import {
  type AudioEntry,
  type Confidence,
  type FlicInfo,
  type FlicMapV1,
  type MusicMapV1,
  type MusicScene,
  parseFlicMap,
  parseMusicMap,
  parseSfxSets,
  parseVoiceMap,
  type SfxSetsV1,
  VOICE_CARD_COUNT,
  VOICE_ITEM_COUNT,
  VOICE_ITEM_REACTIONS,
  type VoiceLine,
  type VoiceMapV1,
} from '@rich4/shared/assets';
import { ExtractError } from '../context';
import type { BuiltFile, MusicMapJson, SfxSetsJson, VoiceMapJson } from './audio';
import { type FlicItem, ROAD_OBJECTS } from './catalog.v206';
import { MUSIC_SCENES, MUSIC_TRACKS } from './data/music';
import { CARD_LINE_MODE_CONFIDENCE, EVENT_SLOTS, VOICE_IDS_WITHOUT_TEXT } from './data/voice';

// ───────────────────────── 逻辑键 ─────────────────────────

const pad = (n: number, w: number) => String(n).padStart(w, '0');
export const voiceKey = (id: number): string => `voice.${pad(id, 4)}`;
export const sfxKey = (id: number): string => `sfx.${pad(id, 3)}`;
export const musicKey = (track: number): string => `music.track${pad(track, 2)}`;
export const videoKey = (key: string): string => `video.${key}`;

/** A3 产物的逻辑路径 → (种类, 编号) */
export function parseAudioFileKey(fileKey: string): { kind: 'voice' | 'sfx' | 'music'; id: number } | null {
  const m = /^audio\/(voice|sfx|music)\/(?:track)?(\d+)\.(?:opus|m4a)$/.exec(fileKey);
  if (!m) return null;
  return { kind: m[1] as 'voice' | 'sfx' | 'music', id: Number(m[2]) };
}

// ───────────────────────── 音频条目 ─────────────────────────

export interface AudioSourceInfo {
  sampleRate: number;
  channels: 1 | 2;
}

export interface AudioEntryOut {
  key: string;
  group: string;
  entry: AudioEntry;
  /** 条目引用的 A3 产物（逻辑路径 → 已写好的文件） */
  files: BuiltFile[];
}

/**
 * 按 A3 的 BuiltFile 列表生成音频条目。charOf：语音号 → 角色号（系统语音为 undefined）。
 * durationMs 取各格式实测时长的最小值（保证循环区间不越界）。场景曲 loop = [0, durationMs]（文件已裁到循环区间）。
 */
export function audioEntries(
  files: readonly BuiltFile[],
  info: (kind: 'voice' | 'sfx' | 'music', id: number) => AudioSourceInfo,
  charOf: (voiceId: number) => number | undefined,
): AudioEntryOut[] {
  const by = new Map<string, { kind: 'voice' | 'sfx' | 'music'; id: number; files: BuiltFile[] }>();
  for (const f of files) {
    const p = parseAudioFileKey(f.key);
    if (!p) continue;
    const key = p.kind === 'voice' ? voiceKey(p.id) : p.kind === 'sfx' ? sfxKey(p.id) : musicKey(p.id);
    const slot = by.get(key) ?? { ...p, files: [] };
    slot.files.push(f);
    by.set(key, slot);
  }
  const sceneTracks = new Set(MUSIC_TRACKS.filter((t) => t.role === 'scene').map((t) => t.track));
  const out: AudioEntryOut[] = [];
  for (const key of [...by.keys()].sort()) {
    const s = by.get(key)!;
    const opus = s.files.find((f) => f.format === 'opus');
    const m4a = s.files.find((f) => f.format === 'm4a');
    const durationMs = Math.max(1, Math.min(...s.files.map((f) => f.durationMs ?? 0)));
    const c = s.kind === 'voice' ? charOf(s.id) : undefined;
    const group =
      s.kind === 'voice'
        ? c === undefined
          ? 'audio.voice.system'
          : `audio.voice.char.${c}`
        : s.kind === 'sfx'
          ? 'audio.sfx'
          : `audio.music.track${pad(s.id, 2)}`;
    const src =
      s.kind === 'voice'
        ? [`Speaking#${s.id}`]
        : s.kind === 'sfx'
          ? [`Effect#${s.id}`]
          : [`Media/Music/track${pad(s.id, 2)}.ogg`];
    const { sampleRate, channels } = info(s.kind, s.id);
    const entry: AudioEntry = {
      type: 'audio',
      group,
      confidence: 'exe',
      src,
      files: {
        ...(opus ? { opus: opus.key } : {}),
        ...(m4a ? { m4a: m4a.key } : {}),
      },
      durationMs,
      channels,
      sampleRate,
      loop: s.kind === 'music' && sceneTracks.has(s.id) ? { startMs: 0, endMs: durationMs } : null,
    };
    out.push({ key, group, entry, files: s.files });
  }
  return out;
}

/** 语音号 → 角色号（道具、卡片、事件台词；与 A3 suggestAudioGroups 一致） */
export function voiceCharIndex(vm: VoiceMapJson): Map<number, number> {
  const m = new Map<number, number>();
  vm.events.byChar.forEach((row, c) => {
    for (const id of row) m.set(id, c);
  });
  vm.items.byChar.forEach((row, c) => {
    for (const id of row) m.set(id, c);
  });
  for (const r of vm.items.reactions) {
    r.byChar.forEach((id, c) => {
      m.set(id, c);
    });
  }
  vm.cards.use.forEach((row, c) => {
    for (const id of row) m.set(id, c);
  });
  for (const s of [...vm.cards.self, ...vm.cards.target]) {
    s.byChar.forEach((id, c) => {
      m.set(id, c);
    });
  }
  return m;
}

// ───────────────────────── voice-map ─────────────────────────

const NO_TEXT = new Set(VOICE_IDS_WITHOUT_TEXT);

/**
 * A3 详表 → 契约版 voice-map（每个槽位一条候选）。道具与卡片台词按语义索引：itemLines[道具号 − 1]、
 * itemReactions.<反应>、cardLines.{use,self,target}[卡号 − 1]，全部取自 A3 从 exe 台词表（0x47e03a、0x47e51a）
 * 解出的逐角色对应——角色 0..10 的道具台词在 Speaking 分段里是置换过的，不能按分段序号 k 推算。
 */
export function toVoiceMapV1(vm: VoiceMapJson): VoiceMapV1 {
  const line = (id: number, confidence: Confidence): VoiceLine[] => [
    { key: voiceKey(id), text: null, confidence: NO_TEXT.has(id) ? 'guess' : confidence },
  ];
  const reactionKeys = new Set<string>(VOICE_ITEM_REACTIONS);
  const unknownReaction = vm.items.reactions.find((r) => !reactionKeys.has(r.key));
  if (unknownReaction) {
    throw new ExtractError('E_VOICE_MAP', `契约里没有道具反应台词 ${unknownReaction.key}（VOICE_ITEM_REACTIONS）`);
  }
  if (vm.items.byChar.some((row) => row.length !== VOICE_ITEM_COUNT)) {
    throw new ExtractError('E_VOICE_MAP', `道具台词应为每角色 ${VOICE_ITEM_COUNT} 条（道具号 1..${VOICE_ITEM_COUNT}）`);
  }
  if (vm.cards.use.some((row) => row.length !== VOICE_CARD_COUNT)) {
    throw new ExtractError(
      'E_VOICE_MAP',
      `卡片使用台词应为每角色 ${VOICE_CARD_COUNT} 条（卡号 1..${VOICE_CARD_COUNT}）`,
    );
  }
  const perCard = (mode: 'self' | 'target', c: number): VoiceLine[][] => {
    const rows = vm.cards[mode];
    return Array.from({ length: VOICE_CARD_COUNT }, (_, i) => {
      const hit = rows.find((r) => r.cardId === i + 1);
      return hit ? line(hit.byChar[c]!, CARD_LINE_MODE_CONFIDENCE[mode]) : [];
    });
  };
  const characters = vm.events.byChar.map((row, c) => {
    const reaction = (key: string): VoiceLine[] => {
      const r = vm.items.reactions.find((x) => x.key === key);
      return r ? line(r.byChar[c]!, r.confidence) : [];
    };
    return {
      slots: row.map((id, s) => line(id, EVENT_SLOTS[s]!.confidence)),
      itemLines: vm.items.byChar[c]!.map((id) => line(id, 'exe')),
      itemReactions: {
        hitRoadblock: reaction('hitRoadblock'),
        hitMine: reaction('hitMine'),
        bombAttached: reaction('bombAttached'),
      },
      cardLines: {
        use: vm.cards.use[c]!.map((id) => line(id, CARD_LINE_MODE_CONFIDENCE.use)),
        self: perCard('self', c),
        target: perCard('target', c),
      },
    };
  });
  const npc: Record<string, VoiceLine[]> = {};
  // 多条的 NPC 台词：既给出整组候选（≤16 条时；由 AudioEngine 确定性选一条），也给出按下标的单条键 `<键>.<i>`
  //（magic.condition 这类「下标即条件号」的表必须按下标取）
  for (const n of vm.npc) {
    if (n.ids.length <= 16) npc[n.key] = n.ids.flatMap((id) => line(id, n.confidence));
    if (n.ids.length > 1) {
      n.ids.forEach((id, i) => {
        npc[`${n.key}.${i}`] = line(id, n.confidence);
      });
    }
  }
  for (const n of vm.names) {
    n.byChar.forEach((id, c) => {
      npc[`${n.key}.${c}`] = line(id, n.confidence);
    });
  }
  const news: Record<string, VoiceLine[]> = {};
  vm.news.forEach((id, i) => {
    news[`news.${i}`] = line(id, 'visual');
  });
  vm.fate.forEach((id, i) => {
    news[`fate.${i}`] = line(id, 'visual');
  });
  return parseVoiceMap({
    schema: 'rich4.voicemap/1',
    characters,
    npc,
    news,
    src: [
      `事件槽表 VA ${vm.events.tableVa}`,
      `道具台词表 VA ${vm.items.tableVa}`,
      `卡片台词表 VA ${vm.cards.tableVa}`,
      'data/detail/voice-map.json（A3 详表）',
    ],
  });
}

// ───────────────────────── sfx-sets ─────────────────────────

/** A3 音效集键 → 契约建议的集合名 */
const SFX_SET_NAMES: Readonly<Record<string, string>> = {
  ui: 'global',
  board: 'board',
  setup: 'setup',
  'mg.penguin': 'mg.penguin',
  'mg.balloon': 'mg.balloon',
  'mg.fortune': 'mg.xicong',
  'mg.common': 'mg.common',
  stock: 'stock',
  'stock.dividend': 'dividend',
  'lottery.bet': 'lottery.bet',
  'lottery.draw': 'lottery.draw',
  magic: 'magic',
  month: 'monthly',
  auction: 'auction',
  'numpad.a': 'input.a',
  'numpad.b': 'input.b',
};

export function toSfxSetsV1(ss: SfxSetsJson, has: (key: string) => boolean): SfxSetsV1 {
  const sets: SfxSetsV1['sets'] = {};
  for (const s of ss.sets) {
    const name = SFX_SET_NAMES[s.key] ?? s.key;
    const sfx = s.ids.map(sfxKey).filter(has);
    if (sfx.length > 0)
      sets[name] = { sfx, confidence: 'exe', src: [`VA ${s.va}`, ...s.loadedAt.map((a) => `push ${a}`)] };
  }
  for (const c of ss.cues) {
    const sfx = [...new Set(c.ids.map(sfxKey))].filter(has);
    if (sfx.length > 0) sets[`cue.${c.key}`] = { sfx, confidence: c.confidence, src: c.evidence.map((e) => `VA ${e}`) };
  }
  return parseSfxSets({
    schema: 'rich4.sfxsets/1',
    sets,
    src: ['exe v2.06 play_sound_effect 0x4529ee', 'data/detail/sfx-sets.json（A3 详表）'],
  });
}

// ───────────────────────── music-map ─────────────────────────

/** A3 场景键 → 契约 MusicScene（bankrupt.alt 与拍卖同曲，契约里只有 bankrupt，不单列） */
const MUSIC_SCENE_NAMES: Readonly<Record<string, MusicScene>> = {
  title: 'title',
  setup: 'setup',
  gameOver: 'gameOver',
  bankrupt: 'bankrupt',
  'mg.penguin': 'penguin',
  'mg.balloon': 'balloon',
  'mg.fortune': 'xicong',
  'shop.item': 'shop',
  'lottery.bet': 'lotteryBet',
  'lottery.draw': 'lotteryDraw',
  magic: 'magic',
  bank: 'bank',
  month: 'monthly',
  auction: 'auction',
  jail: 'jail',
  hospital: 'hospital',
  'holiday.christmas': 'christmas',
  'holiday.lunarNewYear': 'lunarNewYear',
};

export function toMusicMapV1(mm: MusicMapJson, has: (key: string) => boolean): MusicMapV1 {
  const board = MUSIC_TRACKS.filter((t) => t.role === 'board')
    .sort((a, b) => (a.boardIdx ?? 0) - (b.boardIdx ?? 0))
    .map((t) => ({ key: musicKey(t.track), track: t.track, confidence: 'exe' as const }))
    .filter((t) => has(t.key));
  const scenes: MusicMapV1['scenes'] = {};
  for (const s of mm.scenes) {
    const name = MUSIC_SCENE_NAMES[s.key];
    if (!name || !has(musicKey(s.track))) continue;
    scenes[name] = { key: musicKey(s.track), track: s.track, confidence: s.confidence };
  }
  return parseMusicMap({
    schema: 'rich4.musicmap/1',
    board,
    scenes,
    src: [
      '棋盘曲 CD 轨 = idx+2（0x4534ef）',
      `场景曲 CD 轨 = (arg&0x7fff)+10（${MUSIC_SCENES.length} 个调用场景）`,
      'data/detail/music-map.json（A3 详表）',
    ],
  });
}

// ───────────────────────── flic-map ─────────────────────────

const GOD_NAME: Readonly<Record<number, string>> = Object.fromEntries(ROAD_OBJECTS.map((o) => [o.t, o.name]));

/** FLIC 用途名：神明降临按 GodKind 名、按角色的动画带角色号，其余沿用 A3 的用途键 */
export function flicUses(it: FlicItem): string[] {
  const d = it.def;
  if (d.use === 'god.arrive') return [`god.arrive.${GOD_NAME[d.god ?? -1] ?? String(d.god)}`];
  if (d.char !== undefined) return [`${d.use}.${d.char}`];
  return [d.use];
}

/** 摆放方式：440×440 贴棋盘视窗；640×480 整屏；位置由 exe 调用参数可知的用 screen；其余按用途推断（src 注明） */
export function flicPlacement(it: FlicItem): { placement: FlicInfo['placement']; guessed: boolean } {
  const d = it.def;
  const at = `${d.mkf}#${d.res}`;
  if (at === 'Data#483') return { placement: { kind: 'screen', x: 0, y: 210 }, guessed: false };
  if (at === 'Data#495') return { placement: { kind: 'screen', x: 208, y: 180 }, guessed: false };
  if (at === 'Data#496') return { placement: { kind: 'screen', x: 204, y: 180 }, guessed: false };
  if (d.w === 440 && d.h === 440) return { placement: { kind: 'board' }, guessed: false };
  if (d.w === 640 && d.h === 480) return { placement: { kind: 'fullscreen' }, guessed: false };
  if (at === 'Data#485' || d.use.startsWith('char.emote')) return { placement: { kind: 'actor' }, guessed: true };
  if (d.use.startsWith('dice.')) return { placement: { kind: 'board' }, guessed: true };
  return { placement: { kind: 'screen', x: (640 - d.w) >> 1, y: (480 - d.h) >> 1 }, guessed: true };
}

export function flicInfo(it: FlicItem, sfx: string | null): FlicInfo {
  const d = it.def;
  const { placement, guessed } = flicPlacement(it);
  return {
    uses: flicUses(it),
    w: d.w,
    h: d.h,
    frames: d.frames,
    frameMs: d.frameMs,
    durationMs: d.frames * d.frameMs,
    sfx,
    opaque: d.opaque,
    trim: null,
    placement,
    confidence: d.confidence,
    src: [`${d.mkf}#${d.res}`, d.evidence, ...(guessed ? ['摆放位置为推断'] : [])],
  };
}

export function toFlicMapV1(flics: readonly { key: string; info: FlicInfo }[]): FlicMapV1 {
  const out: FlicMapV1['flics'] = {};
  for (const f of flics) out[f.key] = f.info;
  return parseFlicMap({
    schema: 'rich4.flicmap/1',
    flics: out,
    src: ['FLIC 播放 fcn.0044fc76 的 55 处调用点', 'data/detail/flic-map.json（A3 详表）'],
  });
}
