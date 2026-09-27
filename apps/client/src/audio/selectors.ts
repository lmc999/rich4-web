// 原版映射选择器（design-draft §3.7；audio_video.md §2、§3）：
// - sceneLayersFor / sceneFor(uiState)：UI 状态 → 场景曲（标题、开局设定、场所屏、小游戏、节日、结算）；
// - sfxFor(event)：soundMap 的音效提示 → 素材包音效键（cue.<name> 音效集）或 ZzFX 预设键；
// - voiceFor(event, ctx)：soundMap 的语音提示 → voice-map 的语音键，按 {epoch, seq, 事件下标} 哈希确定性选择变体与概率，
//   所有客户端与观战者听到同一句；
// - musicKeyFor(scene) / boardPlaylist：music-map → 音乐键。
import type { Confidence, MusicMapV1, MusicScene, SfxSetsV1, VoiceLine, VoiceMapV1 } from '@rich4/shared/assets';
import { VOICE_SLOTS, voiceSlotIndex } from '@rich4/shared/assets';
import type { MapIndex } from '@rich4/shared/data';
import type { DecisionKind, GameEvent, MinigameId, SeatIndex } from '@rich4/shared/engine';
import { fnv1a32, mix32 } from '@rich4/shared/util';
import type { GameView } from '@rich4/shared/view';
import { soundFor } from '../presentation/soundMap';
import type { SceneCue, SfxCue, SoundQuery, VoiceCue } from './cues';
import { zzfxKey } from './procedural';
import type { VoicePolicy } from './voice';

// ───────────────────────── 场景（UI 状态） ─────────────────────────

export type AudioScreen = 'none' | 'title' | 'lobby' | 'game' | 'gameOver';

/** 当前全场可见的场所 / 决策（本人的决策，或他人公开的 pending：原版所有人同屏看场所屏） */
export interface AudioVenue {
  kind: DecisionKind;
  /** BAIL：监狱或医院 */
  where?: 'jail' | 'hospital';
  /** MINIGAME：哪一款 */
  minigameId?: MinigameId;
}

export interface AudioUiState {
  screen: AudioScreen;
  venue?: AudioVenue | null;
  /** 今日节日的场景曲（holidaySceneOf 由 view.clock.holiday 与地图节日表推出） */
  holiday?: 'christmas' | 'lunarNewYear' | null;
}

export interface SceneRequest {
  scene: MusicScene;
  noResume: boolean;
}

const MINIGAME_SCENE: Readonly<Record<MinigameId, MusicScene>> = {
  penguin: 'penguin',
  balloon: 'balloon',
  xicong: 'xicong',
};

/** 决策 → 场所曲（原版场景曲调用点，audio_video.md §3.2；ATM 与银行柜台都在银行函数内） */
export function venueScene(v: AudioVenue): MusicScene | null {
  switch (v.kind) {
    case 'BANK_ATM':
    case 'BANK_COUNTER':
      return 'bank';
    case 'SHOP':
      return 'shop';
    case 'LOTTERY':
      return 'lotteryBet';
    case 'MAGIC_CAST':
      return 'magic';
    case 'AUCTION_BID':
      return 'auction';
    case 'BAIL':
      return v.where === 'hospital' ? 'hospital' : 'jail';
    case 'MINIGAME':
      return v.minigameId ? MINIGAME_SCENE[v.minigameId] : null;
    default:
      return null;
  }
}

/** 原版 bit15（不记录棋盘曲续播点）的场景：开局设定、结算、节日 */
export const NO_RESUME_SCENES: ReadonlySet<MusicScene> = new Set<MusicScene>([
  'setup',
  'gameOver',
  'christmas',
  'lunarNewYear',
]);

function req(scene: MusicScene): SceneRequest {
  return { scene, noResume: NO_RESUME_SCENES.has(scene) };
}

/**
 * UI 决定的场景层（自下而上）：[节日, 场所]。空数组表示棋盘轮播曲（对局中）或静音。
 * 标题、开局设定（房间大厅）、结算占整屏，独占一层。
 */
export function sceneLayersFor(ui: AudioUiState): { ambient: SceneRequest | null; venue: SceneRequest | null } {
  switch (ui.screen) {
    case 'title':
      return { ambient: null, venue: req('title') };
    case 'lobby':
      return { ambient: null, venue: req('setup') };
    case 'gameOver':
      return { ambient: null, venue: req('gameOver') };
    case 'game': {
      const v = ui.venue ? venueScene(ui.venue) : null;
      return { ambient: ui.holiday ? req(ui.holiday) : null, venue: v ? req(v) : null };
    }
    default:
      return { ambient: null, venue: null };
  }
}

/** 当前应当听到的场景曲（栈顶）；null = 棋盘轮播或静音 */
export function sceneFor(ui: AudioUiState): SceneRequest | null {
  const l = sceneLayersFor(ui);
  return l.venue ?? l.ambient;
}

/** 棋盘轮播曲是否应在底层播放 */
export function boardActiveFor(ui: AudioUiState): boolean {
  return ui.screen === 'game';
}

