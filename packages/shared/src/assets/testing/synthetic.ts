/**
 * 合成素材包（测试与 CI 用；不含任何原版内容）：一份自洽的 manifest 草稿、图集、fixture 地图皮肤与映射表。
 * 文件字节不真实存在，sha256 由逻辑路径派生，只用于契约测试与合成包生成器的形状参考。
 */
import { sha256Hex } from '../../util/sha256';
import type { ContentType, FileKind } from '../common';
import { ASSET_SCHEMA, hashedPath, PACK_LICENSE } from '../common';
import { type MapBindingInput, type MapSkinV1, mapSkinBindingOf } from '../mapskin';
import type { FlicMapV1, MusicMapV1, SfxSetsV1, VoiceMapV1 } from '../media';
import { CHARACTER_COUNT, VOICE_CARD_COUNT, VOICE_ITEM_COUNT, VOICE_SLOT_COUNT } from '../media';
import {
  type AtlasV1,
  atlasFrame,
  type PackFile,
  type PackGroup,
  type PackManifestV1,
  spriteFrameName,
  withPackId,
} from '../pack';

/** fixture 风格的小地图：world = cell × 32 */
export function syntheticMap(): MapBindingInput {
  return {
    id: 'test',
    meta: { source: { fixture: true } },
    tiles: [
      { id: 1, world: { x: 32, y: 32 } },
      { id: 2, world: { x: 64, y: 32 } },
      { id: 3, world: { x: 96, y: 32 } },
    ],
    lots: [{ id: 'L1', world: { x: 64, y: 64 }, facing: 2 }],
    companies: [{ id: 'C1', world: { x: 96, y: 64 }, facing: 0 }],
  };
}

type FileSpec = readonly [logicalPath: string, kind: FileKind, contentType: ContentType, bytes: number, group: string];

const FILES: readonly FileSpec[] = [
  ['sprites/data/88.png', 'image', 'image/png', 1000, 'char.0'],
  ['sprites/data/88.json', 'atlas', 'application/json', 200, 'char.0'],
  ['sprites/map/27.png', 'image', 'image/png', 800, 'map.test'],
  ['sprites/map/27.mask.png', 'image', 'image/png', 90, 'map.test'],
  ['sprites/map/27.json', 'atlas', 'application/json', 150, 'map.test'],
  ['ground/test/0_0.png', 'image', 'image/png', 5000, 'map.test'],
  ['maps/test.skin.json', 'mapskin', 'application/json', 300, 'map.test'],
  ['flic/data/482.flc', 'flic', 'application/octet-stream', 400, 'fx.board'],
  ['audio/sfx/090.opus', 'audio', 'audio/ogg', 50, 'sfx.board'],
  ['audio/sfx/090.m4a', 'audio', 'audio/mp4', 60, 'sfx.board'],
  ['audio/voice/1074.opus', 'audio', 'audio/ogg', 40, 'voice.char.0'],
  ['audio/music/track10.opus', 'audio', 'audio/ogg', 700, 'music.scene'],
  ['masks/panel/8.png', 'mask', 'image/png', 70, 'ui.hud'],
  ['images/data/530.png', 'image', 'image/png', 80, 'card'],
  ['data/voice-map.json', 'data', 'application/json', 90, 'data'],
  ['data/flic-map.json', 'data', 'application/json', 95, 'data'],
  ['video/start.mp4', 'video', 'video/mp4', 100, 'video'],
];

const GROUP_CATEGORY: Readonly<Record<string, PackGroup['category']>> = {
  'char.0': 'actor',
  'map.test': 'board',
  'fx.board': 'fx',
  'sfx.board': 'sfx',
  'voice.char.0': 'voice',
  'music.scene': 'music',
  'ui.hud': 'ui',
  card: 'card',
  data: 'data',
  video: 'video',
};

export function syntheticSha(logicalPath: string): string {
  return sha256Hex(`synthetic:${logicalPath}`);
}

