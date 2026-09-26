/**
 * 12 名角色的数据表与 AI 特质解析（architecture §5.11；design/minigames-ai.md §8.3）。
 * 真人之间没有能力差异；角色的唯一差别是电脑 AI 的性格参数（开局现金比例只作用于电脑座位）。
 *
 * @source exe v3.11 角色表 VA 0x47e80c，12 × 0x68 字节（design/engine.md §18 A.3）
 * @source docs/research/r_minigames_chars.md §2.2（个性、借贷 / 现金 / 炒股比例、代表色、性别）
 * @source docs/research/g_arbitration.md §2.h（电脑现金比例 50/40/70/60/40/70/50/40/60/50/55/80）
 * @verify extract:characters[id]（V-E2）
 */
import type { Sourced, Src } from '../source';
import {
  AI_PRESET_PERSONALITY,
  type AiTraits,
  CHARACTER_IDS,
  CHARACTER_KEYS,
  type CharacterId,
  type Personality,
  type SeatAiConfig,
} from './ids';

export type Gender = 'm' | 'f';

export interface CharacterDef extends Sourced {
  id: CharacterId;
  key: string;
  gender: Gender;
  /** 0 乖宝宝、1 普通人、2 大老奸 */
  personality: Personality;
  /** AI 借贷比例（0..100） */
  loanRatio: number;
  /** 电脑开局现金比例（0..100），其余进存款 */
  cashRatio: number;
  /** AI 炒股比例（0..100） */
  stockRatio: number;
  /** 代表色 #rrggbb（地块归属色边、侧栏色条） */
  color: string;
}

const CHARACTER_TABLE_VA = 0x47e80c;
const CHARACTER_ROW_BYTES = 0x68;

/** [性别, 个性, 借贷%, 现金%, 炒股%, 代表色]，下标 = 角色号 */
const ROWS: readonly (readonly [Gender, Personality, number, number, number, string])[] = [
  ['m', 2, 60, 50, 30, '#946126'], // 0 约翰乔
  ['m', 1, 100, 40, 45, '#bdc3c6'], // 1 沙隆巴斯
  ['m', 2, 0, 70, 0, '#41323b'], // 2 忍太郎
  ['f', 2, 100, 60, 30, '#c626c3'], // 3 钱夫人
  ['m', 1, 50, 40, 25, '#c5b830'], // 4 阿土伯
  ['f', 1, 75, 70, 30, '#ed9d9d'], // 5 莎拉公主
  ['m', 1, 100, 50, 20, '#00f038'], // 6 宫本宝藏
  ['f', 0, 0, 40, 35, '#ffffa0'], // 7 糖糖
  ['f', 0, 0, 60, 20, '#e77c08'], // 8 乌咪
  ['f', 0, 50, 50, 0, '#cc1a20'], // 9 孙小美
  ['m', 1, 30, 55, 15, '#2017fe'], // 10 小丹尼
  ['f', 2, 80, 80, 0, '#0ebdbd'], // 11 金贝贝（女婴）
];

function characterSrc(id: CharacterId): Src[] {
  return [
    { exe: '3.11', va: `0x${(CHARACTER_TABLE_VA + id * CHARACTER_ROW_BYTES).toString(16)}` },
    { research: 'docs/research/r_minigames_chars.md §2.2' },
    { research: 'docs/research/g_arbitration.md §2.h' },
    { verify: `extract:characters[${id}]` },
  ];
}

/** 下标 = 角色号 */
export const CHARACTERS: readonly CharacterDef[] = Object.freeze(
  CHARACTER_IDS.map((id): CharacterDef => {
    const [gender, personality, loanRatio, cashRatio, stockRatio, color] = ROWS[id]!;
    return Object.freeze({
      id,
      key: CHARACTER_KEYS[id],
      gender,
      personality,
      loanRatio,
      cashRatio,
      stockRatio,
      color,
      src: characterSrc(id),
      confidence: 'medium',
    });
  }),
);

export function characterDef(id: CharacterId): CharacterDef {
  return CHARACTERS[id]!;
}

function isRatio(x: unknown): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 100;
}

function isPersonality(x: unknown): x is Personality {
  return x === 0 || x === 1 || x === 2;
}

/**
 * 角色表 + 座位预设 → AiTraits（引擎开局时写入 PlayerState.aiTraits）。
 * - preset 只覆盖 personality（'character' 沿用角色表）；
 * - overrides 逐项覆盖，取值非法的项忽略（比例须为 0..100 的整数）。
 * 12 个角色的能力位都是 3（会用卡、会用道具），所以 useCards / useItems 默认 true。
 */
export function resolveTraits(characterId: CharacterId, cfg?: SeatAiConfig): AiTraits {
  const c = characterDef(characterId);
  const t: AiTraits = {
    personality: c.personality,
    useCards: true,
    useItems: true,
    loanRatio: c.loanRatio,
    cashRatio: c.cashRatio,
    stockRatio: c.stockRatio,
  };
  if (!cfg) return t;
  const p = AI_PRESET_PERSONALITY[cfg.preset];
  if (p !== null && p !== undefined) t.personality = p;
  const o = cfg.overrides;
  if (o) {
    if (isPersonality(o.personality)) t.personality = o.personality;
    if (typeof o.useCards === 'boolean') t.useCards = o.useCards;
    if (typeof o.useItems === 'boolean') t.useItems = o.useItems;
    if (isRatio(o.loanRatio)) t.loanRatio = o.loanRatio;
    if (isRatio(o.cashRatio)) t.cashRatio = o.cashRatio;
    if (isRatio(o.stockRatio)) t.stockRatio = o.stockRatio;
  }
  return t;
}
