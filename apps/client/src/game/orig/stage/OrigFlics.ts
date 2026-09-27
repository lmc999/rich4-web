// 原版舞台的 FLIC（original-skin.md §5 A8；design-draft §3.5「摆放方式」；audio_video.md flic-map）：
// - 用途 → 条目：素材包 flic-map（data.flic-map）按用途找 FLIC 条目（flicsForUse），没有映射表时按「条目键 = 用途」；
//   条目缺失、所属组失败或置信度 guess 时不可用（调用方走 FxSystem 回退）；
// - 播放：skin/flic 的 FlicPlayer 逐帧解码到画布，画布作 Pixi 纹理挂在棋盘 overlay 层（世界坐标，随镜头缩放），
//   按 playFit 规则在可用时长内播完（原速 → 加速 ≤2× → trim → 均匀跳帧）；中止时落到终态并立即移除；
// - 摆放（flic-map placement）：board = 原版 440×440 棋盘视窗，视窗中心 (220,220) 对准锚点；screen = 原版 640×480 画面
//   坐标 (x, y)，棋盘视窗中心在 (220,260)；actor = 以锚点为中心；fullscreen = 640×480 画面按视窗中心对准锚点；
// - 播放中旋转视角：节点按锚点的世界坐标登记（pin），渲染器换视角时重新投影；
// - 首帧呈现时回调 onStart（调用方经 ctx.audio 放 flic-map 的同步音效，原版 0x452a83）；
// - 解析后的 FLC 按条目缓存（少量 LRU），prefetch 在事件开始时预取，加载时间从可用时长里扣除。
import {
  type AssetEntry,
  DATA_KEYS,
  type FlicEntry,
  type FlicInfo,
  type FlicMapV1,
  type FlicPlacement,
  flicsForUse,
  safeParseFlicMap,
} from '@rich4/shared/assets';
import { CanvasSource, type Container, Sprite, Texture } from 'pixi.js';
import type { FlcFile } from '../../../skin/flic/FlcDecoder';
import { CanvasFrameSink, type FlicFrameSink, FlicPlayer } from '../../../skin/flic/FlicPlayer';
import { type FitPlan, planFit } from '../../../skin/flic/fit';
import type { AnimClock } from '../../anim/AnimClock';
import type { Pt } from '../../iso/projection';

/** 原版棋盘视窗中心（视窗左上角为原点） */
export const BOARD_VIEW_CENTER: Readonly<Pt> = Object.freeze({ x: 220, y: 220 });
/** 原版 640×480 画面里的棋盘视窗中心 */
export const SCREEN_VIEW_CENTER: Readonly<Pt> = Object.freeze({ x: 220, y: 260 });

/** FLIC 用到的素材包能力（PackClient 满足） */
export interface FlicPackSource {
  usableEntry(key: string, opts?: { allowGuess?: boolean }): AssetEntry | null;
  loadFlic?(key: string, signal?: AbortSignal): Promise<{ entry: FlicEntry; flc: FlcFile }>;
  loadData?(key: string, signal?: AbortSignal): Promise<unknown>;
}

/** 一段可用的原版 FLIC */
export interface FlicRef {
  key: string;
  entry: FlicEntry;
  /** flic-map 里的描述（没有映射表时为 null） */
  info: FlicInfo | null;
  placement: FlicPlacement;
}

export type FlicOutcome = 'played' | 'skipped' | 'unavailable';

export interface FlicPlayOptions {
  /** 锚点（棋盘坐标） */
  at: Pt;
  /** 可用时长（1x ms，已扣除 handler 里 FLIC 之外的等待） */
  availMs: number;
  signal: AbortSignal;
  /** 首帧呈现时（同步音效） */
  onStart?(ref: FlicRef): void;
  /** 播放进度 0..1（按计划帧） */
  onProgress?(v: number): void;
}

/** 原版舞台的 FLIC 端口（OrigStage 只依赖它；测试可换替身） */
export interface OrigFlicPort {
  resolve(use: string): FlicRef | null;
  prefetch(use: string): void;
  play(use: string, o: FlicPlayOptions): Promise<FlicOutcome>;
  /** 素材包里有这个音频条目（FLIC 的同步音效；没有时舞台改放提示的回退音） */
  soundAvailable(key: string): boolean;
}

