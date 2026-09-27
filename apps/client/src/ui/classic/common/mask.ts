// 命中掩膜（design-draft §4.3）：8 位灰度 PNG，每像素一个区号（0 = 无）。经 canvas getImageData 读出 R 通道即区号
// （灰度 PNG 没有 gAMA/iCCP，浏览器按 sRGB 原样解码，R = G = B = 灰度值）。素材包里的掩膜由 classic/assets 的
// ensureClassicMask 加载进 useClassicAssets 仓库；这里给出不依赖仓库的解码函数（浏览器测试直接用）与读取钩子。
import { useEffect } from 'react';
import { ensureClassicMask, type MaskAsset, maskRegion, useClassicAssets } from '../assets';

export { type MaskAsset, maskRegion };

/** 位图 → 区号表（需要 2D canvas；不可用时返回 null，调用方按矩形命中） */
export function maskFromImage(img: CanvasImageSource, w: number, h: number): MaskAsset | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const data = new Uint8Array(w * h);
  for (let i = 0; i < data.length; i++) data[i] = rgba[i * 4]!;
  c.width = 0;
  c.height = 0;
  return { w, h, data };
}

/** 由区号表直接构造（测试、合成） */
export function maskFromRegions(w: number, h: number, fill: (x: number, y: number) => number): MaskAsset {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = fill(x, y) & 0xff;
  return { w, h, data };
}

/** 读取素材包里的掩膜（首次使用时开始加载；加载中或不可用为 null） */
export function useSceneMask(key: string | null | undefined): MaskAsset | null {
  const mask = useClassicAssets((s) => (key ? (s.masks[key] ?? null) : null));
  useEffect(() => {
    if (key) ensureClassicMask(key);
  }, [key]);
  return mask;
}
