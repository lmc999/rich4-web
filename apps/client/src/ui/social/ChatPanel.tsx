// 聊天（design/client.md §5.6，限制按 net §9：单条 ≤200 字、每 10 秒 5 条）：消息列表、系统消息本地化、表情。
import { CHAT_MAX_CHARS, CHAT_RATE, type ChatMessage, type RoomView, sanitizeChatText } from '@rich4/shared/net';
import clsx from 'clsx';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { useClient } from '../../app/services';
import { type LooseT, useTx } from '../../i18n/tx';
import { systemText } from '../../presentation/systemText';
import { useChatStore } from '../../store/chatStore';
import { useUiStore } from '../../store/uiStore';
import { SeatMark } from '../common/Avatar';
import { EmotePicker } from './EmotePicker';
import s from './social.module.css';

/** 客户端限速：最近 windowMs 内的发送时间 */
export function canSendNow(sent: readonly number[], now: number): boolean {
  const recent = sent.filter((x) => now - x < CHAT_RATE.windowMs);
  return recent.length < CHAT_RATE.count;
}

function Line({ m, t }: { m: ChatMessage; t: LooseT }): ReactNode {
  if (m.system) {
    return (
      <li className={s.system} data-testid="chat-msg" data-kind="system" data-key={m.system.key}>
        {systemText(t, m)}
      </li>
    );
  }
  const f = m.from;
  return (
    <li className={clsx(s.line, m.audience === 'spectators' && s.spec)} data-testid="chat-msg" data-kind={f.kind}>
      <span className={s.who}>
        {f.kind === 'seat' && <SeatMark seat={f.seat} />}
        {f.kind === 'spectator' && <span aria-hidden="true">👁</span>}
        {f.kind === 'system' ? '' : f.nickname}
        {m.audience === 'spectators' && <span className={s.tag}>{t('hud:chat.spectatorTag')}</span>}
      </span>
      <span className={s.text}>{m.text}</span>
    </li>
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
  const [text, setText] = useState('');
  const sentRef = useRef<number[]>([]);
  const listRef = useRef<HTMLUListElement>(null);
  const disabled = room.you.role === 'spectator' && room.settings.spectatorChat === 'off';

  useEffect(() => {
    useChatStore.getState().setVisible(visible);
    return () => useChatStore.getState().setVisible(false);
  }, [visible]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 新消息进来时滚到底
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const send = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const clean = sanitizeChatText(text);
    if (!clean) return;
    const now = Date.now();
    if (!canSendNow(sentRef.current, now)) {
      useUiStore.getState().toast(t('hud:chat.tooFast'), 'warn');
      return;
    }
    sentRef.current = [...sentRef.current.filter((x) => now - x < CHAT_RATE.windowMs), now];
    setText('');
    const r = await client.chat(clean);
    if (!r.ok) useUiStore.getState().toast(client.errorText(r.error), 'warn');
  };

  return (
    <section className={clsx(s.chat, className)} data-testid="chat-panel" aria-label={t('hud:chat.title')}>
      <ul className={s.list} ref={listRef} aria-live="polite">
        {messages.map((m) => (
          <Line key={m.id} m={m} t={t} />
        ))}
      </ul>
      <form className={s.form} onSubmit={(e) => void send(e)}>
        <input
          className="input"
          value={text}
          maxLength={CHAT_MAX_CHARS}
          placeholder={disabled ? t('hud:chat.disabled') : t('hud:chat.placeholder')}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          aria-label={t('hud:chat.placeholder')}
          data-testid="chat-input"
        />
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
    </section>
  );
}
