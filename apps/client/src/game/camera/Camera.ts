// 镜头（design/client.md §3.8）：跟随、平移、缩放、惯性、HUD insets、fitAll、手动拖动后暂停跟随。
// 只依赖一个「可变换目标」接口（Pixi Container 天然满足），数学部分可在 node 下单测。
// 约定：center 是 world 容器本地坐标中镜头对准的点；它显示在「有效可视区」（视口扣除 insets）的中心。
// 缩放上下限参数化（original-skin.md §3 修正 7）：程序化棋盘沿用 MIN_ZOOM / MAX_ZOOM 且允许 fitAll 临时放宽下限；
// 原版棋盘（A6）按源像素倍数设 1–3×，可关闭放宽。
import type { AnimClock } from '../anim/AnimClock';
import { cubicInOut, type Ease } from '../anim/easing';
import { tweenValue } from '../anim/tween';
import type { Pt } from '../iso/projection';

export interface Transformable {
  position: { x: number; y: number; set(x: number, y?: number): void };
  scale: { x: number; y: number; set(x: number, y?: number): void };
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface WorldRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MIN_ZOOM = 0.4;
export const MAX_ZOOM = 1.8;
export const DEFAULT_FOLLOW_LERP = 0.12;
export const USER_PAUSE_MS = 4000;
/** 惯性：速度（屏幕 px/ms）每毫秒保留的比例；低于阈值停止 */
export const INERTIA_DECAY_PER_MS = 0.994;
export const INERTIA_STOP = 0.01;
const FRAME_MS = 1000 / 60;

export interface CameraOptions {
  /** 缩放下限（缺省 MIN_ZOOM） */
  minZoom?: number;
  /** 缩放上限（缺省 MAX_ZOOM） */
  maxZoom?: number;
  /** 大地图 fitAll / setBounds 时允许把下限临时放宽到恰好容纳全图（缺省 true） */
  relaxMinToFit?: boolean;
}

export class Camera {
  private cx = 0;
  private cy = 0;
  private z = 1;
  private vw: number;
  private vh: number;
  private insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  private bounds: WorldRect | null = null;
  private followTarget: (() => Pt) | null = null;
  private followLerp = DEFAULT_FOLLOW_LERP;
  private time = 0;
  private pausedUntil = -1;
  private vx = 0;
  private vy = 0;
  private shakeAmp = 0;
  private shakeMs = 0;
  private shakeLeft = 0;
  private shakeOffset: Pt = { x: 0, y: 0 };
  private animating = 0;
  /** dispose 之后（棋盘已销毁）：仍在共享动画时钟上的镜头补间不再写 target */
  private disposed = false;
  /** 配置的缩放下限 */
  private baseMin: number;
  private maxZ: number;
  private readonly relax: boolean;
  /** 实际最小缩放：通常为 baseMin，大地图 fitAll 时会临时放宽到恰好容纳全图（relaxMinToFit） */
  private minZoomDyn: number;

  constructor(
    private readonly target: Transformable,
    viewport: { w: number; h: number },
    private readonly clock: AnimClock | null = null,
    opts: CameraOptions = {},
  ) {
    this.vw = viewport.w;
    this.vh = viewport.h;
    this.baseMin = opts.minZoom ?? MIN_ZOOM;
    this.maxZ = Math.max(this.baseMin, opts.maxZoom ?? MAX_ZOOM);
    this.relax = opts.relaxMinToFit ?? true;
    this.minZoomDyn = this.baseMin;
    this.apply();
  }

  // ───────── 状态读取 ─────────

  get zoom(): number {
    return this.z;
  }

  get minZoom(): number {
    return this.minZoomDyn;
  }

  get maxZoom(): number {
    return this.maxZ;
  }

  /** 改缩放上下限（当前缩放随之夹紧） */
  setZoomLimits(min: number, max: number): void {
    this.baseMin = Math.max(0.01, min);
    this.maxZ = Math.max(this.baseMin, max);
    this.refreshMinZoom();
    this.z = this.clampZoom(this.z);
    this.clampCenter();
    this.apply();
  }

  get center(): Pt {
    return { x: this.cx, y: this.cy };
  }

  get isFollowing(): boolean {
    return this.followTarget !== null;
  }

  /** 跟随是否因用户手势暂停中 */
  get followPaused(): boolean {
    return this.time < this.pausedUntil;
  }

  get velocity(): Pt {
    return { x: this.vx, y: this.vy };
  }

