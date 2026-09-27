import { ExtractError } from '../context';

/** 图像/音频资源解码失败（结构不自洽、越界、未知块类型等）；code 形如 E_SPR_*、E_FLC_*。 */
export class GfxError extends ExtractError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'GfxError';
  }
}

/** 解码得到的 RGBA 图（8 位，非预乘；完全透明的像素一律为 0,0,0,0）。 */
export interface RgbaImage {
  w: number;
  h: number;
  rgba: Uint8Array;
}

/** 带锚点的帧：落点 = 画点 − (ax, ay)（exe fcn.00455293）。 */
export interface AnchoredImage extends RgbaImage {
  ax: number;
  ay: number;
}

/** 8 位索引图 + 调色板（RGB，每项 3 字节）。 */
export interface IndexedImage {
  w: number;
  h: number;
  pixels: Uint8Array;
  /** 256×3 字节 RGB */
  palette: Uint8Array;
}
