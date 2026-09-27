// 测试用（client-unit / client-browser）：合成的原版舞台 FLIC 素材。帧数与帧间隔取 shared/view/pacing 的时长参数
// （原长与原版一致，才能验证 original / compact 两种节奏下的 playFit），像素是现场编码的 8×8 色块（skin/flic/testing/flcBuilder），
// 摆放与音效键是自拟的（不取原版 flic-map 的数值）；条目键与用途键故意不同（flic.<用途>），验证 flic-map 的间接查找。
import {
  ASSET_SCHEMA,
  type AssetEntry,
  DATA_KEYS,
  type DataEntry,
  type FlicEntry,
  type FlicInfo,
  type FlicMapV1,
  type FlicPlacement,
} from '@rich4/shared/assets';
import type { GodKind } from '@rich4/shared/engine';
import { type FlicTiming, GOD_ARRIVAL_FLICS, ORIGINAL_FLICS, PARACHUTE_FLICS } from '@rich4/shared/view';
import { type FlcFile, parseFlc } from '../../../../skin/flic/FlcDecoder';
import { buildFlc, type SynthFrame } from '../../../../skin/flic/testing/flcBuilder';
import { godArrivalUse, parachuteUse } from '../flicPlan';

export interface FakeFlicSpec {
  key: string;
  use: string;
  timing: Pick<FlicTiming, 'frames' | 'frameMs'>;
  w: number;
  h: number;
  placement: FlicPlacement;
  sfx: string | null;
}

/** 自拟的摆放（只验证语义：棋盘视窗 / 画面坐标 / 角色旁） */
const PLACEMENT: Readonly<Record<string, { w: number; h: number; placement: FlicPlacement }>> = {
  [ORIGINAL_FLICS.ambulance.use]: { w: 440, h: 60, placement: { kind: 'screen', x: 0, y: 200 } },
  [ORIGINAL_FLICS.cardGain.use]: { w: 24, h: 32, placement: { kind: 'screen', x: 200, y: 170 } },
  [ORIGINAL_FLICS.pointsGain.use]: { w: 24, h: 32, placement: { kind: 'screen', x: 200, y: 170 } },
  [ORIGINAL_FLICS.godLeave.use]: { w: 96, h: 96, placement: { kind: 'actor' } },
};

/** 合成素材覆盖的全部用途：事件 FLIC、12 段神明降临、12 段棋盘伞 */
export function fakeFlicSpecs(): FakeFlicSpec[] {
  const out: FakeFlicSpec[] = [];
  let sfx = 900;
  const add = (use: string, timing: Pick<FlicTiming, 'frames' | 'frameMs'>, withSfx = true): void => {
    const p = PLACEMENT[use] ?? { w: 440, h: 440, placement: { kind: 'board' } as FlicPlacement };
    out.push({ key: `flic.${use}`, use, timing, ...p, sfx: withSfx ? `sfx.${sfx++}` : null });
  };
  for (const f of Object.values(ORIGINAL_FLICS)) {
    // 骰子、乐透摇奖机、魔法屋施法属于外壳与场所屏（A10 / A12），不在棋盘舞台
    if (f.mkf === 'Panel') continue;
    add(f.use, f);
  }
  for (const [k, f] of Object.entries(GOD_ARRIVAL_FLICS)) {
    const use = godArrivalUse(Number(k) as GodKind);
    if (use && f) add(use, f);
  }
  PARACHUTE_FLICS.forEach((f, c) => {
    add(parachuteUse(c), f, false);
  });
  return out;
}

const PX = 8;

/** 编码一段 FLC：每帧整块换一个颜色（调色板写在首帧） */
export function buildFakeFlc(frames: number, frameMs: number): Uint8Array {
  const palette = new Uint8Array(768);
  for (let i = 1; i < 256; i++) {
    palette[i * 3] = (i * 53) & 255;
    palette[i * 3 + 1] = (i * 97) & 255;
    palette[i * 3 + 2] = (i * 151) & 255;
  }
  const list: SynthFrame[] = [];
  for (let f = 0; f < frames; f++) {
    const pixels = new Uint8Array(PX * PX).fill(1 + (f % 250));
    // 左上角留一个透明像素（索引 0）
    pixels[0] = 0;
    list.push({ pixels, encoding: 'byterun', ...(f === 0 ? { palette } : {}) });
  }
  return buildFlc({ width: PX, height: PX, speed: frameMs, frames: list });
}

