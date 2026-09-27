// 图集里的帧（或帧内的子矩形）→ 独立位图 URL（blob:）。CSS 的平铺（background-repeat / border-image-repeat: round）
// 只能作用在整张图上，不能取图集的子矩形；十字花纹这类要平铺的框，先用 canvas 把要平铺的那一块抽出来。
// 图集位图与页面同源（/pack/…，门禁 cookie 随请求带上），canvas 不会被污染。抽出的 URL 按块缓存到页面关闭；
// 同一图集页只加载一次。
import { useEffect, useState } from 'react';
import type { SpriteFrame } from '../assets';
import type { Rect } from '../layout';

const cache = new Map<string, Promise<string | null>>();
const pages = new Map<string, Promise<HTMLImageElement>>();
const LOAD_TIMEOUT_MS = 15_000;

/** 当前环境能不能抽帧（需要真正加载位图的浏览器；jsdom 不加载图片） */
export function canExtractFrames(): boolean {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return false;
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false;
  return !(typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent));
}

function loadPage(url: string): Promise<HTMLImageElement> {
  let p = pages.get(url);
  if (!p) {
    p = new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      const timer = setTimeout(() => reject(new Error(`加载超时：${url}`)), LOAD_TIMEOUT_MS);
      img.onload = () => {
        clearTimeout(timer);
        resolve(img);
      };
      img.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`加载失败：${url}`));
      };
      img.decoding = 'async';
      img.src = url;
    });
    p.catch(() => pages.delete(url));
    pages.set(url, p);
  }
  return p;
}

async function extract(f: SpriteFrame, r: Rect): Promise<string | null> {
  const img = await loadPage(f.url);
  const c = document.createElement('canvas');
  c.width = r.w;
  c.height = r.h;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, f.x + r.x, f.y + r.y, r.w, r.h, 0, 0, r.w, r.h);
  const blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, 'image/png'));
  c.width = 0;
  c.height = 0;
  return blob ? URL.createObjectURL(blob) : null;
}

function keyOf(f: SpriteFrame, r: Rect): string {
  return `${f.url}#${f.x + r.x},${f.y + r.y},${r.w},${r.h}`;
}

/** 抽出一帧（或帧内子矩形 sub，帧坐标）的独立位图 URL（失败或环境不支持为 null） */
export function frameObjectUrl(f: SpriteFrame, sub?: Rect): Promise<string | null> {
  if (!canExtractFrames()) return Promise.resolve(null);
  const r = sub ?? { x: 0, y: 0, w: f.w, h: f.h };
  if (r.w <= 0 || r.h <= 0) return Promise.resolve(null);
  const key = keyOf(f, r);
  let p = cache.get(key);
  if (!p) {
    p = extract(f, r).catch((e: unknown) => {
      console.warn('[classic] 抽帧失败，框改用拉伸画法', e);
      cache.delete(key);
      return null;
    });
    cache.set(key, p);
  }
  return p;
}

/**
 * 钩子：enabled 时把帧内的几块子矩形各抽成独立位图；全部完成前为 null，完成后按顺序给出 URL（单块失败为 null）。
 */
export function useFrameParts(
  f: SpriteFrame | null,
  rects: readonly Rect[],
  enabled: boolean,
): (string | null)[] | null {
  const key = f && enabled ? rects.map((r) => keyOf(f, r)).join('|') : '';
  const [state, setState] = useState<{ key: string; urls: (string | null)[] } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 抽哪几块由 key 唯一确定
  useEffect(() => {
    if (!key || !f) return;
    let live = true;
    void Promise.all(rects.map((r) => frameObjectUrl(f, r))).then((urls) => {
      if (live) setState({ key, urls });
    });
    return () => {
      live = false;
    };
  }, [key]);
  return state && state.key === key ? state.urls : null;
}
