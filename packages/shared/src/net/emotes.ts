/**
 * 表情表（design/net.md §9；design/client.md §5.6「16 个表情」）。
 * chat:emote 的 emoteId 必须在此表中；前端按 id 取图标与文案（i18n 键 `emotes.<id>`），可以配角色语音。
 * 顺序即表情面板的排列顺序；只可追加，不可改名或删除（历史聊天记录与客户端缓存按 id 引用）。
 */

export const EMOTE_IDS = Object.freeze([
  'smile',
  'laugh',
  'cry',
  'angry',
  'shock',
  'cool',
  'love',
  'sweat',
  'think',
  'sleepy',
  'thumbsUp',
  'clap',
  'money',
  'broke',
  'bomb',
  'lucky',
] as const);

export type EmoteId = (typeof EMOTE_IDS)[number];

/** 表情数量（UI 面板 4×4） */
export const EMOTE_COUNT = EMOTE_IDS.length;

const EMOTE_SET: ReadonlySet<string> = new Set(EMOTE_IDS);

export function isEmoteId(x: unknown): x is EmoteId {
  return typeof x === 'string' && EMOTE_SET.has(x);
}
