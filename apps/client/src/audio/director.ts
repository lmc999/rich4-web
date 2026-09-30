// 音频导演层：把 UI 状态与事件演出接到 AudioEngine（design-draft §3.7）。
// - setUi(uiState)：场景曲层（节日在下、场所在上）与棋盘轮播开关；进入场景时按原版音效集预载；
// - onEvent(e, ctx)：按 soundMap 播放音效与语音、压入事件期间的场景曲；返回的 end() 在该事件演出结束时调用；
//   wrapHandlers(handlers) 用它包住 presentation/handlers，整合时一行接入；标 timed 的语音（亮卡之后的卡片台词）
//   在事件开始时只选好台词，等 handler 按演出时刻调 speakTimed(e)（ctx.audio.voices）才说，end() 时没说的作废；
// - observe(e)：事件没有播放演出（instant / 后台标签页 / skipAll 追帧）时调用：不放声音，只收起以它为终点的场景曲
//   （拍卖曲到 AUCTION_ENDED 为止——标签页在拍卖期间切到后台，回来后不能一直压在棋盘曲上）；
// - setMaps(maps)：素材包的 voice-map / sfx-sets / music-map（没有素材包时全为 null：音效走 ZzFX，语音与音乐静默）。
import type { MapIndex } from '@rich4/shared/data';
import type { GameEvent, GameEventType } from '@rich4/shared/engine';
import type { GameView } from '@rich4/shared/view';
import { GAME_PRELOAD_CUES } from '../presentation/soundMap';
import type { AnyHandler, HandlerMap, PresentationContext } from '../presentation/types';
import type { SfxOptions } from './AudioEngine';
import { makeSoundQuery, type SfxCue } from './cues';
import type { ScenePushOptions } from './music';
import type { ZzfxPresetId } from './procedural';
import {
  type AudioUiState,
  boardActiveFor,
  boardPlaylist,
  type EventSeedCtx,
  musicKeyFor,
  type ResolvedSfx,
  type ResolvedVoice,
  resolveSfxCue,
  type SceneRequest,
  sceneCueFor,
  sceneLayersFor,
  sfxCueFor,
  voiceFor,
  voiceSeed,
} from './selectors';
import { type AudioMaps, EMPTY_AUDIO_MAPS } from './sources';
import type { VoiceOutcome, VoiceRequest } from './voice';

/** 导演层用到的引擎接口（AudioEngine 满足；测试可换成记录用的假实现） */
export interface DirectorEngine {
  playSfx(key: string, o?: SfxOptions): void;
  speak(req: VoiceRequest): Promise<VoiceOutcome>;
  stopVoice(): void;
  pushScene(key: string, o?: ScenePushOptions): number;
  popScene(token: number): void;
  batchScenes(fn: () => void): void;
  setBoardPlaylist(keys: readonly string[], startIdx?: number): void;
  setBoardActive(on: boolean): void;
  preload(keys: readonly string[]): Promise<void>;
}

export interface AudioDirectorOptions {
  /** 语义置信度 guess 的原版音效也用原版（缺省 false：用 ZzFX） */
  guessOriginal?: boolean;
  /** 原版皮肤里 FLIC 播放器负责同步音效（flicCovered 的提示不再另放） */
  flicSfx?: boolean;
  /** guess 台词是否播放（缺省 true） */
  allowGuessVoice?: boolean;
}

/** 事件的音频上下文：PresentationContext 的子集，加上 A5 让 ctx 携带的 {epoch, seq, eventIndex}（缺失时回退） */
export interface AudioEventCtx extends EventSeedCtx {
  view(): GameView;
  map: MapIndex | null;
}

export interface EventAudio {
  sfx: ResolvedSfx | null;
  /** 本事件选出的全部台词（含 timed 的） */
  voices: ResolvedVoice[];
  scene: string | null;
  /** 该事件演出结束（handler 返回或被中止）时调用 */
  end(): void;
}

/**
 * 界面音（countdown / countdownFinal：决策倒计时最后 10 秒的提示音，走音效总线，受音效音量控制；
 * go：原版皮肤用鼠标按下 GO 钮、点骰子数竖槽时的 Effect#1，exe 0x417ac9 / 0x417a08，素材包 cue.ui.go）
 */
export type UiCue = 'click' | 'back' | 'open' | 'move' | 'use' | 'go' | 'tick' | 'countdown' | 'countdownFinal';

