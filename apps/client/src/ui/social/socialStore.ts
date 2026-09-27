// 聊天与表情的前端状态（design/client.md §5.6；net.md §9）：频道页签、屏蔽名单、发送限速窗口、表情流水，
// 以及「头顶气泡」事件总线（Pixi 角色层订阅 onHeadBubble 渲染；DOM 侧可用 useHeadBubble）。
// 数据源是 chatStore（chat:message / chat:emote 已由 GameClient 写入）；这里只做派生与过滤，不改 chatStore。
import type { SeatIndex } from '@rich4/shared/engine';
import { CHAT_RATE, type ChatSender, type EmoteMsg, isEmoteId } from '@rich4/shared/net';
import { create } from 'zustand';
import { type Bubble, emoteGlyph, useChatStore } from '../../store/chatStore';

/** 表情气泡在头顶弹跳 2 秒；聊天气泡显示 3 秒（design/client.md §5.6） */
export const EMOTE_BUBBLE_MS = 2000;
export const CHAT_BUBBLE_MS = 3000;
/** 聊天面板保留的表情流水条数 */
export const EMOTE_FEED_SIZE = 50;

export type ChatChannel = 'all' | 'spectators';

/** 发送者的屏蔽键：座位用 `seat:<n>`，观战者用 `spec:<id>`；系统消息没有键 */
export function senderKey(from: ChatSender): string | null {
  if (from.kind === 'seat') return `seat:${from.seat}`;
  if (from.kind === 'spectator') return `spec:${from.id}`;
  return null;
}

/** 头顶气泡（角色层渲染的最小载荷） */
export interface HeadBubble {
  /** 消息或表情 id（同一座位新气泡替换旧气泡） */
  id: string;
  seat: SeatIndex;
  kind: 'emote' | 'chat';
  /** kind='emote'：表情 id 与字形 */
  emoteId?: string;
  glyph?: string;
  /** kind='chat'：聊天原文（已由服务器清洗，≤200 字；渲染时自行截断） */
  text?: string;
  /** 表情可指向另一个角色（气泡飞过去） */
  targetSeat?: SeatIndex;
  /** 显示时长（真实时间 ms） */
  durationMs: number;
  /** 本地出现时间（Date.now()） */
  at: number;
}

export interface SocialState {
  channel: ChatChannel;
  /** 屏蔽名单：键 → 显示名 */
  muted: Record<string, string>;
  /** 最近的发送时间（本地，前端预检每 10 秒 5 条） */
  sentAt: number[];
  /** 表情流水（聊天面板显示；不含被屏蔽者的） */
  emotes: EmoteMsg[];
  /** 当前显示中的头顶气泡（座位 → 气泡） */
  bubbles: Partial<Record<SeatIndex, HeadBubble>>;
  setChannel(c: ChatChannel): void;
  mute(key: string, label: string): void;
  unmute(key: string): void;
  isMuted(from: ChatSender): boolean;
  /** 本地限速：可发送时记下并返回 true */
  trySend(now: number): boolean;
  pushEmote(e: EmoteMsg): void;
  showBubble(b: HeadBubble): void;
  expireBubble(seat: SeatIndex, id: string): void;
  reset(): void;
}

const initial = {
  channel: 'all' as ChatChannel,
  muted: {} as Record<string, string>,
  sentAt: [] as number[],
  emotes: [] as EmoteMsg[],
  bubbles: {} as Partial<Record<SeatIndex, HeadBubble>>,
};

/** 客户端限速：最近 windowMs 内的发送次数 < count */
export function canSendNow(sent: readonly number[], now: number): boolean {
  const recent = sent.filter((x) => now - x < CHAT_RATE.windowMs);
  return recent.length < CHAT_RATE.count;
}

