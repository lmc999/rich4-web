// 音乐调度（design-draft §3.7；audio_video.md §3.1、§5）：
// - 棋盘曲：<audio> + MediaElementSource 流式播放（3 分钟立体声解码后约 60 MB，不能整段解码），按 (idx+1) % n 轮播，
//   一曲放完接下一首，不循环（原版 fcn.004533f0）；
// - 场景曲：单曲循环；缺省解码成 AudioBuffer 用 loopStart/loopEnd 无缝循环，过长或解码失败时退回 <audio loop>；
// - 场景栈：场景盖住棋盘曲时把棋盘曲的续播点压栈，离开后从中断处续播（原版 0x47c5fb）；
//   noResume（原版参数 bit15：开局设定、结算、节日）表示不记录续播点，回到棋盘时从下一首的开头播；
//   场景盖住场景时记下被盖者的位置，揭开后从原处续播；弹出非栈顶的层不产生可闻变化。
// 引擎未解锁或页面在后台时只维护逻辑状态，恢复时按当前栈顶重新开始（棋盘曲从暂停处续播）。
import type { AudioClipInfo } from './types';
import type {
  AudioBufferLike,
  AudioContextLike,
  AudioNodeLike,
  BufferSourceLike,
  GainNodeLike,
  MediaElementLike,
} from './webaudio';

export type SceneMode = 'buffer' | 'element' | 'auto';

export interface MusicDeps {
  ctx: AudioContextLike;
  /** bgm 总线（压低节点之前） */
  out: AudioNodeLike;
  createElement(): MediaElementLike;
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  /** 逻辑键 → 流式播放用的 URL（已按格式偏好选好） */
  resolveUrl(key: string): string | null;
  info(key: string): AudioClipInfo | null;
  /** 场景曲解码（音乐专用缓存） */
  loadBuffer(key: string): Promise<AudioBufferLike | null>;
  /** 引擎是否处于可出声状态（已解锁且在前台） */
  canPlay(): boolean;
  log(op: string, key?: string, atSec?: number, detail?: string): void;
}

export interface MusicOptions {
  fadeMs: number;
  sceneMode: SceneMode;
  /** auto 模式下，循环长度不超过它的场景曲用 AudioBuffer（其余走 <audio>） */
  sceneBufferMaxMs: number;
}

export const DEFAULT_MUSIC_OPTIONS: Readonly<MusicOptions> = Object.freeze({
  fadeMs: 250,
  sceneMode: 'auto',
  sceneBufferMaxMs: 90_000,
});

export interface ScenePushOptions {
  /** 原版 bit15：不记录棋盘曲续播点（回到棋盘时从下一首开头播） */
  noResume?: boolean;
  /** 覆盖素材包里的循环区间 */
  loop?: { startMs: number; endMs: number } | null;
}

interface Layer {
  token: number;
  key: string;
  noResume: boolean;
  loop: { startMs: number; endMs: number } | null | undefined;
  /** 被盖住时记下的位置（秒） */
  pos: number | null;
}

interface SceneHandle {
  readonly key: string;
  readonly mode: 'buffer' | 'element' | 'pending';
  position(): number;
  stop(fadeMs: number): void;
}

type Output = { kind: 'board'; idx: number; key: string } | { kind: 'scene'; layer: Layer; handle: SceneHandle };

export interface MusicSnapshot {
  mode: 'idle' | 'board' | 'scene';
  key: string | null;
  positionSec: number | null;
  boardIdx: number;
  layers: string[];
  boardResume: { idx: number; time: number } | null;
}

function fadeTo(ctx: AudioContextLike, g: GainNodeLike, target: number, ms: number): void {
  const now = ctx.currentTime;
  const p = g.gain;
  const cur = p.value;
  p.cancelScheduledValues(now);
  p.setValueAtTime(cur, now);
  if (ms <= 0) p.setValueAtTime(target, now);
  else p.linearRampToValueAtTime(target, now + ms / 1000);
}

function wrapLoop(t: number, start: number, end: number): number {
  if (end <= start || t < end) return t;
  return start + ((t - start) % (end - start));
}

export class MusicPlayer {
  private readonly opts: MusicOptions;
  private boardKeys: string[] = [];
  private boardIdx = -1;
  private startIdx = 0;
  private boardActive = false;
  private boardResume: { idx: number; time: number } | null = null;
  private boardAdvance = false;
  private readonly layers: Layer[] = [];
  private nextToken = 1;
  private output: Output | null = null;
  private boardEl: MediaElementLike | null = null;
  /** 最近一次赋给棋盘元素的 URL（el.src 读回的是绝对地址，不能直接比较） */
  private boardUrl: string | null = null;
  private boardGain: GainNodeLike | null = null;
  private boardPauseTimer: unknown = null;
  private sceneEl: MediaElementLike | null = null;
  private sceneUrl: string | null = null;
  private sceneElGain: GainNodeLike | null = null;
  private sceneWatch: unknown = null;
  private disposed = false;
  /** batch() 期间推迟 apply，避免中间状态出声 */
  private batching = 0;

