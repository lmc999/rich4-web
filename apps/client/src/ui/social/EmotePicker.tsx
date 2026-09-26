// 表情（design/client.md §5.6）：16 个表情 4×4，发出后在该玩家角色头顶弹出（冷却 1.5 秒，与服务器一致）
import { EMOTE_COOLDOWN_MS } from '@rich4/shared/net';
import { type ReactNode, useRef, useState } from 'react';
import { useClient } from '../../app/services';
import { useTx } from '../../i18n/tx';
import { EMOTES } from '../../store/chatStore';
import { useUiStore } from '../../store/uiStore';
import s from './social.module.css';

export function EmotePicker({ disabled }: { disabled?: boolean }): ReactNode {
  const t = useTx();
  const client = useClient();
  const [open, setOpen] = useState(false);
  const last = useRef(0);

  const send = async (id: string): Promise<void> => {
    const now = Date.now();
    if (now - last.current < EMOTE_COOLDOWN_MS) {
      useUiStore.getState().toast(t('hud:chat.tooFast'), 'warn');
      return;
    }
    last.current = now;
    setOpen(false);
    const r = await client.emote(id);
    if (!r.ok) useUiStore.getState().toast(client.errorText(r.error), 'warn');
  };

  return (
    <span className={s.emoteWrap}>
      <button
        type="button"
        className="btn btn--sm btn--cream"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={t('hud:chat.emote')}
        disabled={disabled}
        data-testid="emote-open"
      >
        😀
      </button>
      {open && (
        <div className={s.emoteGrid} role="menu" data-testid="emote-picker">
          {EMOTES.map((e) => (
            <button
              key={e.id}
              type="button"
              role="menuitem"
              className={s.emoteBtn}
              title={t(`hud:emotes.${e.id}`)}
              aria-label={t(`hud:emotes.${e.id}`)}
              onClick={() => void send(e.id)}
              data-testid={`emote-${e.id}`}
            >
              {e.glyph}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