/** 今日节日的场景曲：节日表标了 bgm 的农历节日 → 农历新年曲，其余 → 圣诞曲（原版节日表 music 13 / 14） */
export function holidaySceneOf(view: GameView, map: MapIndex | null): 'christmas' | 'lunarNewYear' | null {
  const key = view.clock.holiday;
  if (!key || !map) return null;
  const m = /^h(\d+)$/.exec(key);
  if (!m) return null;
  const h = map.def.holidays.find((x) => x.slot === Number(m[1]));
  if (!h?.bgm) return null;
  return h.lunar ? 'lunarNewYear' : 'christmas';
}

// ───────────────────────── 音乐键 ─────────────────────────

export function musicKeyFor(scene: MusicScene, mm: MusicMapV1 | null): string | null {
  return mm?.scenes[scene]?.key ?? null;
}

export function boardPlaylist(mm: MusicMapV1 | null): string[] {
  return mm ? mm.board.map((t) => t.key) : [];
}

// ───────────────────────── 确定性种子 ─────────────────────────

/** 事件上下文（EventPlayer 为每个事件提供 epoch、seq 与批内下标；缺失时回退到事件内容哈希） */
export interface EventSeedCtx {
  epoch?: number;
  seq?: number;
  eventIndex?: number;
}

/**
 * 语音选择的种子：hash(epoch, seq, eventIndex)。三者齐全时所有客户端一致；
 * 缺失时（旧上下文）用事件 JSON 的 FNV-1a 回退——服务器下发的事件对所有观察者字节相同（脱敏字段除外）。
 */
export function voiceSeed(e: GameEvent, ctx: EventSeedCtx): number {
  if (ctx.epoch !== undefined && ctx.seq !== undefined && ctx.eventIndex !== undefined) {
    return mix32(ctx.epoch >>> 0, ctx.seq >>> 0, ctx.eventIndex >>> 0);
  }
  const { post: _post, ...rest } = e as GameEvent & { post?: unknown };
  return mix32(fnv1a32(JSON.stringify(rest)), ctx.seq ?? 0, ctx.eventIndex ?? 0);
}

/** 盐：区分同一事件里的不同用途（选变体 / 掷概率 / 二选一） */
const SALT_PICK = 0x51c4;
const SALT_CHANCE = 0xc4a7;
const SALT_ALT = 0xa17e;

/** [0, n) 内的确定性选择 */
export function pickIndex(seed: number, n: number, ...keys: number[]): number {
  if (n <= 1) return 0;
  return mix32(seed, ...keys) % n;
}

// ───────────────────────── 音效 ─────────────────────────

export interface ResolvedSfx {
  /** 逻辑键：素材包 `sfx.NNN` 或 `zzfx.<预设>` */
  key: string;
  bus: 'sfx' | 'ui';
  origin: 'pack' | 'zzfx';
  /** 素材包音效集的语义置信度（ZzFX 为 null） */
  confidence: Confidence | null;
  cue: string | null;
}

export interface SfxResolveOptions {
  /** 语义置信度为 guess 的原版音效也用原版（试听核对用；缺省 false = 用 ZzFX） */
  guessOriginal?: boolean;
  /** 原版皮肤由 FLIC 同步出声：flicCovered 的提示不再放音效 */
  flicSfx?: boolean;
}

/** 音效提示 → 逻辑键（素材包音效集有多个音效时按种子确定性选一个） */
export function resolveSfxCue(
  c: SfxCue,
  sets: SfxSetsV1 | null,
  seed: number,
  o: SfxResolveOptions = {},
): ResolvedSfx | null {
  if (c.flicCovered && o.flicSfx) return null;
  const bus = c.bus ?? 'sfx';
  if (c.cue !== undefined && sets) {
    const name = `cue.${c.cue}`;
    const set = Object.hasOwn(sets.sets, name) ? sets.sets[name] : undefined;
    if (set && (set.confidence !== 'guess' || o.guessOriginal)) {
      const key = set.sfx[pickIndex(seed, set.sfx.length, SALT_PICK)]!;
      return { key, bus, origin: 'pack', confidence: set.confidence, cue: c.cue };
    }
  }
  if (c.zzfx) return { key: zzfxKey(c.zzfx), bus, origin: 'zzfx', confidence: null, cue: c.cue ?? null };
  return null;
}

/** 规则可以是常量或 (事件, 查询) => 值；按事件类型从 soundMap 取出后在联合类型上统一求值 */
function evalRule<R>(r: unknown, e: GameEvent, q: SoundQuery): R | null {
  if (r === undefined) return null;
  return typeof r === 'function' ? ((r as (x: GameEvent, q: SoundQuery) => R | null)(e, q) ?? null) : (r as R);
}

export function sfxCueFor(e: GameEvent, q: SoundQuery): SfxCue | null {
  return evalRule<SfxCue>(soundFor(e.type).sfx, e, q);
}