  /** 有效可视区（屏幕坐标）：视口扣除 HUD 遮挡 */
  effectiveViewport(): { x: number; y: number; w: number; h: number } {
    const w = Math.max(1, this.vw - this.insets.left - this.insets.right);
    const h = Math.max(1, this.vh - this.insets.top - this.insets.bottom);
    return { x: this.insets.left, y: this.insets.top, w, h };
  }

  /** 有效可视区中心（屏幕坐标） */
  screenAnchor(): Pt {
    const e = this.effectiveViewport();
    return { x: e.x + e.w / 2, y: e.y + e.h / 2 };
  }

  worldToScreen(p: Pt): Pt {
    const a = this.screenAnchor();
    return { x: a.x + (p.x - this.cx) * this.z, y: a.y + (p.y - this.cy) * this.z };
  }

  screenToWorld(p: Pt): Pt {
    const a = this.screenAnchor();
    return { x: this.cx + (p.x - a.x) / this.z, y: this.cy + (p.y - a.y) / this.z };
  }

  // ───────── 配置 ─────────

  setViewport(w: number, h: number): void {
    this.vw = Math.max(1, w);
    this.vh = Math.max(1, h);
    this.refreshMinZoom();
    this.clampCenter();
    this.apply();
  }

  setInsets(i: Partial<Insets>): void {
    this.insets = { ...this.insets, ...i };
    this.refreshMinZoom();
    this.apply();
  }

  setBounds(r: WorldRect | null): void {
    this.bounds = r;
    this.refreshMinZoom();
    this.clampCenter();
    this.apply();
  }

  private refreshMinZoom(): void {
    this.minZoomDyn = this.bounds && this.relax ? Math.min(this.baseMin, this.fitZoomFor(this.bounds)) : this.baseMin;
    if (this.z < this.minZoomDyn) this.z = this.minZoomDyn;
  }

  // ───────── 立即操作 ─────────

  lookAt(p: Pt): void {
    this.cx = p.x;
    this.cy = p.y;
    this.clampCenter();
    this.apply();
  }

  /** 设缩放，保持屏幕上的 anchor 点（缺省为有效可视区中心）不动 */
  setZoom(z: number, anchorScreen?: Pt): void {
    const nz = this.clampZoom(z);
    if (anchorScreen) {
      const before = this.screenToWorld(anchorScreen);
      this.z = nz;
      const after = this.screenToWorld(anchorScreen);
      this.cx += before.x - after.x;
      this.cy += before.y - after.y;
    } else {
      this.z = nz;
    }
    this.clampCenter();
    this.apply();
  }

  zoomBy(factor: number, anchorScreen?: Pt): void {
    this.setZoom(this.z * factor, anchorScreen);
  }

  /** 按屏幕像素平移（用户拖动）；会暂停跟随 */
  panBy(dxScreen: number, dyScreen: number): void {
    this.cx -= dxScreen / this.z;
    this.cy -= dyScreen / this.z;
    this.clampCenter();
    this.apply();
    this.onUserGesture();
  }

  /** 松手甩动：速度单位为屏幕 px/ms */
  fling(vxScreen: number, vyScreen: number): void {
    this.vx = vxScreen;
    this.vy = vyScreen;
    this.onUserGesture();
  }

  stopInertia(): void {
    this.vx = 0;
    this.vy = 0;
  }

  /** 手动拖动 / 缩放后暂停跟随 4 秒 */
  onUserGesture(): void {
    this.pausedUntil = this.time + USER_PAUSE_MS;
  }

  follow(target: (() => Pt) | null, lerpPerFrame = DEFAULT_FOLLOW_LERP): void {
    this.followTarget = target;
    this.followLerp = Math.min(1, Math.max(0.001, lerpPerFrame));
  }

  shake(amp: number, ms: number): void {
    this.shakeAmp = Math.max(this.shakeAmp, amp);
    this.shakeMs = Math.max(1, ms);
    this.shakeLeft = this.shakeMs;
  }

  // ───────── 动画操作（由 AnimClock 驱动，支持倍速与中止） ─────────

  panTo(p: Pt, ms: number, signal?: AbortSignal, ease: Ease = cubicInOut): Promise<void> {
    const from = this.center;
    return this.animate(ms, signal, ease, (t) => {
      this.cx = from.x + (p.x - from.x) * t;
      this.cy = from.y + (p.y - from.y) * t;
      this.clampCenter();
    });
  }

  zoomTo(z: number, ms: number, anchorScreen?: Pt, signal?: AbortSignal): Promise<void> {
    const from = this.z;
    const to = this.clampZoom(z);
    return this.animate(ms, signal, cubicInOut, (t) => this.setZoomRaw(from + (to - from) * t, anchorScreen));
  }

