// client-browser：真实 WebGL 下，建筑生成器给 DOM 对话框出预览图（加盖对话框「当前 → 下一级」）
import { describe, expect, it } from 'vitest';
import { previewSpec } from './BuildingPreview';
import { buildingPreviewImage } from './buildingPreviewImage';

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('image load failed'));
    img.src = src;
  });
}

describe('buildingPreviewImage', () => {
  it('住宅 1 级与 5 级都能出图，5 级更高；同参数命中缓存', async () => {
    const lv1 = await buildingPreviewImage(previewSpec({ t: 'house' }, 1, 0));
    const lv5 = await buildingPreviewImage(previewSpec({ t: 'house' }, 5, 0));
    expect(lv1.startsWith('data:image/png')).toBe(true);
    expect(lv5.startsWith('data:image/png')).toBe(true);
    const [a, b] = await Promise.all([loadImage(lv1), loadImage(lv5)]);
    expect(a.naturalWidth).toBeGreaterThan(0);
    expect(b.naturalHeight).toBeGreaterThan(a.naturalHeight);
    const again = buildingPreviewImage(previewSpec({ t: 'house' }, 1, 0));
    expect(await again).toBe(lv1);
  });

  it('设施（旅馆 3 级、0 级空地）', async () => {
    const hotel = await buildingPreviewImage(previewSpec({ t: 'facility', type: 'hotel' }, 3, 2));
    const vacant = await buildingPreviewImage(previewSpec({ t: 'facility', type: null }, 0, null));
    expect(hotel).not.toBe(vacant);
    expect((await loadImage(hotel)).naturalWidth).toBeGreaterThan(0);
  });
});