const UI_CUES: Readonly<Record<UiCue, SfxCue>> = {
  click: { cue: 'ui.click', zzfx: 'click', bus: 'ui' },
  back: { cue: 'ui.back', zzfx: 'back', bus: 'ui' },
  open: { cue: 'ui.open', zzfx: 'open', bus: 'ui' },
  move: { cue: 'ui.move', zzfx: 'click', bus: 'ui' },
  use: { cue: 'ui.use', zzfx: 'magic', bus: 'ui' },
  go: { cue: 'ui.go', zzfx: 'click', bus: 'ui' },
  tick: { zzfx: 'tick' as ZzfxPresetId, bus: 'ui' },
  // 原版没有决策计时，素材包里没有语义对应的音效（audio_video.md §2）：只用 ZzFX
  countdown: { zzfx: 'countdown', bus: 'sfx' },
  countdownFinal: { zzfx: 'countdownFinal', bus: 'sfx' },
};

/** 场景 → 原版音效集（进入时预载；audio_video.md §2.2） */
const SCENE_SFX_SETS: Readonly<Partial<Record<string, readonly string[]>>> = {
  bank: ['input.a', 'input.b'],
  shop: ['input.a'],
  lotteryBet: ['lottery.bet'],
  lotteryDraw: ['lottery.draw'],
  magic: ['magic'],
  monthly: ['monthly'],
  auction: ['auction', 'input.a'],
  penguin: ['mg.penguin', 'mg.common'],
  balloon: ['mg.balloon', 'mg.common'],
  xicong: ['mg.xicong', 'mg.common'],
  setup: ['setup'],
};

/** preloaded 里代表「对局里按时刻放的事件音效」的标记（不是音效集名） */
const TIMED_PRELOAD = '#timed';

interface UiLayer {
  scene: SceneRequest;
  key: string;
  token: number;
}

interface HeldScene {
  token: number;
  until: ReadonlySet<GameEventType>;
}

export class AudioDirector {
  private maps: AudioMaps = EMPTY_AUDIO_MAPS;
  private ui: AudioUiState = { screen: 'none' };
  private ambient: UiLayer | null = null;
  private venue: UiLayer | null = null;
  private held: HeldScene[] = [];
  private readonly preloaded = new Set<string>();
  /** 事件开始时选好、等 handler 按演出时刻说出的台词（键为事件对象；end() 时作废） */
  private readonly timedVoices = new Map<GameEvent, ResolvedVoice[]>();
  private opts: Required<AudioDirectorOptions>;

  constructor(
    private readonly engine: DirectorEngine,
    o: AudioDirectorOptions = {},
  ) {
    this.opts = { guessOriginal: false, flicSfx: false, allowGuessVoice: true, ...o };
  }

  get options(): Readonly<Required<AudioDirectorOptions>> {
    return this.opts;
  }

  setOptions(o: AudioDirectorOptions): void {
    this.opts = { ...this.opts, ...o };
  }

  get currentMaps(): Readonly<AudioMaps> {
    return this.maps;
  }

  /** 素材包映射表（null = 无素材包） */
  setMaps(maps: AudioMaps | null): void {
    this.maps = maps ?? EMPTY_AUDIO_MAPS;
    this.preloaded.clear();
    this.engine.setBoardPlaylist(boardPlaylist(this.maps.musicMap));
    // 场景曲键可能变了：按当前 UI 重新挂层
    const ui = this.ui;
    this.engine.batchScenes(() => {
      this.dropUiLayers();
      this.syncUi(ui);
    });
    // 素材包通常晚于 setUi('game') 到达（对局页挂载后才发现素材包）：按当前 UI 预载音效集，
    // 否则棋盘阶段的首批音效要现场下载解码、超过 maxSfxLatencyMs 被当作 late 丢掉
    this.preloadFor(ui);
  }

  // ───────────────────────── UI 状态 ─────────────────────────

  setUi(ui: AudioUiState): void {
    this.ui = ui;
    this.engine.batchScenes(() => this.syncUi(ui));
    this.engine.setBoardActive(boardActiveFor(ui));
    this.preloadFor(ui);
  }

  private dropUiLayers(): void {
    if (this.venue) this.engine.popScene(this.venue.token);
    if (this.ambient) this.engine.popScene(this.ambient.token);
    this.venue = null;
    this.ambient = null;
  }

  private resolveLayer(r: SceneRequest | null): { scene: SceneRequest; key: string } | null {
    if (!r) return null;
    const key = musicKeyFor(r.scene, this.maps.musicMap);
    return key === null ? null : { scene: r, key };
  }