/** 合成 manifest（未写 packId 的草稿） */
export function syntheticManifestDraft(): Omit<PackManifestV1, 'packId'> {
  const files: Record<string, PackFile> = {};
  const groups: Record<string, PackGroup> = {};
  for (const [lp, kind, contentType, bytes, group] of FILES) {
    const sha = syntheticSha(lp);
    files[lp] = { path: hashedPath(lp, sha), bytes, sha256: sha, kind, contentType };
    const g = groups[group] ?? { category: GROUP_CATEGORY[group]!, provenance: 'synthetic', files: [], bytes: 0 };
    g.files.push(lp);
    g.bytes += bytes;
    groups[group] = g;
  }
  for (const g of Object.values(groups)) g.files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  files['flic/data/482.flc']!.variants = { br: { bytes: 120, sha256: syntheticSha('flic/data/482.flc.br') } };
  return {
    schema: ASSET_SCHEMA.manifest,
    generator: 'rich4-test/synthetic@1',
    edition: 'v206',
    license: PACK_LICENSE,
    source: { files: {}, exeSha256: null },
    tools: { ffmpeg: null },
    features: {
      board: true,
      ui: true,
      fx: true,
      minigames: false,
      audio: true,
      voice: true,
      music: true,
      video: true,
    },
    groups,
    files,
    entries: {
      'char.0.walk': {
        type: 'sprite',
        group: 'char.0',
        confidence: 'exe',
        src: ['Data#88'],
        atlas: ['sprites/data/88.json'],
        frames: { base: 'Data#88', start: 0, count: 72 },
        dirs: 8,
        frameMs: 40,
        transparency: 'index0',
        ownerMask: false,
        anchor: 'frame',
      },
      'board.house': {
        type: 'sprite',
        group: 'map.test',
        confidence: 'exe',
        src: ['map#27'],
        atlas: ['sprites/map/27.json'],
        frames: { base: 'map#27', start: 0, count: 8 },
        dirs: 8,
        frameMs: null,
        transparency: 'index0',
        ownerMask: true,
        anchor: 'frame',
      },
      'fx.fireworks': {
        type: 'flic',
        group: 'fx.board',
        confidence: 'exe',
        src: ['Data#482', 'VA 0x44fc76'],
        file: 'flic/data/482.flc',
        w: 440,
        h: 440,
        frames: 66,
        frameMs: 42,
        durationMs: 66 * 42,
        transparency: 'index0',
        sfx: 'sfx.090',
      },
      'sfx.090': {
        type: 'audio',
        group: 'sfx.board',
        confidence: 'exe',
        src: ['Effect#90'],
        files: { opus: 'audio/sfx/090.opus', m4a: 'audio/sfx/090.m4a' },
        durationMs: 2800,
        channels: 1,
        sampleRate: 22050,
        loop: null,
      },
      'voice.1074': {
        type: 'audio',
        group: 'voice.char.0',
        confidence: 'exe',
        src: ['Speaking#1074'],
        files: { opus: 'audio/voice/1074.opus' },
        durationMs: 1500,
        channels: 1,
        sampleRate: 22050,
        loop: null,
      },
      'music.title': {
        type: 'audio',
        group: 'music.scene',
        confidence: 'exe',
        src: ['track10'],
        files: { opus: 'audio/music/track10.opus' },
        durationMs: 47540,
        channels: 2,
        sampleRate: 48000,
        loop: { startMs: 0, endMs: 47540 },
      },
      'ui.go.mask': {
        type: 'mask',
        group: 'ui.hud',
        confidence: 'visual',
        src: ['Panel#8'],
        file: 'masks/panel/8.png',
        w: 72,
        h: 67,
        regions: 4,
      },
      'card.1': {
        type: 'image',
        group: 'card',
        confidence: 'exe',
        src: ['Data#530'],
        file: 'images/data/530.png',
        w: 165,
        h: 256,
        transparency: 'opaque',
        anchor: null,
      },
      'data.voice-map': {
        type: 'data',
        group: 'data',
        confidence: 'exe',
        src: [],
        file: 'data/voice-map.json',
        schema: ASSET_SCHEMA.voiceMap,
      },
      'data.flic-map': {
        type: 'data',
        group: 'data',
        confidence: 'exe',
        src: [],
        file: 'data/flic-map.json',
        schema: ASSET_SCHEMA.flicMap,
      },
      'video.start': {
        type: 'video',
        group: 'video',
        confidence: 'exe',
        src: ['Media/Start.avi'],
        files: { mp4: 'video/start.mp4' },
        w: 640,
        h: 480,
        durationMs: 33870,
      },
    },
    maps: {
      test: { skin: 'maps/test.skin.json', group: 'map.test', binding: mapSkinBindingOf(syntheticMap()) },
    },
  };
}

export function syntheticManifest(): PackManifestV1 {
  return withPackId(syntheticManifestDraft());
}

