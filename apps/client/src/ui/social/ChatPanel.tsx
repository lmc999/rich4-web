// 聊天（design/client.md §5.6，限制按 net §9：单条 ≤200 字、每 10 秒 5 条，前端预检后服务器再校验）：
// 「全部 / 观战」两个频道页签（观战页只看观战者的发言与表情）、系统消息本地化、表情流水、8 条快捷语、屏蔽某人。
// 协议里 chat:send 不带频道：观战者的消息发给谁由房间设置 spectatorChat 决定，输入框下方给出提示。
import {
  CHAT_MAX_CHARS,
  type ChatMessage,
  type ChatSender,
  type EmoteMsg,
  type RoomView,
  sanitizeChatText,
} from '@rich4/shared/net';
import clsx from 'clsx';
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useClient } from '../../app/services';
import { type LooseT, useTx } from '../../i18n/tx';
import { systemText } from '../../presentation/systemText';
import { emoteGlyph, useChatStore } from '../../store/chatStore';
import { useUiStore } from '../../store/uiStore';
import { SeatMark } from '../common/Avatar';
import { EmotePicker } from './EmotePicker';
import s from './social.module.css';
import { type ChatChannel, senderKey, useSocialStore } from './socialStore';

export { canSendNow } from './socialStore';

/** 快捷语条数（文案键 ui:social.quick.<i>） */
export const QUICK_PHRASE_COUNT = 8;

/** 按码点截到 CHAT_MAX_CHARS（输入框的 maxLength 按 UTF-16 计，emoji 会被算成 2） */
export function clampChatInput(v: string): string {
  const cps = Array.from(v);
  return cps.length > CHAT_MAX_CHARS ? cps.slice(0, CHAT_MAX_CHARS).join('') : v;
}

type Row = { k: 'msg'; ts: number; m: ChatMessage } | { k: 'emote'; ts: number; e: EmoteMsg };

/** 观战页：观战者发的，或只发给观战者的 */
function inSpectatorChannel(from: ChatSender, audience: 'all' | 'spectators'): boolean {
  return audience === 'spectators' || from.kind === 'spectator';
}

function isMe(room: RoomView, from: ChatSender): boolean {
  if (from.kind === 'seat') return room.you.role === 'player' && room.you.seat === from.seat;
  if (from.kind === 'spectator') return room.you.role === 'spectator' && room.you.id === from.id;
  return false;
}

function Who({ from, spec, t }: { from: ChatSender; spec: boolean; t: LooseT }): ReactNode {
  return (
    <span className={s.who}>
      {from.kind === 'seat' && <SeatMark seat={from.seat} />}
      {from.kind === 'spectator' && <span aria-hidden="true">👁</span>}
      {from.kind === 'system' ? '' : from.nickname}
      {spec && <span className={s.tag}>{t('hud:chat.spectatorTag')}</span>}
    </span>
  );
}

function MuteButton({ from, room, t }: { from: ChatSender; room: RoomView; t: LooseT }): ReactNode {
  const key = senderKey(from);
  if (key === null || from.kind === 'system' || isMe(room, from)) return null;
  const name = from.nickname;
  return (
    <button
      type="button"
      className={s.muteBtn}
      title={t('ui:social.muteTitle', { name })}
      aria-label={t('ui:social.muteTitle', { name })}
      onClick={() => {
        useSocialStore.getState().mute(key, name);
        useUiStore.getState().toast(t('ui:social.mutedToast', { name }), 'info');
      }}
      data-testid="chat-mute"
      data-key={key}
    >
      🔇
    </button>
  );
}

