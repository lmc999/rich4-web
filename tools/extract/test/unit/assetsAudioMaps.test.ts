/** 原版皮肤 A3：voice-map / sfx-sets / music-map / flic-map 的完整性（纯数据，不需要原版文件与 ffmpeg）。 */
import { DERIVED_DETAIL_JSON_SCHEMAS } from '@rich4/shared/assets';
import { CARD_IDS, FATE_IDS, GOD_KINDS, ITEM, ITEM_IDS, MAGIC_CONDITION_IDS, NEWS_IDS } from '@rich4/shared/data';
import { describe, expect, it } from 'vitest';
import {
  type BuiltFile,
  buildMusicMap,
  buildSfxSets,
  buildVoiceMap,
  suggestAudioGroups,
  validateSfxSets,
  validateVoiceMap,
  voiceMapIds,
} from '../../src/assets/audio';
import { FLIC_DEFS } from '../../src/assets/data/flic';
import { MUSIC_SCENES, MUSIC_TRACKS, sceneTrack } from '../../src/assets/data/music';
import { EFFECT_EMPTY_IDS, SFX_SETS } from '../../src/assets/data/sfx';
import {
  CARD_LINE_SLOTS,
  EVENT_SLOTS,
  FATE_COUNT,
  ITEM_LINE_K_DEFAULT,
  ITEM_LINE_K_OVERRIDES,
  NPC_LINES,
  SPEAKING_COUNT,
} from '../../src/assets/data/voice';
import { findFlic, loadFlicMap, validateFlicMap } from '../../src/assets/flicMap';
import { VIDEO_MAP_SCHEMA } from '../../src/assets/video';

describe('A3 详表 / 暂存映射表的 schema', () => {
  it('都登记在 shared DERIVED_DETAIL_JSON_SCHEMAS 里（scripts/check-no-original 按它拦截改名入库的拷贝）', () => {
    const ids = [
      buildVoiceMap().schema,
      buildSfxSets().schema,
      buildMusicMap().schema,
      loadFlicMap().schema,
      VIDEO_MAP_SCHEMA,
    ];
    expect([...ids].sort()).toEqual([...DERIVED_DETAIL_JSON_SCHEMAS].sort());
  });
});

describe('voice-map', () => {
  const m = buildVoiceMap();

  it('结构检查无问题：27 槽 × 12 角色齐全、编号不越界、1374 个编号各出现恰好一次', () => {
    expect(validateVoiceMap(m)).toEqual([]);
    expect(m.events.byChar).toHaveLength(12);
    for (const row of m.events.byChar) expect(row).toHaveLength(27);
    const ids = voiceMapIds(m);
    expect(ids).toHaveLength(SPEAKING_COUNT);
    expect(new Set(ids).size).toBe(SPEAKING_COUNT);
    expect(Math.min(...ids)).toBe(0);
    expect(Math.max(...ids)).toBe(SPEAKING_COUNT - 1);
  });

  it('事件槽 = 1050 + 27c + slot，槽号与下标一致、键唯一', () => {
    expect(EVENT_SLOTS.map((s) => s.slot)).toEqual(Array.from({ length: 27 }, (_, i) => i));
    expect(new Set(EVENT_SLOTS.map((s) => s.key)).size).toBe(27);
    for (let c = 0; c < 12; c++) for (let s = 0; s < 27; s++) expect(m.events.byChar[c]![s]).toBe(1050 + 27 * c + s);
    expect(m.events.byChar[0]![24]).toBe(1074); // 约翰乔胜利宣言（audio_video.md §1.2）
  });

  it('道具台词落在 234+16c+k，按道具号取（exe 表 0x47e03a 的顺序）', () => {
    expect(ITEM_IDS).toHaveLength(13);
    for (let c = 0; c < 12; c++) {
      const own = new Set([...m.items.byChar[c]!, ...m.items.reactions.map((r) => r.byChar[c]!)]);
      expect(own.size).toBe(16);
      for (const id of own) expect(id >= 234 + 16 * c && id < 234 + 16 * (c + 1)).toBe(true);
    }
    // 机车：约翰乔 234、忍太郎 266、宫本宝藏 330（audio_video.md §1.2 例句）
    expect(m.items.byChar[0]![ITEM.MOTORCYCLE - 1]).toBe(234);
    expect(m.items.byChar[2]![ITEM.MOTORCYCLE - 1]).toBe(266);
    expect(m.items.byChar[6]![ITEM.MOTORCYCLE - 1]).toBe(330);
    // 金贝贝按表下标顺序排列
    expect(m.items.byChar[11]![ITEM.ROBOT_DOLL - 1]).toBe(410);
    expect(m.items.byChar[11]![ITEM.NUKE - 1]).toBe(422);
    expect(Object.keys(ITEM_LINE_K_DEFAULT)).toHaveLength(16);
    expect(Object.keys(ITEM_LINE_K_OVERRIDES[11]!)).toHaveLength(16);
  });

  it('卡片台词：52 个有效下标，前 30 个是 30 张卡的使用台词', () => {
    expect(CARD_IDS).toHaveLength(30);
    expect(CARD_LINE_SLOTS).toHaveLength(52);
    expect(new Set(CARD_LINE_SLOTS).size).toBe(52);
    expect(CARD_LINE_SLOTS.every((j) => j >= 0 && j < 90)).toBe(true);
    for (let c = 0; c < 12; c++) for (let k = 0; k < 30; k++) expect(m.cards.use[c]![k]).toBe(426 + 52 * c + k);
    expect(m.cards.self.map((s) => s.cardId)).toEqual([6, 7, 14, 30]);
    expect(m.cards.target.map((s) => s.cardId)).toEqual([
      2, 3, 4, 5, 6, 7, 8, 11, 12, 13, 14, 17, 18, 19, 20, 26, 29, 30,
    ]);
  });

  it('NPC、点名、新闻、命运', () => {
    expect(new Set(NPC_LINES.map((n) => n.key)).size).toBe(NPC_LINES.length);
    const cond = NPC_LINES.find((n) => n.key === 'magic.condition')!;
    expect(cond.ids).toHaveLength(MAGIC_CONDITION_IDS.length);
    expect(m.names.find((n) => n.key === 'lottery.winnerName')!.byChar).toEqual(
      Array.from({ length: 12 }, (_, c) => 20 + c),
    );
    expect(m.news).toHaveLength(NEWS_IDS.length);
    expect(m.news[0]).toBe(149);
    expect(m.news.at(-1)).toBe(184);
    expect(FATE_COUNT).toBe(FATE_IDS.length + 12);
    expect(m.fate[0]).toBe(185);
    expect(m.fate.at(-1)).toBe(233);
    for (const id of m.noText) expect(id >= 0 && id < 234).toBe(true);
  });

  it('带时长时长度必须是 1374', () => {
    const bad = buildVoiceMap({ durationsMs: [1, 2, 3] });
    expect(validateVoiceMap(bad).some((s) => s.includes('durationsMs'))).toBe(true);
  });
});

