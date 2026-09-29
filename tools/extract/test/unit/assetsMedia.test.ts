/**
 * 原版皮肤 A2：A3 映射表 → 素材包契约版（voice-map / sfx-sets / music-map / flic-map）与音频条目。纯函数，只用 A3 的静态数据。
 */
import { VOICE_CARD_COUNT, VOICE_ITEM_COUNT, VOICE_SLOT_COUNT, voiceMapKeys } from '@rich4/shared/assets';
import { describe, expect, it } from 'vitest';
import { type BuiltFile, buildMusicMap, buildSfxSets, buildVoiceMap } from '../../src/assets/audio';
import { catalogV206, type FlicItem } from '../../src/assets/catalog.v206';
import { cardLineVoice, itemLineVoice } from '../../src/assets/data/voice';
import {
  audioEntries,
  flicInfo,
  flicPlacement,
  flicUses,
  parseAudioFileKey,
  sfxKey,
  toFlicMapV1,
  toMusicMapV1,
  toSfxSetsV1,
  toVoiceMapV1,
  voiceCharIndex,
  voiceKey,
} from '../../src/assets/mediaMaps';

const flics = catalogV206().items.filter((it): it is FlicItem => it.type === 'flic');

describe('voice-map 契约版', () => {
  const a3 = buildVoiceMap();
  const v = toVoiceMapV1(a3);

  it('12 角色 × 27 槽，事件槽 = 1050+27c+slot，不含台词文本', () => {
    expect(v.characters).toHaveLength(12);
    for (let c = 0; c < 12; c++) {
      const ch = v.characters[c]!;
      expect(ch.slots).toHaveLength(VOICE_SLOT_COUNT);
      expect(ch.slots[26]![0]!.key).toBe(voiceKey(1050 + 27 * c + 26));
    }
    const all = JSON.stringify(v);
    expect(all).not.toMatch(/"text":"[^"]/);
  });

  it('道具台词按道具号索引，与 exe 台词表 0x47e03a 的逐角色对应一致（角色 0..10 为置换，不是分段序号）', () => {
    // 审查复现：角色 0 的道具 1（机器娃娃）是 236，不是分段首条 234
    expect(v.characters[0]!.itemLines[0]![0]!.key).toBe(voiceKey(236));
    expect(v.characters[0]!.itemLines.map((l) => Number(l[0]!.key.slice(6)))).toEqual([
      236, 237, 238, 239, 234, 235, 240, 241, 246, 242, 243, 244, 245,
    ]);
    expect(v.characters[5]!.itemLines.map((l) => Number(l[0]!.key.slice(6))).slice(0, 6)).toEqual([
      316, 317, 318, 319, 314, 315,
    ]);
    // 角色 11 的 16 条按表下标顺序排列
    expect(v.characters[11]!.itemLines.map((l) => Number(l[0]!.key.slice(6)))).toEqual(
      Array.from({ length: VOICE_ITEM_COUNT }, (_, i) => 410 + i),
    );
    for (let c = 0; c < 12; c++) {
      const ch = v.characters[c]!;
      for (let item = 1; item <= VOICE_ITEM_COUNT; item++) {
        expect(ch.itemLines[item - 1]![0]!.key, `c${c} item${item}`).toBe(voiceKey(itemLineVoice(c, item - 1)!));
        expect(ch.itemLines[item - 1]![0]!.key).toBe(voiceKey(a3.items.byChar[c]![item - 1]!));
      }
      const r = ch.itemReactions;
      expect([r.hitRoadblock, r.hitMine, r.bombAttached].map((l) => l[0]!.key)).toEqual(
        [14, 15, 16].map((j) => voiceKey(itemLineVoice(c, j)!)),
      );
      expect(r.bombAttached[0]!.confidence).toBe('guess');
    }
  });

  it('卡片台词按卡号索引：use 30 张齐全；self 只有卡 6/7/14/30，target 18 张，均与 exe 台词表 0x47e51a 一致', () => {
    const cardsWith = (mode: 'self' | 'target', c: number) =>
      v.characters[c]!.cardLines[mode].flatMap((l, i) => (l.length > 0 ? [i + 1] : []));
    for (let c = 0; c < 12; c++) {
      const ch = v.characters[c]!;
      expect(ch.cardLines.use).toHaveLength(VOICE_CARD_COUNT);
      for (let card = 1; card <= VOICE_CARD_COUNT; card++) {
        expect(ch.cardLines.use[card - 1]![0]!.key).toBe(voiceKey(cardLineVoice(c, card - 1)!));
        for (const [mode, m] of [
          ['self', 1],
          ['target', 2],
        ] as const) {
          const id = cardLineVoice(c, 30 * m + card - 1);
          expect(ch.cardLines[mode][card - 1]!.map((l) => l.key)).toEqual(id === null ? [] : [voiceKey(id)]);
        }
      }
      expect(cardsWith('self', c)).toEqual([6, 7, 14, 30]);
      expect(cardsWith('target', c)).toHaveLength(18);
    }
    // 角色 0：卡 6 对自己使用 = 分段第 31 条（426+30），卡 2 被施用反应 = 分段第 35 条（426+34）
    expect(v.characters[0]!.cardLines.self[5]![0]!.key).toBe(voiceKey(456));
    expect(v.characters[0]!.cardLines.target[1]![0]!.key).toBe(voiceKey(460));
    expect(v.characters[0]!.cardLines.self[5]![0]!.confidence).toBe('visual');
  });

  it('每名角色的道具、卡片台词恰好覆盖自己的 16 + 52 条分段，无重无漏', () => {
    for (let c = 0; c < 12; c++) {
      const ch = v.characters[c]!;
      const ids = [
        ...ch.itemLines,
        ch.itemReactions.hitRoadblock,
        ch.itemReactions.hitMine,
        ch.itemReactions.bombAttached,
        ...ch.cardLines.use,
        ...ch.cardLines.self,
        ...ch.cardLines.target,
      ].flatMap((l) => l.map((x) => Number(x.key.slice(6))));
      const expected = [
        ...Array.from({ length: 16 }, (_, k) => 234 + 16 * c + k),
        ...Array.from({ length: 52 }, (_, k) => 426 + 52 * c + k),
      ];
      expect([...ids].sort((a, b) => a - b)).toEqual(expected);
    }
  });

  it('覆盖全部 1374 个语音号；多条 NPC 台词另给按下标的键（魔法屋条件号）', () => {
    const keys = new Set<string>();
    const add = (l: { key: string }[]) => {
      for (const x of l) keys.add(x.key);
    };
    for (const c of v.characters) {
      for (const g of [...c.slots, ...c.itemLines, ...c.cardLines.use, ...c.cardLines.self, ...c.cardLines.target]) {
        add(g);
      }
      for (const g of Object.values(c.itemReactions)) add(g);
    }
    for (const g of Object.values(v.npc)) add(g);
    for (const g of Object.values(v.news)) add(g);
    expect(keys.size).toBe(1374);
    expect(voiceMapKeys(v)).toEqual([...keys].sort());
    expect(v.npc['magic.condition.11']).toHaveLength(1);
    expect(v.npc['misc.unlabeled58']).toBeUndefined();
    expect(v.npc['misc.unlabeled58.16']).toHaveLength(1);
    expect(Object.keys(v.news).filter((k) => k.startsWith('news.'))).toHaveLength(36);
  });

  it('语音号 → 角色号（系统语音不在表内）', () => {
    const m = voiceCharIndex(a3);
    expect(m.get(1050 + 27 * 3)).toBe(3);
    expect(m.get(0)).toBeUndefined();
  });
});