function Line({ row, room, t }: { row: Row; room: RoomView; t: LooseT }): ReactNode {
  if (row.k === 'emote') {
    const e = row.e;
    const spec = e.from.kind === 'spectator';
    return (
      <li
        className={clsx(s.line, s.emoteLine, spec && s.spec)}
        data-testid="chat-emote"
        data-emote={e.emoteId}
        data-kind={e.from.kind}
      >
        <Who from={e.from} spec={false} t={t} />
        <span className={s.emoteGlyph} role="img" aria-label={t(`hud:emotes.${e.emoteId}`)}>
          {emoteGlyph(e.emoteId)}
        </span>
        <MuteButton from={e.from} room={room} t={t} />
      </li>
    );
  }
  const m = row.m;
  if (m.system) {
    return (
      <li className={s.system} data-testid="chat-msg" data-kind="system" data-key={m.system.key}>
        {systemText(t, m)}
      </li>
    );
  }
  const spec = m.audience === 'spectators';
  return (
    <li
      className={clsx(s.line, spec && s.spec)}
      data-testid="chat-msg"
      data-kind={m.from.kind}
      data-audience={m.audience}
    >
      <Who from={m.from} spec={spec} t={t} />
      <span className={s.text}>{m.text}</span>
      <MuteButton from={m.from} room={room} t={t} />
    </li>
  );
}