describe('sfx-sets', () => {
  const m = buildSfxSets();

  it('结构检查无问题：编号不越界、不落在空占位、每个非空音效都有归属', () => {
    expect(validateSfxSets(m)).toEqual([]);
    expect(m.count).toBe(115);
    expect(m.empty).toEqual(EFFECT_EMPTY_IDS);
    expect(m.empty).toHaveLength(16);
    expect(SFX_SETS).toHaveLength(16);
  });

  it('FLIC 同步音效覆盖 80..114', () => {
    const sync = new Set(m.flicSync.map((f) => f.sfx));
    for (let i = 80; i <= 114; i++) expect(sync.has(i), `音效 ${i}`).toBe(true);
  });

  it('检查能发现越界与空占位', () => {
    const bad = { ...m, sets: [...m.sets, { key: 'x', va: '0x0', ids: [64, 200], desc: '', loadedAt: [] }] };
    const issues = validateSfxSets(bad);
    expect(issues.some((s) => s.includes('空占位'))).toBe(true);
    expect(issues.some((s) => s.includes('越界'))).toBe(true);
  });
});

describe('music-map', () => {
  const m = buildMusicMap();

  it('25 轨；棋盘曲 = idx + 2（8 首轮播）；track13 未用', () => {
    expect(MUSIC_TRACKS.map((t) => t.track)).toEqual(Array.from({ length: 25 }, (_, i) => i + 2));
    expect(m.board.tracks).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    m.tracks
      .filter((t) => t.role === 'board')
      .forEach((t) => {
        expect(t.track).toBe((t.boardIdx ?? -1) + 2);
        expect(t.loop).toBe(false);
        expect(t.trim).toBeNull();
      });
    expect(m.unused).toEqual([13]);
  });

  it('场景曲 = (arg & 0x7fff) + 10，落在场景轨上；必需场景齐全', () => {
    const byTrack = new Map(m.tracks.map((t) => [t.track, t]));
    for (const s of m.scenes) {
      expect(s.track).toBe(sceneTrack(s.arg));
      expect(byTrack.get(s.track)?.role).toBe('scene');
    }
    const keys = new Set(MUSIC_SCENES.map((s) => s.key));
    expect(keys.size).toBe(MUSIC_SCENES.length);
    for (const k of [
      'title',
      'setup',
      'bankrupt',
      'bank',
      'auction',
      'shop.item',
      'lottery.bet',
      'lottery.draw',
      'magic',
      'month',
      'mg.penguin',
      'mg.balloon',
      'mg.fortune',
      'holiday.christmas',
      'holiday.lunarNewYear',
      'jail',
      'hospital',
    ]) {
      expect(keys.has(k), k).toBe(true);
    }
    expect(m.scenes.find((s) => s.key === 'setup')!.noResume).toBe(true);
    expect(m.scenes.find((s) => s.key === 'bank')!.track).toBe(14);
    // 每条场景轨都至少被一个场景引用
    const used = new Set(m.scenes.map((s) => s.track));
    for (const t of m.tracks.filter((x) => x.role === 'scene')) expect(used.has(t.track), `track${t.track}`).toBe(true);
  });

  it('场景曲循环区间在源时长内，输出时长 = 区间长度', () => {
    for (const t of m.tracks.filter((x) => x.role === 'scene')) {
      expect(t.loop).toBe(true);
      expect(t.trim).not.toBeNull();
      expect(t.trim!.startMs).toBeGreaterThanOrEqual(0);
      expect(t.trim!.endMs).toBeLessThanOrEqual(t.srcDurationMs);
      expect(t.trim!.endMs - t.trim!.startMs).toBe(t.durationMs);
    }
  });

  it('按实际状态覆盖（源时长不符时不裁剪）', () => {
    const m2 = buildMusicMap({ tracks: [{ track: 12, trim: null, srcDurationMs: 17000 }] });
    const t = m2.tracks.find((x) => x.track === 12)!;
    expect(t.trim).toBeNull();
    expect(t.durationMs).toBe(17000);
  });
});

