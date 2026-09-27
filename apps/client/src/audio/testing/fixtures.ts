// 测试用合成映射表（自拟逻辑键，不含任何原版内容）：每个槽位的键可推算，部分槽位有多条候选以测确定性选择。
import {
  ASSET_SCHEMA,
  CHARACTER_COUNT,
  MUSIC_SCENES,
  type MusicMapV1,
  type SfxSetsV1,
  VOICE_CARD_COUNT,
  VOICE_ITEM_COUNT,
  VOICE_SLOT_COUNT,
  type VoiceLine,
  type VoiceMapV1,
} from '@rich4/shared/assets';
import type { AudioMaps } from '../sources';

const line = (key: string, confidence: VoiceLine['confidence'] = 'visual'): VoiceLine => ({
  key,
  text: null,
  confidence,
});

/** 槽位键：voice.c<角色>.s<槽>[.v<变体>]；槽 15（buildLevel5）有 3 条候选 */
export const slotKey = (c: number, slot: number, v?: number) =>
  v === undefined ? `voice.c${c}.s${slot}` : `voice.c${c}.s${slot}.v${v}`;
export const cardKey = (c: number, mode: string, card: number) => `voice.c${c}.card.${mode}.${card}`;
export const itemKey = (c: number, item: number) => `voice.c${c}.item.${item}`;

export const MULTI_SLOT = 15;

export function testVoiceMap(): VoiceMapV1 {
  const npcNames = ['lottery.winnerName', 'month.championName', 'month.loserName', 'auction.winnerName'];
  const npc: Record<string, VoiceLine[]> = {};
  for (const k of [
    'bank.loanDone',
    'bank.repayDone',
    'itemShop.welcome',
    'magic.chant',
    'lottery.draw.winnerIs',
    'lottery.draw.noWinner',
    'auction.open',
    'auction.sold',
    'auction.noBid',
    'month.championIs',
    'month.loserIs',
    'rescue.thanks',
  ]) {
    npc[k] = [line(`voice.npc.${k.replace(/\./g, '-')}`)];
  }
  for (let i = 0; i < 12; i++) npc[`magic.condition.${i}`] = [line(`voice.npc.magic-cond-${i}`)];
  for (const n of npcNames) {
    for (let c = 0; c < CHARACTER_COUNT; c++) npc[`${n}.${c}`] = [line(`voice.npc.${n.replace(/\./g, '-')}-${c}`)];
  }
  const news: Record<string, VoiceLine[]> = {};
  for (let i = 0; i < 36; i++) news[`news.${i}`] = [line(`voice.news.${i}`)];
  for (let i = 0; i < 49; i++) news[`fate.${i}`] = [line(`voice.fate.${i}`)];
  return {
    schema: ASSET_SCHEMA.voiceMap,
    characters: Array.from({ length: CHARACTER_COUNT }, (_, c) => ({
      slots: Array.from({ length: VOICE_SLOT_COUNT }, (_, s) =>
        s === MULTI_SLOT
          ? [0, 1, 2].map((v) => line(slotKey(c, s, v)))
          : [line(slotKey(c, s), s >= 3 && s <= 5 ? 'guess' : 'visual')],
      ),
      itemLines: Array.from({ length: VOICE_ITEM_COUNT }, (_, i) => [line(itemKey(c, i + 1), 'exe')]),
      itemReactions: {
        hitRoadblock: [line(`voice.c${c}.react.roadblock`)],
        // 角色 1 没有踩地雷台词（测 orElse）
        hitMine: c === 1 ? [] : [line(`voice.c${c}.react.mine`)],
        bombAttached: [line(`voice.c${c}.react.bomb`, 'guess')],
      },
      cardLines: {
        use: Array.from({ length: VOICE_CARD_COUNT }, (_, i) => [line(cardKey(c, 'use', i + 1), 'exe')]),
        // 只有卡 6、7 有「对自己」台词
        self: Array.from({ length: VOICE_CARD_COUNT }, (_, i) =>
          i === 5 || i === 6 ? [line(cardKey(c, 'self', i + 1))] : [],
        ),
        target: Array.from({ length: VOICE_CARD_COUNT }, (_, i) =>
          i % 2 === 1 ? [line(cardKey(c, 'target', i + 1))] : [],
        ),
      },
    })),
    npc,
    news,
    src: [],
  };
}

export function testSfxSets(): SfxSetsV1 {
  const set = (sfx: string[], confidence: 'exe' | 'visual' | 'guess') => ({ sfx, confidence, src: [] });
  return {
    schema: ASSET_SCHEMA.sfxSets,
    sets: {
      global: set(['sfx.000', 'sfx.001'], 'exe'),
      board: set(['sfx.044', 'sfx.049', 'sfx.050'], 'exe'),
      'cue.land.buy': set(['sfx.049'], 'exe'),
      'cue.land.build': set(['sfx.050'], 'exe'),
      'cue.gain.points': set(['sfx.036'], 'exe'),
      'cue.move.walk': set(['sfx.044'], 'guess'),
      'cue.stock.trade': set(['sfx.040', 'sfx.041'], 'guess'),
      'cue.status.skipTurn': set(['sfx.056'], 'guess'),
      'cue.ui.click': set(['sfx.001'], 'guess'),
    },
    src: [],
  };
}

export function testMusicMap(): MusicMapV1 {
  const scenes: MusicMapV1['scenes'] = {};
  MUSIC_SCENES.forEach((s, i) => {
    scenes[s] = { key: `music.scene-${s}`, track: 10 + i, confidence: 'exe' };
  });
  return {
    schema: ASSET_SCHEMA.musicMap,
    board: [0, 1, 2].map((i) => ({ key: `music.board-${i}`, track: i + 2, confidence: 'exe' as const })),
    scenes,
    src: [],
  };
}

export function testAudioMaps(): AudioMaps {
  return { voiceMap: testVoiceMap(), sfxSets: testSfxSets(), musicMap: testMusicMap() };
}