/** 72 帧（8 方向 × 9）的走姿图集：9 列 × 8 行，每帧 58×64，锚点 (29,63) */
export function syntheticAtlas(): AtlasV1 {
  const frames: AtlasV1['frames'] = {};
  const anchorsPx: AtlasV1['meta']['r4']['anchorsPx'] = {};
  for (let i = 0; i < 72; i++) {
    const name = spriteFrameName('Data#88', i);
    frames[name] = atlasFrame({ x: (i % 9) * 58, y: Math.trunc(i / 9) * 64, w: 58, h: 64 }, 29, 63);
    anchorsPx[name] = [29, 63];
  }
  return {
    schema: ASSET_SCHEMA.atlas,
    frames,
    meta: {
      app: 'rich4-test',
      version: '1',
      image: `88.${syntheticSha('sprites/data/88.png').slice(0, 8)}.png`,
      format: 'RGBA8888',
      size: { w: 522, h: 512 },
      scale: '1',
      r4: { anchorsPx, mask: null, transparency: 'index0', src: ['Data#88'] },
    },
  };
}

const R = Math.SQRT1_2;
/** 8 个视角：每步旋转 45°、纵向压缩 0.7（合成值，不是原版拟合） */
const SYNTHETIC_VIEWS: readonly [number, number][] = [
  [1, 0],
  [R, R],
  [0, 1],
  [-R, R],
  [-1, 0],
  [-R, -R],
  [0, -1],
  [R, -R],
];

export function syntheticMapSkin(): MapSkinV1 {
  return {
    schema: ASSET_SCHEMA.mapSkin,
    mapId: 'test',
    binding: mapSkinBindingOf(syntheticMap()),
    world: { w: 128, h: 128 },
    ground: { chunks: [{ file: 'ground/test/0_0.png', x: 0, y: 0, w: 128, h: 128 }], overlap: 0 },
    minimap: null,
    projection: {
      origin: { x: 220, y: 260 },
      viewport: { x: 0, y: 40, w: 440, h: 440 },
      views: SYNTHETIC_VIEWS.map(([cos, sin]) => ({
        a: cos,
        b: sin * 0.7,
        c: 0 - sin,
        d: cos * 0.7,
        tx: 0,
        ty: 0,
        maxErrPx: null,
      })),
      initialView: 0,
      cameraClamp: null,
      exact: null,
    },
    decor: { sprite: 'board.house', nodes: [{ tile: 1, frame: 0 }] },
    buildings: {
      frameRule: 'facing-view-8',
      house: {
        levels: ['board.house', 'board.house', 'board.house', 'board.house', 'board.house'],
        chain: null,
      },
      facilities: {
        park: 'board.house',
        hotel: ['board.house'],
        mall: ['board.house'],
        gas: ['board.house'],
        lab: ['board.house'],
      },
      companies: [{ lot: 'C1', sprite: 'board.house', spriteId: null }],
      ownerMark: null,
      lotHighlight: null,
    },
    scenery: [{ id: 'S1', world: { x: 16, y: 100 }, sprite: 'board.house', facing: 0, spriteId: null, landmark: null }],
    boatTiles: [3],
    src: [],
  };
}

/** 全部槽位引用同一条合成语音 */
export function syntheticVoiceMap(): VoiceMapV1 {
  const line = { key: 'voice.1074', text: null, confidence: 'guess' as const };
  const fill = (n: number) => Array.from({ length: n }, () => [line]);
  return {
    schema: ASSET_SCHEMA.voiceMap,
    characters: Array.from({ length: CHARACTER_COUNT }, () => ({
      slots: fill(VOICE_SLOT_COUNT),
      itemLines: fill(VOICE_ITEM_COUNT),
      itemReactions: { hitRoadblock: [line], hitMine: [line], bombAttached: [] },
      cardLines: { use: fill(VOICE_CARD_COUNT), self: fill(VOICE_CARD_COUNT), target: fill(VOICE_CARD_COUNT) },
    })),
    npc: { 'shop.welcome': [line] },
    news: {},
    src: [],
  };
}

export function syntheticSfxSets(): SfxSetsV1 {
  return {
    schema: ASSET_SCHEMA.sfxSets,
    sets: { board: { sfx: ['sfx.090'], confidence: 'exe', src: ['VA 0x47f62a'] } },
    src: [],
  };
}

export function syntheticMusicMap(): MusicMapV1 {
  return {
    schema: ASSET_SCHEMA.musicMap,
    board: [{ key: 'music.title', track: null, confidence: 'guess' }],
    scenes: { title: { key: 'music.title', track: 10, confidence: 'exe' } },
    src: [],
  };
}

export function syntheticFlicMap(): FlicMapV1 {
  return {
    schema: ASSET_SCHEMA.flicMap,
    flics: {
      'fx.fireworks': {
        uses: ['holiday.fireworks', 'holiday.newYear'],
        w: 440,
        h: 440,
        frames: 66,
        frameMs: 42,
        durationMs: 66 * 42,
        sfx: 'sfx.090',
        opaque: false,
        trim: null,
        placement: { kind: 'board' },
        confidence: 'exe',
        src: ['Data#482'],
      },
    },
    src: [],
  };
}
