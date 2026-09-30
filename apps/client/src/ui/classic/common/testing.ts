// 原版场景公共组件的测试工具（文件名含 testing，check-deps 视为测试代码）：假精灵表与假素材包客户端。
import type { AssetEntry, AtlasV1 } from '@rich4/shared/assets';
import type { PackClient } from '../../../skin/pack/PackClient';
import { type MaskAsset, resetClassicAssetsForTest, type SpriteFrame, type SpriteSheet } from '../assets';
import { resetSceneAssetsForTest } from './sceneAssets';

/** [w, h, ax, ay] */
export type FakeFrame = readonly [number, number, number, number];

/** 假精灵表：每帧按给定尺寸与锚点横排在一张图集页上 */
export function fakeSheet(key: string, frames: readonly FakeFrame[]): SpriteSheet {
  let x = 0;
  const sheetW = frames.reduce((a, f) => a + f[0], 0);
  const sheetH = frames.reduce((a, f) => Math.max(a, f[1]), 0);
  const out: SpriteFrame[] = frames.map(([w, h, ax, ay]) => {
    const f: SpriteFrame = { url: `/pack/${key}.png`, x, y: 0, w, h, ax, ay, sheetW, sheetH };
    x += w;
    return f;
  });
  return { key, frames: out };
}

const rep = (n: number, f: FakeFrame): FakeFrame[] => Array.from({ length: n }, () => f);

/** 与原版包同尺寸同锚点的假精灵表（YES/NO、共享 UI、计算器、讲话头像） */
export function fakeSceneSheets(characters: readonly number[] = [9]): Record<string, SpriteSheet> {
  const common: FakeFrame[] = [
    [139, 116, 0, 0],
    [139, 116, 0, 116],
    [139, 116, 139, 0],
    [139, 116, 139, 116],
    [355, 83, 0, 0],
    [195, 133, 97, 81],
    [210, 154, 98, 69],
    [400, 89, 0, 0],
    ...rep(10, [35, 43, 16, 19]),
    ...rep(4, [25, 26, 0, 0]),
    ...rep(8, [5, 5, 2, 2]),
  ];
  const numpad: FakeFrame[] = [
    [128, 192, 0, 0],
    [108, 12, 0, 0],
    [49, 25, 0, 0],
    [57, 25, 0, 0],
    ...rep(12, [33, 17, 0, 0]),
    ...rep(10, [9, 19, 0, 0]),
  ];
  const out: Record<string, SpriteSheet> = {
    'ui.yesno': fakeSheet('ui.yesno', rep(3, [96, 48, 0, 0])),
    'ui.common': fakeSheet('ui.common', common),
    'ui.numpad': fakeSheet('ui.numpad', numpad),
  };
  for (const c of characters) {
    out[`portrait.speaker.${c}`] = fakeSheet(`portrait.speaker.${c}`, [
      [73, 72, 37, 35],
      ...rep(4, [34, 34, 17, 17]),
      [25, 24, 12, 12],
      [10, 9, 5, 4],
    ]);
  }
  return out;
}

/** 假素材包客户端：usable 里的键可用（按键名推断类型：*.mask 为掩膜，其余为精灵），其余返回 null */
export function fakePackClient(usable: Iterable<string>): PackClient & { asked: string[] } {
  const set = new Set(usable);
  const asked: string[] = [];
  const client = {
    asked,
    usableEntry(key: string): AssetEntry | null {
      asked.push(key);
      if (!set.has(key)) return null;
      if (key.endsWith('.mask')) {
        return {
          type: 'mask',
          group: 'ui.dialog',
          confidence: 'visual',
          src: [],
          file: `${key}.png`,
          w: 1,
          h: 1,
          regions: 1,
        } as unknown as AssetEntry;
      }
      return {
        type: 'sprite',
        group: 'ui.dialog',
        confidence: 'visual',
        src: [],
        atlas: [],
        frames: { base: key, start: 0, count: 1 },
        dirs: 1,
        frameMs: null,
        transparency: 'rgb0',
        ownerMask: false,
        anchor: 'frame',
      } as unknown as AssetEntry;
    },
  };
  return client as unknown as PackClient & { asked: string[] };
}

/** 假素材包里的整图条目（逻辑路径与尺寸） */
export interface FakeImage {
  file: string;
  w: number;
  h: number;
}

/** 与原版包同一逻辑路径的 30 张卡片插画：card.<k> → images/data/<529+k>.png（165×256） */
export function fakeCardImages(): Record<string, FakeImage> {
  const out: Record<string, FakeImage> = {};
  for (let k = 1; k <= 30; k++) out[`card.${k}`] = { file: `images/data/${529 + k}.png`, w: 165, h: 256 };
  return out;
}

