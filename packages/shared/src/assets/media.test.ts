import { describe, expect, it } from 'vitest';
import { checkFlicMapRefs, checkMusicMapRefs, checkSfxSetsRefs, checkVoiceMapRefs } from './crossref';
import {
  CHARACTER_COUNT,
  flicsForUse,
  flicUseIndex,
  MUSIC_SCENES,
  parseFlicMap,
  parseMusicMap,
  parseSfxSets,
  parseVoiceMap,
  safeParseFlicMap,
  safeParseMusicMap,
  safeParseSfxSets,
  safeParseVoiceMap,
  VOICE_CARD_COUNT,
  VOICE_CARD_LINES,
  VOICE_ITEM_COUNT,
  VOICE_ITEM_LINES,
  VOICE_SLOT_COUNT,
  VOICE_SLOTS,
  type VoiceMapV1,
  voiceMapKeys,
  voiceSlotIndex,
} from './media';
import {
  ORIGINAL_BOARD_TRACKS,
  ORIGINAL_NPC_VOICE_END,
  ORIGINAL_SCENE_TRACKS,
  ORIGINAL_VOICE_COUNT,
  ORIGINAL_VOICE_LAYOUT,
  originalVoiceIndex,
} from './original';
import {
  syntheticFlicMap,
  syntheticManifest,
  syntheticMusicMap,
  syntheticSfxSets,
  syntheticVoiceMap,
} from './testing/synthetic';

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

/** 结构示例：有「对自己使用」「被施用者反应」台词的卡（按 A3 的 exe 表；这里只用来凑满 52 条分段） */
const SELF_CARDS = [6, 7, 14, 30];
const TARGET_CARDS = [2, 3, 4, 5, 6, 7, 8, 11, 12, 13, 14, 17, 18, 19, 20, 26, 29, 30];

/**
 * 按原版编号公式生成的 voice-map（逻辑键 voice.<n>）。道具、卡片按分段序号依次填入语义槽位——只检验结构与计数，
 * 真实的「道具号 / 卡号 → 分段序号」对应由 tools/extract 从 exe 台词表生成（见 assetsMedia.test.ts）。
 */
function originalLayoutVoiceMap(): VoiceMapV1 {
  const line = (n: number) => [{ key: `voice.${n}`, text: null, confidence: 'exe' as const }];
  const card = (c: number, k: number) => line(originalVoiceIndex('card', c, k));
  return {
    schema: 'rich4.voicemap/1',
    characters: range(CHARACTER_COUNT).map((c) => ({
      slots: range(VOICE_SLOT_COUNT).map((k) => line(originalVoiceIndex('slot', c, k))),
      itemLines: range(VOICE_ITEM_COUNT).map((i) => line(originalVoiceIndex('item', c, i))),
      itemReactions: {
        hitRoadblock: line(originalVoiceIndex('item', c, 13)),
        hitMine: line(originalVoiceIndex('item', c, 14)),
        bombAttached: line(originalVoiceIndex('item', c, 15)),
      },
      cardLines: {
        use: range(VOICE_CARD_COUNT).map((i) => card(c, i)),
        self: range(VOICE_CARD_COUNT).map((i) =>
          SELF_CARDS.includes(i + 1) ? card(c, VOICE_CARD_COUNT + SELF_CARDS.indexOf(i + 1)) : [],
        ),
        target: range(VOICE_CARD_COUNT).map((i) =>
          TARGET_CARDS.includes(i + 1)
            ? card(c, VOICE_CARD_COUNT + SELF_CARDS.length + TARGET_CARDS.indexOf(i + 1))
            : [],
        ),
      },
    })),
    npc: { 'shop.welcome': line(1) },
    news: { 'news.4': line(153) },
    src: ['speaking.manifest.json'],
  };
}