  constructor(
    private readonly deps: MusicDeps,
    opts?: Partial<MusicOptions>,
  ) {
    this.opts = { ...DEFAULT_MUSIC_OPTIONS, ...opts };
  }

  // ───────────────────────── 公开接口 ─────────────────────────

  /** 棋盘轮播曲（music-map.board）；startIdx 为首次播放的下标 */
  setBoardPlaylist(keys: readonly string[], startIdx = 0): void {
    const same = keys.length === this.boardKeys.length && keys.every((k, i) => k === this.boardKeys[i]);
    if (same) return;
    this.boardKeys = [...keys];
    this.startIdx = keys.length > 0 ? ((startIdx % keys.length) + keys.length) % keys.length : 0;
    this.boardIdx = -1;
    this.boardResume = null;
    this.boardAdvance = false;
    if (this.output?.kind === 'board') this.stopOutput('switch');
    this.apply();
  }

  /** 棋盘曲是否应当播放（对局画面内） */
  setBoardActive(on: boolean): void {
    if (this.boardActive === on) return;
    this.boardActive = on;
    this.apply();
  }

  /** 进入场景：返回令牌，离开时 pop(令牌) */
  push(key: string, o: ScenePushOptions = {}): number {
    const layer: Layer = { token: this.nextToken++, key, noResume: o.noResume === true, loop: o.loop, pos: null };
    this.layers.push(layer);
    this.deps.log('scene.push', key, undefined, layer.noResume ? 'noResume' : undefined);
    this.apply();
    return layer.token;
  }

  pop(token: number): void {
    const i = this.layers.findIndex((l) => l.token === token);
    if (i < 0) return;
    const [layer] = this.layers.splice(i, 1);
    this.deps.log('scene.pop', layer!.key);
    this.apply();
  }

  /** 一次调整多层（例如把节日层插到场所层下面）：期间不切歌，结束后按最终栈顶切换一次 */
  batch(fn: () => void): void {
    this.batching++;
    try {
      fn();
    } finally {
      this.batching--;
      if (this.batching === 0) this.apply();
    }
  }

  /** 清空全部场景层（回到棋盘曲或静音） */
  clearScenes(): void {
    if (this.layers.length === 0) return;
    this.layers.splice(0);
    this.apply();
  }

  /** 页面进入后台 / 引擎挂起：暂停并记下位置（恢复时 resumeAll） */
  pauseAll(): void {
    if (this.output) this.stopOutput('pause', 0);
  }

  /** 解锁、回到前台、来源变化后按当前栈顶重新开始 */
  refresh(): void {
    this.apply();
  }

  /** 来源变了（换素材包）：在原位置用新 URL 重新开始当前曲目 */
  reload(): void {
    if (this.output) this.stopOutput('pause', 0);
    this.apply();
  }

  /**
   * iOS：在用户手势内对两个媒体元素各 play() 一次（尚未载入真实曲目的元素先挂静音 WAV），
   * 之后脱离手势的 play() 才不会被拒绝。
   */
  bless(silentUrl: string | null): void {
    if (this.disposed) return;
    const pairs: [MediaElementLike, () => string | null][] = [
      [this.ensureBoardEl(), () => this.boardUrl],
      [this.ensureSceneEl().el, () => this.sceneUrl],
    ];
    for (const [el, url] of pairs) {
      if (url() !== null) continue;
      if (silentUrl) el.src = silentUrl;
      try {
        el.play().then(
          () => {
            if (url() === null) el.pause();
          },
          () => {},
        );
      } catch {
        // 不支持
      }
    }
  }

