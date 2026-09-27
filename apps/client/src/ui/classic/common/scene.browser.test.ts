// client-browser：原版场景公共组件在真实浏览器里的两条 canvas 路径——
// 1) 命中掩膜：现场编码的 8 位灰度 PNG（与素材包同格式）经 createImageBitmap + canvas getImageData 逐像素还原区号；
//    Hotspots 放进按 2.5 倍 CSS 缩放的容器里，按屏幕坐标点击（浏览器自己做命中测试），重叠的包围盒以掩膜为准；
// 2) 九宫格平铺：从图集页抽出单帧位图（blob:），NineSlice 改用 border-image（border-image-repeat: round）。
// 图形全是现场画的色块（不含任何原版像素）。
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { initI18n } from '../../../i18n';
import { resetClassicAssetsForTest, type SpriteFrame } from '../assets';
import { frameObjectUrl } from './frameImage';
import { Hotspots } from './Hotspots';
import { maskFromImage } from './mask';
import { NineSlice } from './NineSlice';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeAll(() => {
  initI18n('original');
});

afterEach(() => {
  root?.unmount();
  root = null;
  host?.remove();
  host = null;
  resetClassicAssetsForTest();
});

// ───────────────────────── 8 位灰度 PNG 编码（测试用） ─────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function zlib(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function grayPng(w: number, h: number, gray: Uint8Array): Promise<Blob> {
  const raw = new Uint8Array((w + 1) * h);
  for (let y = 0; y < h; y++) raw.set(gray.subarray(y * w, y * w + w), y * (w + 1) + 1);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8; // 位深
  ihdr[9] = 0; // 灰度
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', await zlib(raw)), chunk('IEND', new Uint8Array(0))];
  return new Blob(parts as BlobPart[], { type: 'image/png' });
}

// 40×24：区 3 是左边的 L 形（包围盒 0..23 × 0..23），区 7 是右上块（包围盒 16..39 × 0..9），区 200 是右下角的小块
const W = 40;
const H = 24;
function regionAt(x: number, y: number): number {
  if (x < 8 || (y >= 16 && x < 24)) return 3;
  if (x >= 16 && y < 10) return 7;
  if (x >= 34 && y >= 18) return 200;
  return 0;
}
const REGIONS = (() => {
  const g = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g[y * W + x] = regionAt(x, y);
  return g;
})();

function mount(el: ReturnType<typeof createElement>): HTMLDivElement {
  host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:20px;top:30px;width:400px;height:300px';
  document.body.appendChild(host);
  root = createRoot(host);
  root.render(el);
  return host;
}

async function frames(n = 2): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(() => r(null)));
}

describe('命中掩膜（canvas getImageData）', () => {
  it('8 位灰度 PNG → 区号表逐像素一致（含 >127 的区号）', async () => {
    const bmp = await createImageBitmap(await grayPng(W, H, REGIONS));
    const mask = maskFromImage(bmp, W, H)!;
    expect(mask).not.toBeNull();
    expect([mask.w, mask.h]).toEqual([W, H]);
    expect(Array.from(mask.data)).toEqual(Array.from(REGIONS));
  });

  it('Hotspots 在 2.5 倍缩放的场景里：按屏幕坐标命中，重叠的包围盒以掩膜为准，空白不触发', async () => {
    const mask = maskFromImage(await createImageBitmap(await grayPng(W, H, REGIONS)), W, H)!;
    const hits: string[] = [];
    const el = mount(
      createElement(
        'div',
        { style: { position: 'absolute', left: 0, top: 0, transform: 'scale(2.5)', transformOrigin: '0 0' } },
        createElement(Hotspots, {
          x: 10,
          y: 20,
          w: W,
          h: H,
          mask,
          testId: 'hs',
          onActivate: (id: string) => hits.push(id),
          spots: [
            { id: 'L', rect: { x: 0, y: 0, w: 24, h: 24 }, region: 3, label: 'L', testId: 'hs-L' },
            { id: 'R', rect: { x: 16, y: 0, w: 24, h: 10 }, region: 7, label: 'R', testId: 'hs-R' },
            { id: 'S', rect: { x: 34, y: 18, w: 6, h: 6 }, region: 200, label: 'S', testId: 'hs-S' },
          ],
        }),
      ),
    );
    await frames();
    const group = el.querySelector<HTMLElement>('[data-testid="hs"]')!;
    const box = group.getBoundingClientRect();
    expect(box.width).toBeCloseTo(W * 2.5, 3);
    // 场景坐标 (x, y) 的中心 → 屏幕坐标；由浏览器找出那一点最上层的元素，再在它上面派发点击
    const clickAt = (x: number, y: number): void => {
      const cx = box.left + (x + 0.5) * 2.5;
      const cy = box.top + (y + 0.5) * 2.5;
      const target = document.elementFromPoint(cx, cy);
      expect(target, `(${x},${y})`).not.toBeNull();
      target!.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: cx, clientY: cy, detail: 1 }));
    };
    clickAt(18, 4); // R 块，L 的包围盒内（R 按钮在上层）
    clickAt(20, 20); // L 形下边
    clickAt(12, 12); // 两个包围盒里的空白：不触发
    clickAt(2, 2); // L 形左边
    clickAt(36, 20); // 小块（区号 200）
    expect(hits).toEqual(['R', 'L', 'L', 'S']);
    // 真实指针点击（Playwright 在 R 钮上偏左下的位置点，落在 L 形之外、R 块之内）
    await userEvent.click(el.querySelector<HTMLElement>('[data-testid="hs-R"]')!, { position: { x: 50, y: 10 } });
    expect(hits.at(-1)).toBe('R');
  });
});