export const useSocialStore = create<SocialState>()((set, get) => ({
  ...initial,
  setChannel: (channel) => set({ channel }),
  mute: (key, label) => set((s) => ({ muted: { ...s.muted, [key]: label } })),
  unmute: (key) =>
    set((s) => {
      const { [key]: _, ...rest } = s.muted;
      return { muted: rest };
    }),
  isMuted: (from) => {
    const k = senderKey(from);
    return k !== null && get().muted[k] !== undefined;
  },
  trySend: (now) => {
    const recent = get().sentAt.filter((x) => now - x < CHAT_RATE.windowMs);
    if (recent.length >= CHAT_RATE.count) {
      set({ sentAt: recent });
      return false;
    }
    set({ sentAt: [...recent, now] });
    return true;
  },
  pushEmote: (e) =>
    set((s) => (s.emotes.some((x) => x.id === e.id) ? s : { emotes: [...s.emotes, e].slice(-EMOTE_FEED_SIZE) })),
  showBubble: (b) => set((s) => ({ bubbles: { ...s.bubbles, [b.seat]: b } })),
  expireBubble: (seat, id) =>
    set((s) => {
      if (s.bubbles[seat]?.id !== id) return s;
      const next = { ...s.bubbles };
      delete next[seat];
      return { bubbles: next };
    }),
  reset: () => set({ ...initial }),
}));

// ───────────────────────── 头顶气泡事件总线 ─────────────────────────

type BubbleListener = (b: HeadBubble) => void;
const listeners = new Set<BubbleListener>();
const timers = new Map<SeatIndex, ReturnType<typeof setTimeout>>();

/**
 * 订阅头顶气泡（Pixi 角色层用）：座位上的玩家发表情或聊天时回调，已过滤掉被屏蔽的人。
 * 同一座位的新气泡应替换旧气泡；durationMs 后自行消失（也可以监听 useSocialStore.bubbles 的删除）。
 */
export function onHeadBubble(cb: BubbleListener): () => void {
  installSocialBus();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function emitBubble(b: HeadBubble): void {
  const st = useSocialStore.getState();
  st.showBubble(b);
  const old = timers.get(b.seat);
  if (old) clearTimeout(old);
  timers.set(
    b.seat,
    setTimeout(() => {
      timers.delete(b.seat);
      useSocialStore.getState().expireBubble(b.seat, b.id);
    }, b.durationMs),
  );
  for (const cb of [...listeners]) {
    try {
      cb(b);
    } catch (err) {
      console.error('[rich4] head bubble listener threw', err);
    }
  }
}

function bubbleFrom(seat: SeatIndex, b: Bubble, emote: EmoteMsg | null): HeadBubble {
  if (b.emoteId !== undefined) {
    return {
      id: b.id,
      seat,
      kind: 'emote',
      emoteId: b.emoteId,
      glyph: emoteGlyph(b.emoteId),
      ...(emote?.id === b.id && emote.targetSeat !== undefined ? { targetSeat: emote.targetSeat } : {}),
      durationMs: EMOTE_BUBBLE_MS,
      at: b.at,
    };
  }
  return { id: b.id, seat, kind: 'chat', text: b.text ?? '', durationMs: CHAT_BUBBLE_MS, at: b.at };
}

let installed = false;

function isEmptyChat(s: { messages: readonly unknown[]; lastEmote: unknown; bubbles: object }): boolean {
  return s.messages.length === 0 && s.lastEmote === null && Object.keys(s.bubbles).length === 0;
}

/** 挂接 chatStore（幂等）：表情进流水，座位上的新气泡发往总线；chatStore 清空（换房间）时一并清空 */
export function installSocialBus(): void {
  if (installed) return;
  installed = true;
  useChatStore.subscribe((s, prev) => {
    // chatStore.clear()（换房间、离开）：三者同时变空
    if (isEmptyChat(s) && !isEmptyChat(prev)) {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      useSocialStore.getState().reset();
      return;
    }
    if (s.lastEmote !== prev.lastEmote && s.lastEmote !== null) {
      if (isEmoteId(s.lastEmote.emoteId) && !useSocialStore.getState().isMuted(s.lastEmote.from)) {
        useSocialStore.getState().pushEmote(s.lastEmote);
      }
    }
    if (s.bubbles === prev.bubbles) return;
    for (const [k, b] of Object.entries(s.bubbles)) {
      const seat = Number(k) as SeatIndex;
      if (prev.bubbles[seat]?.id === b.id) continue;
      if (useSocialStore.getState().isMuted({ kind: 'seat', seat, nickname: '' })) continue;
      emitBubble(bubbleFrom(seat, b, s.lastEmote));
    }
  });
}

installSocialBus();

/** DOM 侧读取某座位当前的头顶气泡（过期后为 null） */
export function useHeadBubble(seat: SeatIndex): HeadBubble | null {
  return useSocialStore((s) => s.bubbles[seat] ?? null);
}