export function sfxFor(
  e: GameEvent,
  q: SoundQuery,
  sets: SfxSetsV1 | null,
  ctx: EventSeedCtx,
  o: SfxResolveOptions = {},
): ResolvedSfx | null {
  const c = sfxCueFor(e, q);
  return c ? resolveSfxCue(c, sets, voiceSeed(e, ctx), o) : null;
}

export function sceneCueFor(e: GameEvent, q: SoundQuery): SceneCue | null {
  return evalRule<SceneCue>(soundFor(e.type).scene, e, q);
}

// ───────────────────────── 语音 ─────────────────────────

export interface ResolvedVoice {
  key: string;
  /** `seat:N` / `npc` / `news` */
  speaker: string;
  policy: VoicePolicy;
  maxWaitMs?: number;
  confidence: Confidence;
  /** 解析出这句话的提示（试听页与日志） */
  cue: VoiceCue;
}

export function voiceCuesFor(e: GameEvent, q: SoundQuery): readonly VoiceCue[] {
  const spec = soundFor(e.type) as { voice?: (x: GameEvent, q: SoundQuery) => readonly VoiceCue[] };
  return spec.voice ? spec.voice(e, q) : [];
}

/** 提示的候选台词（素材包里没有时为空） */
export function voiceCandidates(
  c: VoiceCue,
  vm: VoiceMapV1,
  q: Pick<SoundQuery, 'character'>,
  seed: number,
  i: number,
): VoiceLine[] {
  const charOf = (seat: SeatIndex) => {
    const ch = q.character(seat);
    return ch === null ? null : (vm.characters[ch] ?? null);
  };
  switch (c.k) {
    case 'slot': {
      const cv = charOf(c.seat);
      if (!cv) return [];
      const slots = [c.slot, ...(c.alt ?? [])];
      const slot = slots[pickIndex(seed, slots.length, SALT_ALT, i)]!;
      return cv.slots[voiceSlotIndex(slot)] ?? [];
    }
    case 'card': {
      const cv = charOf(c.seat);
      return cv?.cardLines[c.mode][c.card - 1] ?? [];
    }
    case 'item': {
      const cv = charOf(c.seat);
      return cv?.itemLines[c.item - 1] ?? [];
    }
    case 'reaction': {
      const cv = charOf(c.seat);
      return cv?.itemReactions[c.reaction] ?? [];
    }
    case 'npc':
      return Object.hasOwn(vm.npc, c.key) ? vm.npc[c.key]! : [];
    case 'name': {
      const ch = q.character(c.seat);
      const k = ch === null ? null : `${c.base}.${ch}`;
      return k !== null && Object.hasOwn(vm.npc, k) ? vm.npc[k]! : [];
    }
    case 'news':
      return Object.hasOwn(vm.news, c.key) ? vm.news[c.key]! : [];
  }
}

function speakerOf(c: VoiceCue): string {
  switch (c.k) {
    case 'npc':
    case 'name':
      return 'npc';
    case 'news':
      return 'news';
    default:
      return `seat:${c.seat}`;
  }
}

export interface VoiceResolveOptions {
  /** 语义置信度为 guess 的台词是否也播（缺省 true：台词本身是角色原声，只是触发时机为推断） */
  allowGuess?: boolean;
}

/** 提示列表 → 语音（确定性：同一 seed 总得到同一结果） */
export function resolveVoiceCues(
  cues: readonly VoiceCue[],
  vm: VoiceMapV1 | null,
  q: Pick<SoundQuery, 'character'>,
  seed: number,
  o: VoiceResolveOptions = {},
): ResolvedVoice[] {
  if (!vm) return [];
  const out: ResolvedVoice[] = [];
  const one = (c: VoiceCue, i: number, depth: number): void => {
    let ok = true;
    if (c.k === 'slot' && c.chance !== undefined && c.chance > 1) {
      ok = pickIndex(seed, Math.trunc(c.chance), SALT_CHANCE, i, depth) === 0;
    }
    let lines = ok ? voiceCandidates(c, vm, q, seed, i) : [];
    if (o.allowGuess === false) lines = lines.filter((l) => l.confidence !== 'guess');
    if (lines.length === 0) {
      if (c.orElse && depth < 4) one(c.orElse, i, depth + 1);
      return;
    }
    const line = lines[pickIndex(seed, lines.length, SALT_PICK, i, depth)]!;
    const r: ResolvedVoice = {
      key: line.key,
      speaker: speakerOf(c),
      policy: c.policy ?? 'original',
      confidence: line.confidence,
      cue: c,
    };
    if (c.maxWaitMs !== undefined) r.maxWaitMs = c.maxWaitMs;
    out.push(r);
  };
  cues.forEach((c, i) => {
    one(c, i, 0);
  });
  return out;
}

export function voiceFor(
  e: GameEvent,
  q: SoundQuery,
  vm: VoiceMapV1 | null,
  ctx: EventSeedCtx,
  o: VoiceResolveOptions = {},
): ResolvedVoice[] {
  return resolveVoiceCues(voiceCuesFor(e, q), vm, q, voiceSeed(e, ctx), o);
}

/** 试听页：事件槽名（下标即槽号） */
export const VOICE_SLOT_NAMES = VOICE_SLOTS;