describe('flic-map', () => {
  const m = loadFlicMap();

  it('结构检查无问题：Data 72 / Panel 8 / jump 25，按角色的组齐全', () => {
    expect(validateFlicMap(m)).toEqual([]);
    expect(m.entries).toHaveLength(105);
    expect(m.entries).toHaveLength(FLIC_DEFS.length);
  });

  it('原版时长 = frames × frameMs', () => {
    expect(findFlic(m, 'Data', 483)!.durationMs).toBe(6200); // 救护车 62 × 100
    expect(findFlic(m, 'Data', 497)!.durationMs).toBe(35 * 71); // 警车
    expect(findFlic(m, 'Panel', 4)!.durationMs).toBe(36 * 14); // 骰子
  });

  it('12 位附身神明与 GodKind 一一对应（恶犬不附身）', () => {
    const gods = m.entries.filter((e) => e.use === 'god.arrive');
    expect(gods.map((g) => g.god).sort((a, b) => a! - b!)).toEqual(GOD_KINDS.filter((g) => g !== 11));
    expect(gods.map((g) => g.res)).toEqual(Array.from({ length: 12 }, (_, i) => 499 + i));
    expect(findFlic(m, 'Data', 508)!.sfx).toBe(112); // 恶魔与土地公的音效号交叉
    expect(findFlic(m, 'Data', 509)!.sfx).toBe(111);
  });

  it('不透明只有 Panel#16、Panel#20、jump#42', () => {
    expect(m.entries.filter((e) => e.opaque).map((e) => e.key)).toEqual(['Panel#16', 'Panel#20', 'jump#42']);
  });

  it('A8 要用的用途键都在', () => {
    const uses = new Set(m.entries.map((e) => e.use));
    for (const u of [
      'god.arrive',
      'fx.ambulance',
      'fx.policeCar',
      'fx.explosion.small',
      'fx.missile',
      'fx.nuke',
      'char.parachuteBoard',
      'dice.roll1',
      'lottery.machine',
      'holiday.christmas',
      'fx.fireworks',
    ]) {
      expect(uses.has(u), u).toBe(true);
    }
  });
});

describe('懒加载分组建议', () => {
  it('系统语音、按角色语音、音效、每轨音乐、映射表各成一组', () => {
    const f = (key: string, kind: BuiltFile['kind']): BuiltFile => ({
      key,
      path: key,
      sha256: '0'.repeat(64),
      bytes: 1,
      kind,
      format: 'opus',
      contentType: 'audio/ogg; codecs=opus',
      durationMs: 1,
      source: null,
    });
    const g = suggestAudioGroups(
      [
        f('audio/voice/0149.opus', 'voice'),
        f('audio/voice/0266.m4a', 'voice'),
        f('audio/voice/1074.opus', 'voice'),
        f('audio/voice/0426.opus', 'voice'),
        f('audio/sfx/082.opus', 'sfx'),
        f('audio/music/track10.opus', 'music'),
        f('data/voice-map.json', 'data'),
      ],
      buildVoiceMap(),
    );
    expect(g).toEqual({
      'audio.voice.system': ['audio/voice/0149.opus'],
      'audio.voice.char.2': ['audio/voice/0266.m4a'],
      'audio.voice.char.0': ['audio/voice/0426.opus', 'audio/voice/1074.opus'],
      'audio.sfx': ['audio/sfx/082.opus'],
      'audio.music.track10': ['audio/music/track10.opus'],
      'audio.data': ['data/voice-map.json'],
    });
  });
});