describe('sfx-sets / music-map 契约版', () => {
  it('场景音效集改用契约建议名，用途写成 cue.<用途>，只引用存在的条目', () => {
    const s = toSfxSetsV1(buildSfxSets(), () => true);
    expect(s.sets.global!.sfx).toEqual([0, 1, 2, 4, 3].map(sfxKey));
    expect(s.sets['mg.xicong']).toBeDefined();
    expect(s.sets['cue.ui.click']!.sfx).toEqual([sfxKey(1)]);
    // 按下 GO 钮（鼠标）：exe 0x417ac9 放全局音效表的 Effect#1
    expect(s.sets['cue.ui.go']).toMatchObject({ sfx: [sfxKey(1)], confidence: 'exe' });
    const none = toSfxSetsV1(buildSfxSets(), () => false);
    expect(Object.keys(none.sets)).toEqual([]);
  });

  it('棋盘曲 8 首（CD 轨 idx+2），场景曲 18 个（轨 = arg+10）', () => {
    const m = toMusicMapV1(buildMusicMap(), () => true);
    expect(m.board.map((t) => t.track)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(m.scenes.bank).toEqual({ key: 'music.track14', track: 14, confidence: 'exe' });
    expect(m.scenes.xicong?.track).toBe(20);
    expect(Object.keys(m.scenes)).toHaveLength(18);
  });
});

describe('flic-map 契约版', () => {
  it('105 段全部换算：用途名唯一，440×440 贴棋盘、640×480 整屏，位置已知的用 screen', () => {
    const m = toFlicMapV1(flics.map((it) => ({ key: it.key, info: flicInfo(it, null) })));
    expect(Object.keys(m.flics)).toHaveLength(105);
    const uses = flics.flatMap(flicUses);
    expect(new Set(uses).size).toBe(uses.length);
    const byKey = new Map(flics.map((it) => [it.key, it]));
    expect(flicPlacement(byKey.get('fx.ambulance')!).placement).toEqual({ kind: 'screen', x: 0, y: 210 });
    expect(flicPlacement(byKey.get('fx.god.death')!).placement).toEqual({ kind: 'board' });
    expect(flicPlacement(byKey.get('title.freefall.3')!).placement).toEqual({ kind: 'fullscreen' });
    expect(flicUses(byKey.get('fx.god.smallWealth')!)).toEqual(['god.arrive.smallWealth']);
    expect(flicUses(byKey.get('char.5.parachute')!)).toEqual(['char.parachuteBoard.5']);
    expect(m.flics['venue.magic.cast']!.opaque).toBe(true);
  });
});

describe('音频条目', () => {
  const bf = (key: string, format: 'opus' | 'm4a', durationMs: number, kind: BuiltFile['kind']): BuiltFile => ({
    key,
    path: key.replace(/\.(opus|m4a)$/, `.0123abcd.$1`),
    sha256: '0'.repeat(64),
    bytes: 10,
    kind,
    format,
    contentType: '',
    durationMs,
    source: null,
  });

  it('两种格式合并为一个条目，时长取较小值；场景曲 loop = [0, durationMs]，棋盘曲不循环；按角色分组', () => {
    const files = [
      bf('audio/voice/1131.opus', 'opus', 1500, 'voice'),
      bf('audio/voice/1131.m4a', 'm4a', 1490, 'voice'),
      bf('audio/voice/0005.opus', 'opus', 900, 'voice'),
      bf('audio/music/track10.opus', 'opus', 47536, 'music'),
      bf('audio/music/track02.opus', 'opus', 143917, 'music'),
      bf('audio/sfx/090.opus', 'opus', 2800, 'sfx'),
    ];
    const out = audioEntries(
      files,
      (kind) => (kind === 'music' ? { sampleRate: 44100, channels: 2 } : { sampleRate: 22050, channels: 1 }),
      (id) => (id === 1131 ? 3 : undefined),
    );
    const by = new Map(out.map((o) => [o.key, o]));
    expect(by.get('voice.1131')!.entry).toMatchObject({
      group: 'audio.voice.char.3',
      durationMs: 1490,
      files: { opus: 'audio/voice/1131.opus', m4a: 'audio/voice/1131.m4a' },
      loop: null,
    });
    expect(by.get('voice.0005')!.group).toBe('audio.voice.system');
    expect(by.get('music.track10')!.entry).toMatchObject({ loop: { startMs: 0, endMs: 47536 }, channels: 2 });
    expect(by.get('music.track02')!.entry).toMatchObject({ loop: null });
    expect(by.get('sfx.090')!.group).toBe('audio.sfx');
    expect(parseAudioFileKey('audio/music/track13.m4a')).toEqual({ kind: 'music', id: 13 });
    expect(parseAudioFileKey('data/voice-map.json')).toBeNull();
  });
});