function MutedBar({ t }: { t: LooseT }): ReactNode {
  const muted = useSocialStore((st) => st.muted);
  const [open, setOpen] = useState(false);
  const entries = Object.entries(muted);
  if (entries.length === 0) return null;
  return (
    <div className={s.mutedBar} data-testid="chat-muted">
      <button type="button" className={s.linkBtn} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        🔇 {t('ui:social.mutedN', { n: entries.length })}
      </button>
      {open && (
        <ul className={s.mutedList}>
          {entries.map(([k, name]) => (
            <li key={k}>
              <span>{name}</span>
              <button
                type="button"
                className="btn btn--sm btn--cream"
                onClick={() => useSocialStore.getState().unmute(k)}
                data-testid={`chat-unmute-${k}`}
              >
                {t('ui:social.unmute')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export interface ChatPanelProps {
  room: RoomView;
  className?: string;
  /** 面板可见（可见时清未读） */
  visible?: boolean;
}

export function ChatPanel({ room, className, visible = true }: ChatPanelProps): ReactNode {
  const t = useTx();
  const client = useClient();
  const messages = useChatStore((st) => st.messages);
  const emotes = useSocialStore((st) => st.emotes);
  const muted = useSocialStore((st) => st.muted);
  const channel = useSocialStore((st) => st.channel);
  const [text, setText] = useState('');
  const [quickOpen, setQuickOpen] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const spectator = room.you.role === 'spectator';
  const disabled = spectator && room.settings.spectatorChat === 'off';
  const length = Array.from(text).length;

  useEffect(() => {
    useChatStore.getState().setVisible(visible);
    return () => useChatStore.getState().setVisible(false);
  }, [visible]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    const hidden = (from: ChatSender): boolean => {
      const k = senderKey(from);
      return k !== null && muted[k] !== undefined;
    };
    for (const m of messages) {
      if (!m.system && hidden(m.from)) continue;
      if (channel === 'spectators' && (m.system || !inSpectatorChannel(m.from, m.audience))) continue;
      out.push({ k: 'msg', ts: m.ts, m });
    }
    for (const e of emotes) {
      if (hidden(e.from)) continue;
      if (channel === 'spectators' && e.from.kind !== 'spectator') continue;
      out.push({ k: 'emote', ts: e.ts, e });
    }
    // 服务器时间戳排序；同一毫秒保持到达顺序（sort 是稳定的）
    return out.sort((a, b) => a.ts - b.ts);
  }, [messages, emotes, muted, channel]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 新消息进来时滚到底
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rows.length]);

  /** 发送（前端预检：清洗后非空、每 10 秒 5 条）；通过预检时先回调 onAccepted（清空输入框） */
  const sendText = async (raw: string, onAccepted?: () => void): Promise<void> => {
    const clean = sanitizeChatText(raw);
    if (!clean || disabled) return;
    if (!useSocialStore.getState().trySend(Date.now())) {
      // 被限速时保留输入，稍后可再发
      useUiStore.getState().toast(t('hud:chat.tooFast'), 'warn');
      return;
    }
    onAccepted?.();
    const r = await client.chat(clean);
    if (!r.ok) useUiStore.getState().toast(client.errorText(r.error), 'warn');
  };

  const send = (e: FormEvent): void => {
    e.preventDefault();
    void sendText(text, () => setText(''));
  };

  const setCh = (c: ChatChannel): void => useSocialStore.getState().setChannel(c);
  const audienceHint = spectator
    ? room.settings.spectatorChat === 'spectators'
      ? t('ui:social.audienceSpectators')
      : room.settings.spectatorChat === 'all'
        ? t('ui:social.audienceAll')
        : null
    : null;

  return (
    <section className={clsx(s.chat, className)} data-testid="chat-panel" aria-label={t('hud:chat.title')}>
      <div className={s.tabs} role="tablist" aria-label={t('hud:chat.title')}>
        {(['all', 'spectators'] as const).map((c) => (
          <button
            key={c}
            type="button"
            role="tab"
            aria-selected={channel === c}
            className={clsx(s.tab, channel === c && s.tabOn)}
            onClick={() => setCh(c)}
            data-testid={`chat-tab-${c}`}
          >
            {c === 'all' ? t('ui:social.tabAll') : `👁 ${t('ui:social.tabSpectators')}`}
          </button>
        ))}
      </div>
      <MutedBar t={t} />
      <ul className={s.list} ref={listRef} aria-live="polite" data-testid="chat-list" data-channel={channel}>
        {rows.map((r) => (
          <Line key={r.k === 'msg' ? r.m.id : `e:${r.e.id}`} row={r} room={room} t={t} />
        ))}
        {rows.length === 0 && channel === 'spectators' && (
          <li className={s.system}>{t('ui:social.emptySpectators')}</li>
        )}
      </ul>
      <form className={s.form} onSubmit={send}>
        <div className={s.inputWrap}>
          <input
            className="input"
            value={text}
            placeholder={disabled ? t('hud:chat.disabled') : t('hud:chat.placeholder')}
            disabled={disabled}
            onChange={(e) => setText(clampChatInput(e.target.value))}
            aria-label={t('hud:chat.placeholder')}
            aria-describedby="chat-count"
            data-testid="chat-input"
          />
          <span
            id="chat-count"
            className={clsx(s.count, length >= CHAT_MAX_CHARS && s.countFull)}
            data-testid="chat-count"
            data-value={length}
          >
            {length}/{CHAT_MAX_CHARS}
          </span>
        </div>
        <span className={s.emoteWrap}>
          <button
            type="button"
            className="btn btn--sm btn--cream"
            onClick={() => setQuickOpen((v) => !v)}
            aria-expanded={quickOpen}
            aria-label={t('ui:social.quick')}
            title={t('ui:social.quick')}
            disabled={disabled}
            data-testid="chat-quick-open"
          >
            💬
          </button>
          {quickOpen && (
            <div className={s.quickMenu} role="menu" data-testid="chat-quick">
              {Array.from({ length: QUICK_PHRASE_COUNT }, (_, i) => {
                const phrase = t(`ui:social.quickPhrases.${i}`);
                return (
                  <button
                    // biome-ignore lint/suspicious/noArrayIndexKey: 快捷语顺序固定
                    key={i}
                    type="button"
                    role="menuitem"
                    className={s.quickBtn}
                    onClick={() => {
                      setQuickOpen(false);
                      void sendText(phrase);
                    }}
                    data-testid={`chat-quick-${i}`}
                  >
                    {phrase}
                  </button>
                );
              })}
            </div>
          )}
        </span>
        <EmotePicker disabled={disabled} />
        <button
          type="submit"
          className="btn btn--sm btn--blue"
          disabled={disabled || text.trim() === ''}
          data-testid="chat-send"
        >
          {t('hud:chat.send')}
        </button>
      </form>
      {audienceHint && (
        <p className={s.hint} data-testid="chat-audience">
          {audienceHint}
        </p>
      )}
    </section>
  );
}