export interface OrigFlicsOptions {
  pack: FlicPackSource;
  clock: AnimClock;
  /** 登记演出节点（FxSystem.track：clear() 时销毁，外部 signal 中止时一并中止） */
  track(node: Container, outer?: AbortSignal): { signal: AbortSignal; done: () => void };
  /** 精灵是否平滑（非整数倍缩放） */
  smoothing?(): boolean;
  /**
   * 按锚点登记演出节点（at 为锚点的棋盘坐标）：换视角时渲染器按锚点的世界坐标重新投影节点位置；返回注销函数。
   * 缺省不登记（节点留在开播时的棋盘坐标上）
   */
  pin?(node: Container, at: Pt): () => void;
  /** 解析后 FLC 的缓存条数 */
  cacheSize?: number;
}

/** 条目的缺省摆放：440×440 为棋盘视窗，其余以锚点为中心 */
export function defaultPlacement(e: Pick<FlicEntry, 'w' | 'h'>): FlicPlacement {
  return e.w === 440 && e.h === 440 ? { kind: 'board' } : { kind: 'actor' };
}

/** FLIC 左上角的棋盘坐标（整数源像素） */
export function flicTopLeft(p: FlicPlacement, at: Pt, w: number, h: number): Pt {
  let x: number;
  let y: number;
  switch (p.kind) {
    case 'board':
      x = at.x - BOARD_VIEW_CENTER.x;
      y = at.y - BOARD_VIEW_CENTER.y;
      break;
    case 'screen':
      x = at.x + p.x - SCREEN_VIEW_CENTER.x;
      y = at.y + p.y - SCREEN_VIEW_CENTER.y;
      break;
    case 'fullscreen':
      x = at.x - SCREEN_VIEW_CENTER.x;
      y = at.y - SCREEN_VIEW_CENTER.y;
      break;
    default:
      x = at.x - w / 2;
      y = at.y - h / 2;
  }
  return { x: Math.round(x), y: Math.round(y) };
}

const NULL_SINK: FlicFrameSink = { present: () => {} };

/** 画布呈现目标；环境没有画布（node 单测）时返回 null（只按时间播放、不显示） */
function canvasSink(w: number, h: number): CanvasFrameSink | null {
  try {
    return new CanvasFrameSink(w, h);
  } catch {
    return null;
  }
}

export class OrigFlics implements OrigFlicPort {
  private map: FlicMapV1 | null = null;
  private readonly parsed = new Map<string, Promise<FlcFile>>();
  private readonly cacheSize: number;
  /** flic-map 载入完成（失败也 resolve：按条目键回退） */
  readonly ready: Promise<void>;

  constructor(private readonly o: OrigFlicsOptions) {
    this.cacheSize = o.cacheSize ?? 12;
    this.ready = this.loadMap();
  }

  private async loadMap(): Promise<void> {
    const load = this.o.pack.loadData?.bind(this.o.pack);
    if (!load || this.o.pack.usableEntry(DATA_KEYS.flicMap)?.type !== 'data') return;
    try {
      const r = safeParseFlicMap(await load(DATA_KEYS.flicMap));
      if (r.ok) this.map = r.value;
      else console.warn('[orig] flic-map 校验失败，按条目键取用 FLIC', r.issues.slice(0, 3));
    } catch (e) {
      console.warn('[orig] flic-map 载入失败，按条目键取用 FLIC', e);
    }
  }

  /** 已载入的 flic-map（测试与调试） */
  get flicMap(): FlicMapV1 | null {
    return this.map;
  }

  resolve(use: string): FlicRef | null {
    if (!this.o.pack.loadFlic) return null;
    const m = this.map;
    const keys = m ? flicsForUse(m, use) : [];
    for (const key of keys.length > 0 ? keys : [use]) {
      const e = this.o.pack.usableEntry(key);
      if (e?.type !== 'flic') continue;
      const info = m && Object.hasOwn(m.flics, key) ? m.flics[key]! : null;
      return { key, entry: e, info, placement: info?.placement ?? defaultPlacement(e) };
    }
    return null;
  }

  /** 解析后的 FLC（按条目缓存；共享的加载不带调用方的 signal，避免中止污染缓存） */
  private load(ref: FlicRef): Promise<FlcFile> {
    const hit = this.parsed.get(ref.key);
    if (hit) {
      this.parsed.delete(ref.key);
      this.parsed.set(ref.key, hit);
      return hit;
    }
    const loadFlic = this.o.pack.loadFlic;
    if (!loadFlic) return Promise.reject(new Error('素材包不支持 FLIC'));
    const p = loadFlic.call(this.o.pack, ref.key).then((r) => r.flc);
    this.parsed.set(ref.key, p);
    p.catch(() => {
      if (this.parsed.get(ref.key) === p) this.parsed.delete(ref.key);
    });
    while (this.parsed.size > this.cacheSize) {
      const oldest = this.parsed.keys().next().value;
      if (oldest === undefined) break;
      this.parsed.delete(oldest);
    }
    return p;
  }

