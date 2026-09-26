// 聊天与表情（design/client.md §5.6；net.md §9）：chat:history 整体替换，chat:message 追加，chat:emote 记为头顶气泡。
import type { ChatMessage, EmoteMsg } from '@rich4/shared/net';
import { CHAT_HISTORY_SIZE, EMOTE_IDS, type EmoteId, isEmoteId } from '@rich4/shared/net';
import { create } from 'zustand';

/** 头顶气泡：座位 → 最近一次表情或聊天 */
export interface Bubble {
  id: string;
  emoteId?: string;
  text?: string;
  /** 本地时间戳，显示 2–3 秒 */
  at: number;
}

export interface ChatState {
  messages: ChatMessage[];
  unread: number;
  /** 聊天面板是否可见（可见时不累计未读） */
  visible: boolean;
  bubbles: Record<number, Bubble>;
  lastEmote: EmoteMsg | null;
  setHistory(ms: ChatMessage[]): void;
  add(m: ChatMessage): void;
  emote(e: EmoteMsg): void;
  setVisible(v: boolean): void;
  clear(): void;
}

export const useChatStore = create<ChatState>()((set, get) => ({
  messages: [],
  unread: 0,
  visible: false,
  bubbles: {},
  lastEmote: null,
  setHistory: (messages) => set({ messages: messages.slice(-CHAT_HISTORY_SIZE), unread: 0 }),
  add: (m) => {
    if (get().messages.some((x) => x.id === m.id)) return;
    set((s) => {
      const bubbles =
        m.from.kind === 'seat' && m.text
          ? { ...s.bubbles, [m.from.seat]: { id: m.id, text: m.text, at: Date.now() } }
          : s.bubbles;
      return {
        messages: [...s.messages, m].slice(-CHAT_HISTORY_SIZE),
        unread: s.visible || m.system ? s.unread : s.unread + 1,
        bubbles,
      };
    });
  },
  emote: (e) =>
    set((s) => ({
      lastEmote: e,
      bubbles:
        e.from.kind === 'seat'
          ? { ...s.bubbles, [e.from.seat]: { id: e.id, emoteId: e.emoteId, at: Date.now() } }
          : s.bubbles,
    })),
  setVisible: (visible) => set((s) => ({ visible, unread: visible ? 0 : s.unread })),
  clear: () => set({ messages: [], unread: 0, bubbles: {}, lastEmote: null }),
}));

/** 表情图标（emoteId 取自 shared/net/emotes.ts 的 EMOTE_IDS，文案键 hud:emotes.<id>） */
export const EMOTE_GLYPHS: { readonly [K in EmoteId]: string } = {
  smile: '😊',
  laugh: '😂',
  cry: '😭',
  angry: '😠',
  shock: '😱',
  cool: '😎',
  love: '😍',
  sweat: '😅',
  think: '🤔',
  sleepy: '😴',
  thumbsUp: '👍',
  clap: '👏',
  money: '💰',
  broke: '💸',
  bomb: '💣',
  lucky: '🍀',
};

export const EMOTES: readonly { id: EmoteId; glyph: string }[] = EMOTE_IDS.map((id) => ({
  id,
  glyph: EMOTE_GLYPHS[id],
}));

export function emoteGlyph(id: string): string {
  return isEmoteId(id) ? EMOTE_GLYPHS[id] : '💬';
}