describe('原版编号事实', () => {
  it('语音分段首尾相接，覆盖 234..1373', () => {
    const { item, card, slot } = ORIGINAL_VOICE_LAYOUT;
    expect(item.base).toBe(ORIGINAL_NPC_VOICE_END);
    expect(item.base + item.stride * CHARACTER_COUNT).toBe(card.base);
    expect(card.base + card.stride * CHARACTER_COUNT).toBe(slot.base);
    expect(slot.base + slot.stride * CHARACTER_COUNT).toBe(ORIGINAL_VOICE_COUNT);
    expect(originalVoiceIndex('slot', CHARACTER_COUNT - 1, VOICE_SLOT_COUNT - 1)).toBe(ORIGINAL_VOICE_COUNT - 1);
  });

  it('与调研核对过的编号一致', () => {
    expect(originalVoiceIndex('slot', 0, voiceSlotIndex('win'))).toBe(1074); // 角色 0 的胜利台词
    expect(originalVoiceIndex('item', 0, 0)).toBe(234); // 角色 0 道具台词分段的第 1 条
    expect(originalVoiceIndex('item', 2, 0)).toBe(266); // 忍太郎
    expect(originalVoiceIndex('item', 6, 0)).toBe(330); // 宮本寶藏
    expect(originalVoiceIndex('card', 2, 0)).toBe(530);
    expect(originalVoiceIndex('card', 6, VOICE_CARD_LINES - 1)).toBe(789);
    expect(originalVoiceIndex('slot', 2, 0)).toBe(1104);
    expect(originalVoiceIndex('slot', 6, VOICE_SLOT_COUNT - 1)).toBe(1238);
    expect(originalVoiceIndex('item', 11, 0)).toBe(410); // 金貝貝
    expect(() => originalVoiceIndex('slot', 12, 0)).toThrow(RangeError);
    expect(() => originalVoiceIndex('card', 0, 52)).toThrow(RangeError);
    expect(() => originalVoiceIndex('item', 0, -1)).toThrow(RangeError);
  });

  it('事件槽 27 个，关键槽号与调研一致', () => {
    expect(VOICE_SLOTS.length).toBe(VOICE_SLOT_COUNT);
    expect(new Set(VOICE_SLOTS).size).toBe(VOICE_SLOT_COUNT);
    expect(voiceSlotIndex('buildLevel5')).toBe(15);
    expect(voiceSlotIndex('jail')).toBe(19);
    expect(voiceSlotIndex('hospital')).toBe(20);
    expect(voiceSlotIndex('badGodAttach')).toBe(22);
    expect(voiceSlotIndex('bankrupt')).toBe(25);
    expect(voiceSlotIndex('gameStart')).toBe(26);
  });

  it('音乐：棋盘 track02..09，场景曲覆盖全部场景且不用 track13', () => {
    expect(ORIGINAL_BOARD_TRACKS).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(Object.keys(ORIGINAL_SCENE_TRACKS).sort()).toEqual([...MUSIC_SCENES].sort());
    const used = new Set(Object.values(ORIGINAL_SCENE_TRACKS));
    expect(used.has(13)).toBe(false);
    expect([...used].sort((a, b) => a - b)).toEqual([10, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26]);
    expect(ORIGINAL_SCENE_TRACKS.bank).toBe(14);
    expect(ORIGINAL_SCENE_TRACKS.penguin).toBe(22);
  });
});

describe('voice-map', () => {
  it('按原版公式生成的映射通过校验，引用 12×95 条角色语音', () => {
    const v = originalLayoutVoiceMap();
    expect(parseVoiceMap(JSON.parse(JSON.stringify(v)))).toEqual(v);
    const keys = voiceMapKeys(v);
    expect(keys.length).toBe(CHARACTER_COUNT * (VOICE_SLOT_COUNT + VOICE_CARD_LINES + VOICE_ITEM_LINES) + 2);
    expect(keys).toContain('voice.1074');
    expect([...keys].sort()).toEqual(keys);
  });

  it('长度不对、角色数不对、未知键、旧版按分段序号的 items/cards 一律拒绝', () => {
    const v = originalLayoutVoiceMap();
    const short = structuredClone(v);
    short.characters[3]!.slots.pop();
    expect(safeParseVoiceMap(short).ok).toBe(false);
    const items = structuredClone(v);
    items.characters[0]!.itemLines.push([]);
    expect(safeParseVoiceMap(items).ok).toBe(false);
    const cards = structuredClone(v);
    cards.characters[0]!.cardLines.self.pop();
    expect(safeParseVoiceMap(cards).ok).toBe(false);
    const reaction = structuredClone(v) as unknown as { characters: { itemReactions: Record<string, unknown> }[] };
    reaction.characters[0]!.itemReactions.other = [];
    expect(safeParseVoiceMap(reaction).ok).toBe(false);
    // 旧形状（下标 = 分段序号 k 的 items / cards）不再被接受，避免按序号播错台词
    const legacy = structuredClone(v) as unknown as { characters: Record<string, unknown>[] };
    for (const ch of legacy.characters) {
      ch.items = range(VOICE_ITEM_LINES).map(() => []);
      ch.cards = range(VOICE_CARD_LINES).map(() => []);
    }
    expect(safeParseVoiceMap(legacy).ok).toBe(false);
    const eleven = structuredClone(v);
    eleven.characters.pop();
    expect(safeParseVoiceMap(eleven).ok).toBe(false);
    expect(safeParseVoiceMap({ ...v, extra: 1 }).ok).toBe(false);
    const badKey = structuredClone(v);
    badKey.npc['../x'] = [];
    expect(safeParseVoiceMap(badKey).ok).toBe(false);
  });

  it('与 manifest 交叉检查：引用的条目必须是 audio', () => {
    const m = syntheticManifest();
    expect(checkVoiceMapRefs(m, syntheticVoiceMap())).toEqual([]);
    const v = syntheticVoiceMap();
    v.npc['shop.welcome'] = [{ key: 'card.1', text: '歡迎光臨道具店！', confidence: 'exe' }];
    v.news['news.4'] = [{ key: 'voice.9999', text: null, confidence: 'guess' }];
    expect(checkVoiceMapRefs(m, v).map((i) => i.message)).toEqual([
      '条目 card.1 的类型应为 audio',
      '条目 voice.9999 不存在',
    ]);
  });
});

