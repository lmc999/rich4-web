// 指针手势（design/client.md §3.8）：单指/鼠标拖动 + 松手惯性、双指捏合缩放、滚轮以指针为锚缩放、双击回调、轻点回调。
// 画布需设 touch-action:none（这里自动设置）。拖动超过阈值才算拖动，否则松手时触发 onTap（用于拾取格子）。
import type { Pt } from '../iso/projection';
import type { Camera } from './Camera';

export interface GestureOptions {
  /** 轻点（未发生拖动）：屏幕坐标（相对画布左上角） */
  onTap?: (screen: Pt, e: PointerEvent) => void;
  /** 双击 / 双触：例如回到当前玩家 */
  onDoubleTap?: (screen: Pt) => void;
  /** 拖动判定阈值（CSS 像素） */
  dragThreshold?: number;
  /** 滚轮一格的缩放系数 */
  wheelFactor?: number;
}

interface PointerTrack {
  id: number;
  start: Pt;
  last: Pt;
}

const VELOCITY_WINDOW_MS = 100;

/** 挂载手势；返回解绑函数 */
export function attachGestures(el: HTMLElement, camera: Camera, o: GestureOptions = {}): () => void {
  const threshold = o.dragThreshold ?? 6;
  const wheelFactor = o.wheelFactor ?? 1.12;
  const pointers = new Map<number, PointerTrack>();
  let dragging = false;
  let pinchDist = 0;
  let samples: { t: number; x: number; y: number }[] = [];
  let lastTapAt = -1;
  let lastTapPos: Pt = { x: 0, y: 0 };

  const prevTouchAction = el.style.touchAction;
  el.style.touchAction = 'none';

  const local = (e: { clientX: number; clientY: number }): Pt => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const pinchInfo = (): { mid: Pt; dist: number } | null => {
    const ps = [...pointers.values()];
    if (ps.length < 2) return null;
    const a = ps[0]!.last;
    const b = ps[1]!.last;
    return { mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist: Math.hypot(a.x - b.x, a.y - b.y) };
  };

  const onDown = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const p = local(e);
    pointers.set(e.pointerId, { id: e.pointerId, start: p, last: p });
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // 合成事件没有活动指针，忽略
    }
    camera.stopInertia();
    samples = [{ t: e.timeStamp, x: p.x, y: p.y }];
    if (pointers.size === 2) {
      const info = pinchInfo();
      pinchDist = info?.dist ?? 0;
      dragging = true;
    }
  };

  const onMove = (e: PointerEvent): void => {
    const tr = pointers.get(e.pointerId);
    if (!tr) return;
    const p = local(e);
    const dx = p.x - tr.last.x;
    const dy = p.y - tr.last.y;
    if (pointers.size >= 2) {
      const before = pinchInfo();
      tr.last = p;
      const after = pinchInfo();
      if (before && after && pinchDist > 0) {
        camera.panBy(after.mid.x - before.mid.x, after.mid.y - before.mid.y);
        camera.setZoom(camera.zoom * (after.dist / pinchDist), after.mid);
        pinchDist = after.dist;
      }
      return;
    }
    tr.last = p;
    if (!dragging && Math.hypot(p.x - tr.start.x, p.y - tr.start.y) >= threshold) dragging = true;
    if (dragging) {
      camera.panBy(dx, dy);
      samples.push({ t: e.timeStamp, x: p.x, y: p.y });
      const cutoff = e.timeStamp - VELOCITY_WINDOW_MS;
      samples = samples.filter((s) => s.t >= cutoff);
    }
  };

  const onUp = (e: PointerEvent): void => {
    const tr = pointers.get(e.pointerId);
    if (!tr) return;
    pointers.delete(e.pointerId);
    try {
      el.releasePointerCapture(e.pointerId);
    } catch {
      // 忽略
    }
    if (pointers.size > 0) {
      // 捏合结束剩一根手指：重置它的起点，避免跳动
      for (const other of pointers.values()) other.start = other.last;
      pinchDist = 0;
      return;
    }
    const p = local(e);
    if (dragging) {
      const first = samples[0];
      const last = samples[samples.length - 1];
      if (first && last && last.t > first.t) {
        camera.fling((last.x - first.x) / (last.t - first.t), (last.y - first.y) / (last.t - first.t));
      }
    } else if (e.type === 'pointerup') {
      const now = e.timeStamp;
      if (lastTapAt >= 0 && now - lastTapAt < 320 && Math.hypot(p.x - lastTapPos.x, p.y - lastTapPos.y) < 24) {
        lastTapAt = -1;
        o.onDoubleTap?.(p);
      } else {
        lastTapAt = now;
        lastTapPos = p;
        o.onTap?.(p, e);
      }
    }
    dragging = false;
    samples = [];
  };

  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const p = local(e);
    // 触控板捏合（ctrlKey）用连续缩放，滚轮用固定档位
    const factor = e.ctrlKey ? Math.exp(-e.deltaY * 0.01) : e.deltaY < 0 ? wheelFactor : 1 / wheelFactor;
    camera.setZoom(camera.zoom * factor, p);
    camera.onUserGesture();
  };

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
  el.addEventListener('wheel', onWheel, { passive: false });

  return () => {
    el.removeEventListener('pointerdown', onDown);
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    el.removeEventListener('pointercancel', onUp);
    el.removeEventListener('wheel', onWheel);
    el.style.touchAction = prevTouchAction;
  };
}