describe('九宫格平铺（十字花纹：分块抽图 + background-repeat: round）', () => {
  it('从图集页抽出帧内子矩形；平铺框的边单向、中间双向 round 平铺，角原样', async () => {
    // 图集页 64×32：左边 32×32 是别的帧（红），右边 32×32 是框（外圈 8px 蓝边、中间白底绿十字）
    const c = new OffscreenCanvas(64, 32);
    const g = c.getContext('2d')!;
    g.fillStyle = '#f00';
    g.fillRect(0, 0, 32, 32);
    g.fillStyle = '#00f';
    g.fillRect(32, 0, 32, 32);
    g.fillStyle = '#fff';
    g.fillRect(40, 8, 16, 16);
    g.fillStyle = '#0f0';
    g.fillRect(46, 8, 4, 16);
    g.fillRect(40, 14, 16, 4);
    const url = URL.createObjectURL(await c.convertToBlob({ type: 'image/png' }));
    const f: SpriteFrame = { url, x: 32, y: 0, w: 32, h: 32, ax: 0, ay: 0, sheetW: 64, sheetH: 32 };
    const pixel = async (u: string, x: number, y: number): Promise<number[]> => {
      const img = await createImageBitmap(await (await fetch(u)).blob());
      const probe = new OffscreenCanvas(img.width, img.height).getContext('2d')!;
      probe.drawImage(img, 0, 0);
      return Array.from(probe.getImageData(x, y, 1, 1).data);
    };
    const whole = await frameObjectUrl(f);
    expect(whole).toMatch(/^blob:/);
    expect(await pixel(whole!, 1, 1)).toEqual([0, 0, 255, 255]);
    expect(await pixel(whole!, 15, 15)).toEqual([0, 255, 0, 255]);
    const center = await frameObjectUrl(f, { x: 8, y: 8, w: 16, h: 16 });
    expect(await pixel(center!, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(await pixel(center!, 7, 7)).toEqual([0, 255, 0, 255]);

    resetClassicAssetsForTest({
      packId: 'p',
      sprites: { 'test.cross': { key: 'test.cross', frames: [f] } },
    });
    const el = mount(
      createElement(NineSlice, {
        spec: {
          sheet: 'test.cross',
          frame: 0,
          w: 32,
          h: 32,
          slice: { top: 8, right: 8, bottom: 8, left: 8 },
          repeat: 'round',
          mode: 'nine',
          source: 'test',
        },
        x: 0,
        y: 0,
        w: 100,
        h: 60,
        testId: 'nine',
      }),
    );
    let nine: HTMLElement | null = null;
    for (let i = 0; i < 200 && nine?.getAttribute('data-slice') !== 'tiles'; i++) {
      await frames(1);
      nine = el.querySelector<HTMLElement>('[data-testid="nine"]');
    }
    if (!nine) throw new Error(`没有渲染出九宫格：${el.innerHTML.slice(0, 200)}`);
    expect(nine).toHaveAttribute('data-slice', 'tiles');
    const rep = (name: string): string =>
      getComputedStyle(nine.querySelector(`[data-part="${name}"]`)!).backgroundRepeat;
    expect(rep('mc')).toBe('round');
    expect(rep('tc')).toBe('round no-repeat');
    expect(rep('ml')).toBe('no-repeat round');
    expect(rep('tl')).toBe('no-repeat');
    expect(getComputedStyle(nine.querySelector('[data-part="mc"]')!).backgroundImage).toContain('blob:');
    expect(nine.getBoundingClientRect().width).toBe(100);
  });
});