  /** 缩放并居中，使 rect（缺省为 bounds）完整落在有效可视区内（留 6% 边距） */
  fitAll(ms = 0, rect?: WorldRect, signal?: AbortSignal): Promise<void> {
    const r = rect ?? this.bounds;
    if (!r) return Promise.resolve();
    const z = this.fitZoomFor(r);
    if (this.relax) this.minZoomDyn = Math.min(this.minZoomDyn, z);
    const center = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    if (ms <= 0 || !this.clock) {
      this.z = this.clampZoom(z);
      this.lookAt(center);
      return Promise.resolve();
    }
    const fromC = this.center;
    const fromZ = this.z;
    const toZ = this.clampZoom(z);
    return this.animate(ms, signal, cubicInOut, (t) => {
      this.z = fromZ + (toZ - fromZ) * t;
      this.cx = fromC.x + (center.x - fromC.x) * t;
      this.cy = fromC.y + (center.y - fromC.y) * t;
    });
  }

  fitZoomFor(r: WorldRect): number {
    const e = this.effectiveViewport();
    const margin = 0.94;
    return Math.max(0.01, Math.min((e.w * margin) / Math.max(1, r.w), (e.h * margin) / Math.max(1, r.h)));
  }

  // ───────── 每帧 ─────────

  update(dtMs: number): void {
    if (!(dtMs > 0)) return;
    this.time += dtMs;

    // 惯性
    if (this.vx !== 0 || this.vy !== 0) {
      this.cx -= (this.vx * dtMs) / this.z;
      this.cy -= (this.vy * dtMs) / this.z;
      const k = INERTIA_DECAY_PER_MS ** dtMs;
      this.vx *= k;
      this.vy *= k;
      if (Math.hypot(this.vx, this.vy) < INERTIA_STOP) this.stopInertia();
      this.clampCenter();
    }

    // 跟随（与帧率无关：1-(1-l)^(dt/16.7)）；用户手势后暂停；动画中不抢镜头
    if (this.followTarget && !this.followPaused && this.animating === 0) {
      const p = this.followTarget();
      const a = 1 - (1 - this.followLerp) ** (dtMs / FRAME_MS);
      this.cx += (p.x - this.cx) * a;
      this.cy += (p.y - this.cy) * a;
      this.clampCenter();
    }

    // 震屏：振幅线性衰减，方向按时间做确定性摆动
    if (this.shakeLeft > 0) {
      this.shakeLeft = Math.max(0, this.shakeLeft - dtMs);
      const amp = this.shakeAmp * (this.shakeLeft / this.shakeMs);
      this.shakeOffset = { x: Math.sin(this.time * 0.09) * amp, y: Math.cos(this.time * 0.113) * amp };
      if (this.shakeLeft === 0) {
        this.shakeAmp = 0;
        this.shakeOffset = { x: 0, y: 0 };
      }
    }
    this.apply();
  }

  // ───────── 内部 ─────────

  /** 棋盘销毁时调用：之后的 apply 与补间都不再写 target（共享时钟上的补间会在到点后自然结束） */
  dispose(): void {
    this.disposed = true;
    this.followTarget = null;
  }

  private animate(ms: number, signal: AbortSignal | undefined, ease: Ease, step: (t: number) => void): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (!this.clock || ms <= 0) {
      step(1);
      this.apply();
      return Promise.resolve();
    }
    this.animating++;
    return tweenValue(
      0,
      1,
      ms,
      (v) => {
        step(v);
        this.apply();
      },
      { clock: this.clock, ease, signal },
    ).finally(() => {
      this.animating--;
    });
  }

  private setZoomRaw(z: number, anchorScreen?: Pt): void {
    if (anchorScreen) {
      const before = this.screenToWorld(anchorScreen);
      this.z = z;
      const after = this.screenToWorld(anchorScreen);
      this.cx += before.x - after.x;
      this.cy += before.y - after.y;
    } else {
      this.z = z;
    }
    this.clampCenter();
  }

  private clampZoom(z: number): number {
    return Math.min(this.maxZoom, Math.max(this.minZoomDyn, z));
  }

  /** 镜头中心限制在 bounds 内（不让棋盘被拖出视野） */
  private clampCenter(): void {
    if (!this.bounds) return;
    const b = this.bounds;
    this.cx = Math.min(b.x + b.w, Math.max(b.x, this.cx));
    this.cy = Math.min(b.y + b.h, Math.max(b.y, this.cy));
  }

  private apply(): void {
    if (this.disposed) return;
    const a = this.screenAnchor();
    this.target.scale.set(this.z, this.z);
    this.target.position.set(a.x - this.cx * this.z + this.shakeOffset.x, a.y - this.cy * this.z + this.shakeOffset.y);
  }
}