  /** 按用途建一个独立的播放器（画布呈现；开局棋盘伞由 OrigActor 自己摆放与播放）；不可用为 null */
  async player(use: string, signal?: AbortSignal): Promise<FlicPlayer | null> {
    const ref = this.resolve(use);
    if (!ref) return null;
    try {
      const flc = signal ? await raceAbort(this.load(ref), signal) : await this.load(ref);
      return new FlicPlayer(flc, {
        clock: this.o.clock,
        opaque: ref.entry.transparency === 'opaque',
        label: ref.key,
      });
    } catch {
      return null;
    }
  }

  soundAvailable(key: string): boolean {
    return this.o.pack.usableEntry(key)?.type === 'audio';
  }

  prefetch(use: string): void {
    const ref = this.resolve(use);
    if (ref) void this.load(ref).catch(() => {});
  }

  async play(use: string, o: FlicPlayOptions): Promise<FlicOutcome> {
    const ref = this.resolve(use);
    if (!ref) return 'unavailable';
    const clock = this.o.clock;
    if (o.signal.aborted || clock.instant) return 'skipped';
    const t0 = clock.now();
    let flc: FlcFile;
    try {
      flc = await raceAbort(this.load(ref), o.signal);
    } catch (e) {
      if (o.signal.aborted) return 'skipped';
      console.warn(`[orig] FLIC ${ref.key} 载入失败，回退程序化特效`, e);
      return 'unavailable';
    }
    if (o.signal.aborted || clock.instant) return 'skipped';
    const avail = o.availMs - (clock.now() - t0);
    const sink = canvasSink(flc.width, flc.height);
    let tex: Texture | null = null;
    let track: { signal: AbortSignal; done: () => void } | null = null;
    let unpin: (() => void) | null = null;
    let player: FlicPlayer | null = null;
    try {
      let plan: FitPlan | null = null;
      player = new FlicPlayer(flc, {
        clock,
        sink: sink ?? NULL_SINK,
        opaque: ref.entry.transparency === 'opaque',
        label: ref.key,
        onFrame: (f) => {
          if (tex && !tex.destroyed) tex.source.update();
          const frames = plan?.frames;
          if (o.onProgress && frames && frames.length > 0) {
            const k = frames.indexOf(f);
            o.onProgress(frames.length <= 1 ? 1 : Math.max(0, k) / (frames.length - 1));
          }
        },
        onStart: () => o.onStart?.(ref),
      });
      plan = planFit(
        { frames: player.frames, frameMs: player.frameMs, trim: ref.info?.trim ?? null },
        Math.max(0, avail),
      );
      let signal = o.signal;
      if (sink) {
        tex = new Texture({ source: new CanvasSource({ resource: sink.canvas as HTMLCanvasElement }) });
        tex.source.scaleMode = this.o.smoothing?.() ? 'linear' : 'nearest';
        const spr = new Sprite(tex);
        spr.label = `flic:${ref.key}`;
        const w = ref.info?.w ?? ref.entry.w;
        const h = ref.info?.h ?? ref.entry.h;
        const tl = flicTopLeft(ref.placement, o.at, w, h);
        spr.position.set(tl.x, tl.y);
        if (flc.width > 0 && flc.height > 0) spr.scale.set(w / flc.width, h / flc.height);
        // 播放中旋转视角：跟着锚点的世界坐标重新定位
        unpin = this.o.pin?.(spr, o.at) ?? null;
        track = this.o.track(spr, o.signal);
        signal = track.signal;
      }
      await player.playPlan(plan, signal);
      return 'played';
    } finally {
      unpin?.();
      player?.destroy();
      track?.done();
      if (tex && !tex.destroyed) tex.destroy(true);
      // 画布由这里建的 sink 持有（交给播放器的 sink 不归它释放）
      sink?.release();
    }
  }

  /** 丢掉缓存（素材包切换、棋盘销毁） */
  clear(): void {
    this.parsed.clear();
  }
}

function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}