export interface FakeFlicPack {
  readonly specs: readonly FakeFlicSpec[];
  readonly entries: Readonly<Record<string, AssetEntry>>;
  readonly flicMap: FlicMapV1;
  /** 已载入的 FLIC 条目键（按顺序） */
  readonly loads: string[];
  usableEntry(key: string, opts?: { allowGuess?: boolean }): AssetEntry | null;
  loadFlic(key: string, signal?: AbortSignal): Promise<{ entry: FlicEntry; flc: FlcFile }>;
  loadData(key: string, signal?: AbortSignal): Promise<unknown>;
}

export interface FakeFlicPackOptions {
  /** 只放这些用途（缺省全部） */
  only?: (use: string) => boolean;
  /** 带 flic-map（缺省 true）；false 时条目键 = 用途键，验证没有映射表时的回退查找 */
  withMap?: boolean;
  /** 这些条目键的载入失败（验证回退） */
  failing?: ReadonlySet<string>;
}

export function buildFakeFlicPack(o: FakeFlicPackOptions = {}): FakeFlicPack {
  const withMap = o.withMap !== false;
  const specs = fakeFlicSpecs()
    .filter((s) => (o.only ? o.only(s.use) : true))
    .map((s) => (withMap ? s : { ...s, key: s.use }));
  const entries: Record<string, AssetEntry> = {};
  const flics: Record<string, FlicInfo> = {};
  for (const s of specs) {
    const durationMs = s.timing.frames * s.timing.frameMs;
    const e: FlicEntry = {
      type: 'flic',
      group: 'fx.board',
      confidence: 'exe',
      src: ['fake'],
      file: `flic/fake/${s.key}.flc`,
      w: s.w,
      h: s.h,
      frames: s.timing.frames,
      frameMs: s.timing.frameMs,
      durationMs,
      transparency: 'index0',
      sfx: s.sfx,
    };
    entries[s.key] = e;
    if (s.sfx) {
      entries[s.sfx] = {
        type: 'audio',
        group: 'sfx.board',
        confidence: 'exe',
        src: ['fake'],
        files: { opus: `audio/fake/${s.sfx}.opus` },
        durationMs: 500,
        channels: 1,
        sampleRate: 22050,
        loop: null,
      };
    }
    flics[s.key] = {
      uses: [s.use],
      w: s.w,
      h: s.h,
      frames: s.timing.frames,
      frameMs: s.timing.frameMs,
      durationMs,
      sfx: s.sfx,
      opaque: false,
      trim: null,
      placement: s.placement,
      confidence: 'exe',
      src: ['fake'],
    };
  }
  const flicMap: FlicMapV1 = { schema: ASSET_SCHEMA.flicMap, flics, src: ['fake'] } as FlicMapV1;
  if (withMap) {
    const data: DataEntry = {
      type: 'data',
      group: 'data',
      confidence: 'exe',
      src: ['fake'],
      file: 'data/fake-flic-map.json',
      schema: ASSET_SCHEMA.flicMap,
    };
    entries[DATA_KEYS.flicMap] = data;
  }
  const cache = new Map<string, Uint8Array>();
  const loads: string[] = [];
  return {
    specs,
    entries,
    flicMap,
    loads,
    usableEntry(key) {
      return Object.hasOwn(entries, key) ? entries[key]! : null;
    },
    async loadFlic(key) {
      const e = Object.hasOwn(entries, key) ? entries[key] : undefined;
      if (e?.type !== 'flic') throw new Error(`fake flics: 没有 FLIC ${key}`);
      loads.push(key);
      if (o.failing?.has(key)) throw new Error(`fake flics: ${key} 载入失败`);
      let bytes = cache.get(key);
      if (!bytes) {
        bytes = buildFakeFlc(e.frames, e.frameMs);
        cache.set(key, bytes);
      }
      return { entry: e, flc: parseFlc(bytes, key) };
    },
    async loadData(key) {
      if (key !== DATA_KEYS.flicMap || !withMap) throw new Error(`fake flics: 没有数据 ${key}`);
      return JSON.parse(JSON.stringify(flicMap)) as unknown;
    },
  };
}