/**
 * 带图集的假素材包客户端：sheets 里的键是可用的精灵条目（帧横排在各自的一页图集上），loadAtlas / atlasImageUrl 照常可用，
 * 经典外壳与场景的按需加载都走真实代码路径；gate 给出时 loadAtlas 等它（测试「准备中」与超时）；images 里的键是整图条目
 * （不透明，fileUrl = /pack/<逻辑路径>）。其他键不可用。
 */
export function atlasPackClient(
  sheets: Readonly<Record<string, readonly FakeFrame[]>>,
  o: { gate?: Promise<void>; images?: Readonly<Record<string, FakeImage>> } = {},
): PackClient & { loads: string[] } {
  const loads: string[] = [];
  const atlasOf = (key: string): AtlasV1 => {
    const frames: Record<string, unknown> = {};
    const anchorsPx: Record<string, [number, number]> = {};
    let x = 0;
    let h = 1;
    for (const [i, [w, fh, ax, ay]] of (sheets[key] ?? []).entries()) {
      const name = `${key}/${i}`;
      frames[name] = {
        frame: { x, y: 0, w, h: fh },
        rotated: false,
        trimmed: false,
        spriteSourceSize: { x: 0, y: 0, w, h: fh },
        sourceSize: { w, h: fh },
        anchor: { x: ax / w, y: ay / fh },
      };
      anchorsPx[name] = [ax, ay];
      x += w;
      h = Math.max(h, fh);
    }
    return {
      schema: 'rich4.atlas/1',
      frames,
      meta: {
        app: 'test',
        version: '1',
        image: `${key}.png`,
        format: 'RGBA8888',
        size: { w: Math.max(1, x), h },
        scale: '1',
        r4: { anchorsPx, mask: null, transparency: 'rgb0', src: ['synthetic'] },
      },
    } as unknown as AtlasV1;
  };
  const client = {
    loads,
    usableEntry(key: string): AssetEntry | null {
      const img = o.images && Object.hasOwn(o.images, key) ? o.images[key] : undefined;
      if (img) {
        return {
          type: 'image',
          group: key.startsWith('card.') ? 'card' : 'illustration.news',
          confidence: key.startsWith('card.') ? 'exe' : 'visual',
          src: ['synthetic'],
          file: img.file,
          w: img.w,
          h: img.h,
          transparency: 'opaque',
          anchor: null,
        } as unknown as AssetEntry;
      }
      const frames = Object.hasOwn(sheets, key) ? sheets[key] : undefined;
      if (!frames) return null;
      return {
        type: 'sprite',
        group: 'ui.dialog',
        confidence: 'visual',
        src: ['synthetic'],
        atlas: [`${key}.json`],
        frames: { base: key, start: 0, count: frames.length },
        dirs: 1,
        frameMs: null,
        transparency: 'rgb0',
        ownerMask: false,
        anchor: 'frame',
      } as unknown as AssetEntry;
    },
    async loadAtlas(lp: string): Promise<AtlasV1> {
      loads.push(lp);
      if (o.gate) await o.gate;
      return atlasOf(lp.replace(/\.json$/, ''));
    },
    atlasImageUrl(lp: string): string {
      return `/pack/${lp.replace(/\.json$/, '')}.png`;
    },
    fileUrl(lp: string): string {
      return `/pack/${lp}`;
    },
    loadImage(): Promise<never> {
      return Promise.reject(new Error('测试客户端不解码位图'));
    },
    releaseImage(): void {},
  };
  return client as unknown as PackClient & { loads: string[] };
}

/** 与原版包同尺寸同锚点的假帧表（atlasPackClient 用） */
export function fakeSceneFrames(characters: readonly number[] = [9]): Record<string, FakeFrame[]> {
  const out: Record<string, FakeFrame[]> = {};
  for (const [key, sheet] of Object.entries(fakeSceneSheets(characters))) {
    out[key] = sheet.frames.map((f) => [f!.w, f!.h, f!.ax, f!.ay] as const);
  }
  return out;
}

/** 装好素材仓库：packId + 精灵表 + 掩膜 */
export function installSceneAssets(
  o: {
    packId?: string | null;
    sprites?: Record<string, SpriteSheet | null>;
    masks?: Record<string, MaskAsset | null>;
  } = {},
): void {
  resetSceneAssetsForTest();
  resetClassicAssetsForTest({
    packId: o.packId === undefined ? 'test-pack' : o.packId,
    sprites: o.sprites ?? {},
    masks: o.masks ?? {},
  });
}