  private syncUi(ui: AudioUiState): void {
    const want = sceneLayersFor(ui);
    const amb = this.resolveLayer(want.ambient);
    const ven = this.resolveLayer(want.venue);
    const same = (cur: UiLayer | null, w: { scene: SceneRequest; key: string } | null): boolean =>
      cur === null ? w === null : w !== null && cur.key === w.key && cur.scene.noResume === w.scene.noResume;
    const ambientChanged = !same(this.ambient, amb);
    const venueChanged = !same(this.venue, ven);
    if (!ambientChanged && !venueChanged) return;
    // 节日层必须在场所层下面：节日变化时连同场所层一起重挂（在 batchScenes 内进行，同一首曲子不会重播）
    if (this.venue) this.engine.popScene(this.venue.token);
    this.venue = null;
    if (ambientChanged) {
      if (this.ambient) this.engine.popScene(this.ambient.token);
      this.ambient = amb ? { ...amb, token: this.engine.pushScene(amb.key, { noResume: amb.scene.noResume }) } : null;
    }
    if (ven) this.venue = { ...ven, token: this.engine.pushScene(ven.key, { noResume: ven.scene.noResume }) };
  }

  private preloadFor(ui: AudioUiState): void {
    const keys: string[] = [];
    const sets = this.maps.sfxSets;
    if (sets) {
      const names: string[] = ['global'];
      if (ui.screen === 'game') names.push('board');
      const v = sceneLayersFor(ui).venue;
      if (v) names.push(...(SCENE_SFX_SETS[v.scene] ?? []));
      for (const n of names) {
        if (this.preloaded.has(n) || !Object.hasOwn(sets.sets, n)) continue;
        this.preloaded.add(n);
        keys.push(...sets.sets[n]!.sfx);
      }
    }
    // 按演出时刻放、每回合都响的事件音效（掷骰的「咚」）与按 GO 的点击声：没有素材包时预合成 ZzFX
    if (ui.screen === 'game' && !this.preloaded.has(TIMED_PRELOAD)) {
      this.preloaded.add(TIMED_PRELOAD);
      // 已随某个音效集预载过的（GO 的 Effect#1 在全局音效集里）不再重复
      const inSets = (k: string): boolean =>
        sets !== null && [...this.preloaded].some((n) => sets.sets[n]?.sfx.includes(k) === true);
      for (const c of [...GAME_PRELOAD_CUES, UI_CUES.go]) {
        const r = resolveSfxCue({ ...c, timed: false }, sets, 0, { guessOriginal: this.opts.guessOriginal });
        if (r && !keys.includes(r.key) && !inSets(r.key)) keys.push(r.key);
      }
    }
    if (keys.length > 0) void this.engine.preload(keys);
  }

  // ───────────────────────── 事件 ─────────────────────────

  /** 收掉「直到某事件」的场景（拍卖曲到 AUCTION_ENDED 为止）；不放任何声音 */
  observe(e: Pick<GameEvent, 'type'>): void {
    if (this.held.length === 0) return;
    const keep: HeldScene[] = [];
    for (const h of this.held) {
      if (h.until.has(e.type)) this.engine.popScene(h.token);
      else keep.push(h);
    }
    this.held = keep;
  }

  /** 跨事件保持中的场景曲数（测试与调试用） */
  get heldScenes(): number {
    return this.held.length;
  }

  onEvent(e: GameEvent, ctx: AudioEventCtx): EventAudio {
    this.observe(e);
    const q = makeSoundQuery(ctx.view, ctx.map);
    const seedCtx: EventSeedCtx = {};
    if (ctx.epoch !== undefined) seedCtx.epoch = ctx.epoch;
    if (ctx.seq !== undefined) seedCtx.seq = ctx.seq;
    if (ctx.eventIndex !== undefined) seedCtx.eventIndex = ctx.eventIndex;
    let sfx: ResolvedSfx | null = null;
    let voices: ResolvedVoice[] = [];
    let sceneKey: string | null = null;
    let token: number | null = null;
    try {
      const cue = sfxCueFor(e, q);
      // timed：handler 在演出的指定时刻经 ctx.audio.cue 自己放（playCue），事件开始时不放
      sfx =
        cue && !cue.timed
          ? resolveSfxCue(cue, this.maps.sfxSets, voiceSeed(e, seedCtx), {
              guessOriginal: this.opts.guessOriginal,
              flicSfx: this.opts.flicSfx,
            })
          : null;
      if (sfx) this.engine.playSfx(sfx.key, { bus: sfx.bus });
      voices = voiceFor(e, q, this.maps.voiceMap, seedCtx, { allowGuess: this.opts.allowGuessVoice });
      // timed：handler 在演出的指定时刻经 ctx.audio.voices 说（speakTimed），事件开始时只记下
      const later = voices.filter((v) => v.timed === true);
      if (later.length > 0) this.timedVoices.set(e, later);
      for (const v of voices) if (v.timed !== true) this.speakOne(v);
      const sc = sceneCueFor(e, q);
      sceneKey = sc ? musicKeyFor(sc.scene, this.maps.musicMap) : null;
      if (sc && sceneKey !== null) {
        const t = this.engine.pushScene(sceneKey, { noResume: sc.noResume === true });
        if (sc.span === 'event') token = t;
        else this.held.push({ token: t, until: new Set(sc.span.until) });
      }
    } catch (err) {
      // 声音永远不能打断演出
      if (typeof console !== 'undefined') console.warn('[audio] event', e.type, err);
    }
    let ended = false;
    return {
      sfx,
      voices,
      scene: sceneKey,
      end: () => {
        if (ended) return;
        ended = true;
        this.timedVoices.delete(e);
        if (token !== null) this.engine.popScene(token);
      },
    };
  }