  snapshot(): MusicSnapshot {
    const o = this.output;
    return {
      mode: o === null ? 'idle' : o.kind,
      key: o === null ? null : o.kind === 'board' ? o.key : o.layer.key,
      positionSec: o === null ? null : o.kind === 'board' ? (this.boardEl?.currentTime ?? 0) : o.handle.position(),
      boardIdx: this.boardIdx,
      layers: this.layers.map((l) => l.key),
      boardResume: this.boardResume ? { ...this.boardResume } : null,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.pauseAll();
    this.disposed = true;
    for (const el of [this.boardEl, this.sceneEl]) {
      if (!el) continue;
      el.pause();
      el.removeAttribute('src');
      el.load();
    }
    this.boardUrl = null;
    this.sceneUrl = null;
    this.clearTimers();
  }

  // ───────────────────────── 状态机 ─────────────────────────

  private desired(): { kind: 'scene'; layer: Layer } | { kind: 'board' } | null {
    const top = this.layers[this.layers.length - 1];
    if (top) return { kind: 'scene', layer: top };
    if (this.boardActive && this.boardKeys.length > 0) return { kind: 'board' };
    return null;
  }

  private apply(): void {
    if (this.disposed || this.batching > 0) return;
    const want = this.desired();
    const cur = this.output;
    if (!this.deps.canPlay()) {
      // 不能出声：只保证没有东西在响（位置已由 pauseAll 记下）
      if (cur) this.stopOutput('pause', 0);
      return;
    }
    if (want === null) {
      if (cur) this.stopOutput('switch');
      return;
    }
    if (want.kind === 'board') {
      if (cur?.kind === 'board') return;
      if (cur) this.stopOutput('switch');
      this.startBoard();
      return;
    }
    // 场景
    if (cur?.kind === 'scene' && cur.layer === want.layer) return;
    if (cur?.kind === 'scene' && cur.layer.key === want.layer.key) {
      // 同一首场景曲换了一层（例如 UI 与事件同时要求拍卖曲）：不重播，只把输出挂到新层
      this.output = { kind: 'scene', layer: want.layer, handle: cur.handle };
      return;
    }
    if (cur) this.stopOutput(cur.kind === 'board' ? 'cover' : this.layers.includes(cur.layer) ? 'cover' : 'switch');
    this.startScene(want.layer);
  }

  private stopOutput(reason: 'cover' | 'switch' | 'pause', fadeMs = this.opts.fadeMs): void {
    const cur = this.output;
    if (!cur) return;
    this.output = null;
    if (cur.kind === 'board') {
      const el = this.boardEl;
      const time = el ? el.currentTime : 0;
      if (reason === 'cover') {
        const top = this.layers[this.layers.length - 1];
        if (top?.noResume) {
          this.boardResume = null;
          this.boardAdvance = true;
        } else {
          this.boardResume = { idx: cur.idx, time };
          this.boardAdvance = false;
        }
      } else if (reason === 'pause') {
        this.boardResume = { idx: cur.idx, time };
      }
      this.deps.log('board.stop', cur.key, time, reason);
      if (this.boardGain) fadeTo(this.deps.ctx, this.boardGain, 0, fadeMs);
      this.schedulePauseBoard(fadeMs);
      return;
    }
    const pos = cur.handle.position();
    if (reason === 'cover' || reason === 'pause') cur.layer.pos = pos;
    this.deps.log('scene.stop', cur.layer.key, pos, reason);
    cur.handle.stop(fadeMs);
  }

  private schedulePauseBoard(fadeMs: number): void {
    if (this.boardPauseTimer !== null) this.deps.clearTimeout(this.boardPauseTimer);
    const pause = (): void => {
      this.boardPauseTimer = null;
      if (this.output?.kind === 'board') return; // 淡出期间又回到了棋盘曲
      this.boardEl?.pause();
    };
    if (fadeMs <= 0) pause();
    else this.boardPauseTimer = this.deps.setTimeout(pause, fadeMs + 20);
  }

  // ───────────────────────── 棋盘曲 ─────────────────────────

  private ensureBoardEl(): MediaElementLike {
    if (this.boardEl) return this.boardEl;
    const el = this.deps.createElement();
    el.preload = 'auto';
    el.loop = false;
    const g = this.deps.ctx.createGain();
    g.gain.value = 0;
    this.deps.ctx.createMediaElementSource(el).connect(g);
    g.connect(this.deps.out);
    el.addEventListener('ended', () => this.onBoardEnded());
    this.boardEl = el;
    this.boardGain = g;
    return el;
  }

  private onBoardEnded(): void {
    const cur = this.output;
    if (cur?.kind !== 'board' || this.boardKeys.length === 0) return;
    this.output = null;
    this.boardIdx = (cur.idx + 1) % this.boardKeys.length;
    this.boardResume = null;
    this.deps.log('board.next', this.boardKeys[this.boardIdx]);
    this.startBoardAt(this.boardIdx, 0, false);
  }

  private startBoard(): void {
    const n = this.boardKeys.length;
    let idx = this.boardIdx < 0 ? this.startIdx : this.boardIdx;
    let time: number | null = 0;
    let resumed = false;
    if (this.boardAdvance && this.boardIdx >= 0) {
      idx = (this.boardIdx + 1) % n;
      this.boardAdvance = false;
      this.boardResume = null;
    } else if (this.boardResume && this.boardResume.idx === idx) {
      time = this.boardResume.time;
      this.boardResume = null;
      resumed = true;
    } else {
      this.boardAdvance = false;
      this.boardResume = null;
      time = this.boardIdx === idx ? null : 0; // 同一首且无续播点：沿用元素当前位置
    }
    this.boardIdx = idx;
    this.startBoardAt(idx, time, resumed);
  }

  private startBoardAt(idx: number, time: number | null, resumed: boolean): void {
    const key = this.boardKeys[idx]!;
    const url = this.deps.resolveUrl(key);
    if (url === null) {
      this.deps.log('board.missing', key);
      return;
    }
    const el = this.ensureBoardEl();
    if (this.boardPauseTimer !== null) {
      this.deps.clearTimeout(this.boardPauseTimer);
      this.boardPauseTimer = null;
    }
    if (this.boardUrl !== url) {
      el.src = url;
      this.boardUrl = url;
      if (time === null) time = 0;
    }
    if (time !== null) seek(el, time);
    this.output = { kind: 'board', idx, key };
    this.deps.log(resumed ? 'board.resume' : 'board.start', key, time ?? el.currentTime);
    playSafely(el, (e) => this.deps.log('board.playError', key, undefined, e));
    if (this.boardGain) fadeTo(this.deps.ctx, this.boardGain, 1, this.opts.fadeMs);
  }

  // ───────────────────────── 场景曲 ─────────────────────────

  private loopOf(layer: Layer): { startMs: number; endMs: number } | null {
    if (layer.loop !== undefined) return layer.loop;
    return this.deps.info(layer.key)?.loop ?? null;
  }

  private prefersBuffer(layer: Layer): boolean {
    if (this.opts.sceneMode === 'buffer') return true;
    if (this.opts.sceneMode === 'element') return false;
    const loop = this.loopOf(layer);
    const dur = this.deps.info(layer.key)?.durationMs ?? null;
    const len = loop ? loop.endMs : dur;
    return len !== null && len <= this.opts.sceneBufferMaxMs;
  }

  private startScene(layer: Layer): void {
    const loop = this.loopOf(layer);
    const loopStart = loop ? loop.startMs / 1000 : 0;
    const at = layer.pos ?? loopStart;
    const resumed = layer.pos !== null;
    layer.pos = null;
    this.deps.log(resumed ? 'scene.resume' : 'scene.start', layer.key, at);
    const handle = this.prefersBuffer(layer) ? this.bufferScene(layer, at, loop) : this.elementScene(layer, at, loop);
    this.output = { kind: 'scene', layer, handle };
  }

  private bufferScene(layer: Layer, at: number, loop: { startMs: number; endMs: number } | null): SceneHandle {
    const ctx = this.deps.ctx;
    let src: BufferSourceLike | null = null;
    let gain: GainNodeLike | null = null;
    let startCtx = 0;
    let loopS = 0;
    let loopE = 0;
    let stopped = false;
    let fallback: SceneHandle | null = null;
    const handle: SceneHandle = {
      key: layer.key,
      get mode() {
        return fallback ? fallback.mode : src ? 'buffer' : 'pending';
      },
      position: () => {
        if (fallback) return fallback.position();
        if (!src) return at;
        return wrapLoop(ctx.currentTime - startCtx + at, loopS, loopE);
      },
      stop: (fadeMs) => {
        stopped = true;
        if (fallback) {
          fallback.stop(fadeMs);
          return;
        }
        if (src && gain) {
          const s = src;
          fadeTo(ctx, gain, 0, fadeMs);
          try {
            s.stop(ctx.currentTime + fadeMs / 1000 + 0.02);
          } catch {
            // 已停止
          }
        }
      },
    };
    void this.deps.loadBuffer(layer.key).then((buf) => {
      if (stopped || this.disposed || this.output?.kind !== 'scene' || this.output.handle !== handle) return;
      if (!buf) {
        this.deps.log('scene.decodeFallback', layer.key);
        fallback = this.elementScene(layer, at, loop);
        return;
      }
      loopS = loop ? Math.min(loop.startMs / 1000, buf.duration) : 0;
      loopE = loop ? Math.min(loop.endMs / 1000, buf.duration) : buf.duration;
      if (loopE <= loopS) {
        loopS = 0;
        loopE = buf.duration;
      }
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      s.loopStart = loopS;
      s.loopEnd = loopE;
      const g = ctx.createGain();
      g.gain.value = 0;
      s.connect(g);
      g.connect(this.deps.out);
      startCtx = ctx.currentTime;
      s.start(0, Math.min(at, Math.max(0, loopE - 0.001)));
      fadeTo(ctx, g, 1, this.opts.fadeMs);
      src = s;
      gain = g;
    });
    return handle;
  }

  private ensureSceneEl(): { el: MediaElementLike; gain: GainNodeLike } {
    if (this.sceneEl && this.sceneElGain) return { el: this.sceneEl, gain: this.sceneElGain };
    const el = this.deps.createElement();
    el.preload = 'auto';
    const g = this.deps.ctx.createGain();
    g.gain.value = 0;
    this.deps.ctx.createMediaElementSource(el).connect(g);
    g.connect(this.deps.out);
    this.sceneEl = el;
    this.sceneElGain = g;
    return { el, gain: g };
  }

  private elementScene(layer: Layer, at: number, loop: { startMs: number; endMs: number } | null): SceneHandle {
    const url = this.deps.resolveUrl(layer.key);
    const { el, gain } = this.ensureSceneEl();
    let stopped = false;
    // 先声明：url 缺失时提前返回的句柄也可能被 stop（此前 stop 访问尚未初始化的 const 抛 ReferenceError）
    let onEnded: (() => void) | null = null;
    const handle: SceneHandle = {
      key: layer.key,
      mode: 'element',
      position: () => el.currentTime,
      stop: (fadeMs) => {
        if (stopped) return;
        stopped = true;
        this.stopWatch();
        if (onEnded) el.removeEventListener('ended', onEnded);
        fadeTo(this.deps.ctx, gain, 0, fadeMs);
        const pause = (): void => {
          if (this.output?.kind === 'scene' && this.output.handle.mode === 'element' && this.output.handle !== handle) {
            return; // 元素已被下一首场景曲接管
          }
          el.pause();
        };
        if (fadeMs <= 0) pause();
        else this.deps.setTimeout(pause, fadeMs + 20);
      },
    };
    if (url === null) {
      this.deps.log('scene.missing', layer.key);
      return handle;
    }
    const loopS = loop ? loop.startMs / 1000 : 0;
    const loopE = loop ? loop.endMs / 1000 : Number.POSITIVE_INFINITY;
    // 循环区间覆盖整个文件（素材包已按首尾静音裁剪）时直接用原生 loop；否则手动跳回
    const dur = this.deps.info(layer.key)?.durationMs ?? null;
    const partial = loop !== null && (loop.startMs > 0 || (dur !== null && loop.endMs < dur - 50));
    onEnded = (): void => {
      if (stopped) return;
      seek(el, loopS);
      playSafely(el, () => {});
    };
    this.stopWatch();
    if (this.sceneUrl !== url) {
      el.src = url;
      this.sceneUrl = url;
    }
    el.loop = loop !== null && !partial;
    el.addEventListener('ended', onEnded);
    seek(el, at);
    playSafely(el, (e) => this.deps.log('scene.playError', layer.key, undefined, e));
    fadeTo(this.deps.ctx, gain, 1, this.opts.fadeMs);
    if (partial) {
      const tick = (): void => {
        if (stopped) return;
        if (el.currentTime >= loopE) seek(el, loopS + (el.currentTime - loopE));
        this.sceneWatch = this.deps.setTimeout(tick, 40);
      };
      this.sceneWatch = this.deps.setTimeout(tick, 40);
    }
    return handle;
  }

  private stopWatch(): void {
    if (this.sceneWatch !== null) {
      this.deps.clearTimeout(this.sceneWatch);
      this.sceneWatch = null;
    }
  }

  private clearTimers(): void {
    this.stopWatch();
    if (this.boardPauseTimer !== null) {
      this.deps.clearTimeout(this.boardPauseTimer);
      this.boardPauseTimer = null;
    }
  }
}

/** 设置播放位置；元数据未就绪时等 loadedmetadata 再设一次 */
function seek(el: MediaElementLike, t: number): void {
  try {
    el.currentTime = t;
  } catch {
    // 元数据未就绪
  }
  if (Math.abs(el.currentTime - t) > 0.05) {
    const once = (): void => {
      el.removeEventListener('loadedmetadata', once);
      try {
        el.currentTime = t;
      } catch {
        // 忽略
      }
    };
    el.addEventListener('loadedmetadata', once);
  }
}

function playSafely(el: MediaElementLike, onError: (msg: string) => void): void {
  try {
    el.play().catch((e: unknown) => onError(e instanceof Error ? e.name : String(e)));
  } catch (e) {
    onError(e instanceof Error ? e.name : String(e));
  }
}