describe('sfx-sets / music-map', () => {
  it('音效集：合法、重复项与交叉检查', () => {
    const s = syntheticSfxSets();
    expect(parseSfxSets(s)).toEqual(s);
    expect(checkSfxSetsRefs(syntheticManifest(), s)).toEqual([]);
    const dup = structuredClone(s);
    dup.sets.board!.sfx = ['sfx.090', 'sfx.090'];
    const r = safeParseSfxSets(dup);
    expect(r.ok ? [] : r.issues).toEqual(['sets.board.sfx: 音效集内有重复项']);
    const empty = structuredClone(s);
    empty.sets.board!.sfx = [];
    expect(safeParseSfxSets(empty).ok).toBe(false);
    const missing = structuredClone(s);
    missing.sets.board!.sfx = ['sfx.001'];
    expect(checkSfxSetsRefs(syntheticManifest(), missing).map((i) => i.path.join('.'))).toEqual([
      'sfx-sets.sets.board.sfx.0',
    ]);
  });

  it('音乐：场景可以只给一部分，未知场景与空轮播拒绝', () => {
    const mm = syntheticMusicMap();
    expect(parseMusicMap(mm)).toEqual(mm);
    expect(checkMusicMapRefs(syntheticManifest(), mm)).toEqual([]);
    expect(safeParseMusicMap({ ...mm, scenes: { lobby: mm.scenes.title } }).ok).toBe(false);
    expect(safeParseMusicMap({ ...mm, board: [] }).ok).toBe(false);
    const bad = structuredClone(mm);
    bad.scenes.bank = { key: 'card.1', track: 14, confidence: 'exe' };
    expect(checkMusicMapRefs(syntheticManifest(), bad).map((i) => i.path.join('.'))).toEqual(['music-map.scenes.bank']);
  });
});

describe('flic-map', () => {
  it('合法映射、反向索引与交叉检查', () => {
    const f = syntheticFlicMap();
    expect(parseFlicMap(JSON.parse(JSON.stringify(f)))).toEqual(f);
    expect(checkFlicMapRefs(syntheticManifest(), f)).toEqual([]);
    expect(flicsForUse(f, 'holiday.newYear')).toEqual(['fx.fireworks']);
    expect(flicsForUse(f, 'nope')).toEqual([]);
    expect([...flicUseIndex(f).entries()]).toEqual([
      ['holiday.fireworks', ['fx.fireworks']],
      ['holiday.newYear', ['fx.fireworks']],
    ]);
  });

  it('时长、uses 顺序、trim 区间自洽', () => {
    const issues = (mutate: (f: ReturnType<typeof syntheticFlicMap>) => void): string[] => {
      const f = syntheticFlicMap();
      mutate(f);
      const r = safeParseFlicMap(f);
      return r.ok ? [] : r.issues;
    };
    expect(
      issues((f) => {
        f.flics['fx.fireworks']!.durationMs = 2800;
      }),
    ).toEqual(['flics.fx.fireworks.durationMs: durationMs 必须等于 frames × frameMs']);
    expect(
      issues((f) => {
        f.flics['fx.fireworks']!.uses.reverse();
      }),
    ).toEqual(['flics.fx.fireworks.uses: uses 必须升序且唯一']);
    expect(
      issues((f) => {
        f.flics['fx.fireworks']!.trim = { startFrame: 10, endFrame: 67 };
      }),
    ).toEqual(['flics.fx.fireworks.trim: trim 必须满足 0 ≤ startFrame < endFrame ≤ frames']);
    expect(
      issues((f) => {
        f.flics['fx.fireworks']!.placement = { kind: 'screen', x: 204, y: 180 };
      }),
    ).toEqual([]);
  });

  it('与 manifest 的 flic 条目不一致时报告', () => {
    const f = syntheticFlicMap();
    f.flics['fx.fireworks']!.frameMs = 40;
    f.flics['fx.fireworks']!.durationMs = 66 * 40;
    f.flics['fx.fireworks']!.opaque = true;
    f.flics['card.1'] = { ...f.flics['fx.fireworks']!, sfx: null };
    expect(checkFlicMapRefs(syntheticManifest(), f).map((i) => i.message)).toEqual([
      '条目 card.1 的类型应为 flic',
      '与条目 fx.fireworks 的尺寸、帧数或帧间隔不一致',
      '与条目 fx.fireworks 的透明规则不一致',
    ]);
  });
});