  private speakOne(v: ResolvedVoice): void {
    const r: VoiceRequest = { key: v.key, speaker: v.speaker, policy: v.policy };
    if (v.maxWaitMs !== undefined) r.maxWaitMs = v.maxWaitMs;
    void this.engine.speak(r);
  }

  /**
   * 说出事件 e 在开始时选好的 timed 台词（ctx.audio.voices 的实现；每个事件只说一次）：出卡、被动卡的卡片台词由
   * handler 在亮卡结束后调用（原版 fcn.00440bac 停完 1.5 秒才说台词）。返回说出的台词；没有（未登记、已说过、
   * 事件已结束）时为空
   */
  speakTimed(e: GameEvent): ResolvedVoice[] {
    const list = this.timedVoices.get(e);
    if (!list) return [];
    this.timedVoices.delete(e);
    try {
      for (const v of list) this.speakOne(v);
    } catch (err) {
      // 声音永远不能打断演出
      if (typeof console !== 'undefined') console.warn('[audio] timed voice', e.type, err);
    }
    return list;
  }

  /** 等待按演出时刻说出的台词所属的事件数（测试与调试用） */
  get pendingTimedVoices(): number {
    return this.timedVoices.size;
  }

  /** 演出被重置（reset / skipAll / 离开对局）：收起事件场景曲、停掉语音（包括还没到时刻的 timed 台词） */
  reset(): void {
    for (const h of this.held.splice(0)) this.engine.popScene(h.token);
    this.timedVoices.clear();
    this.engine.stopVoice();
  }

  /** 用导演层包住事件 handler：进入时放声音，结束（含中止）时收起事件场景曲 */
  wrapHandlers(handlers: HandlerMap): HandlerMap {
    const out: Record<string, AnyHandler> = {};
    for (const type of Object.keys(handlers) as GameEventType[]) {
      const h = handlers[type] as unknown as AnyHandler;
      out[type] = async (e, ctx) => {
        const a = this.onEvent(e, audioCtxOf(ctx));
        try {
          await h(e, ctx);
        } finally {
          a.end();
        }
      };
    }
    return out as unknown as HandlerMap;
  }

  /**
   * 放一个事件音效提示（ctx.audio.cue 的实现）：与事件开始时同一套解析（cue 音效集、置信度、ZzFX 回退），
   * 由 handler 在演出的指定时刻调用（soundMap 里标 timed 的提示，例如掷骰的两声「咚」）
   */
  playCue(c: SfxCue): ResolvedSfx | null {
    let r: ResolvedSfx | null = null;
    try {
      r = resolveSfxCue({ ...c, timed: false }, this.maps.sfxSets, 0, { guessOriginal: this.opts.guessOriginal });
      if (r) this.engine.playSfx(r.key, { bus: r.bus });
    } catch (err) {
      // 声音永远不能打断演出
      if (typeof console !== 'undefined') console.warn('[audio] cue', c.cue ?? c.zzfx, err);
    }
    return r;
  }

  // ───────────────────────── 界面音 ─────────────────────────

  uiCue(name: UiCue): ResolvedSfx | null {
    const r = resolveSfxCue(UI_CUES[name], this.maps.sfxSets, 0, { guessOriginal: this.opts.guessOriginal });
    if (r) this.engine.playSfx(r.key, { bus: r.bus });
    return r;
  }

  /** 预载几个界面音（例如倒计时出现时预载提示音，第一声不因首次合成超时而作废） */
  preloadUiCues(names: readonly UiCue[]): Promise<void> {
    const keys: string[] = [];
    for (const n of names) {
      const r = resolveSfxCue(UI_CUES[n], this.maps.sfxSets, 0, { guessOriginal: this.opts.guessOriginal });
      if (r) keys.push(r.key);
    }
    return this.engine.preload(keys);
  }
}

/** PresentationContext → 音频上下文：事件位置取 ctx.at（EventPlayer 给出）；测试替身没有时回退到事件内容哈希 */
export function audioCtxOf(ctx: PresentationContext): AudioEventCtx {
  const out: AudioEventCtx = { view: () => ctx.view(), map: ctx.map };
  const at = ctx.at;
  if (at) {
    out.epoch = at.epoch;
    out.seq = at.seq;
    out.eventIndex = at.eventIndex;
  }
  return out;
}
