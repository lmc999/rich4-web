// 观战栏（design/client.md §5.6、net.md §9）：观战人数与名单、「跟随：某玩家」镜头切换（对局中）；
// 房主可以请出观战者、开关观战、设置观战者聊天范围（对局中 room:updateSettings 只允许改这两项）。
import type { SeatIndex } from '@rich4/shared/engine';
import type { RoomView, SpectatorChat } from '@rich4/shared/net';
import type { ReactNode } from 'react';
import { useClient } from '../../app/services';
import { useTx } from '../../i18n/tx';
import { seatDisplayName } from '../../store/roomStore';
import { useUiStore } from '../../store/uiStore';
import { useRun } from '../lobby/SeatGrid';
import s from './social.module.css';

const SPECTATOR_CHAT: readonly SpectatorChat[] = ['all', 'spectators', 'off'];

/** 跟随切换：null = 自动跟随当前行动者（写 uiStore.followSeat，棋盘镜头据此跟随） */
function FollowSwitch({ room }: { room: RoomView }): ReactNode {
  const t = useTx();
  const follow = useUiStore((st) => st.followSeat);
  const seats = room.seats.filter((x) => x.occupant !== null);
  return (
    <label className={s.follow}>
      <span>🎥 {t('ui:social.follow')}</span>
      <select
        className="select"
        value={follow === null ? 'auto' : String(follow)}
        onChange={(e) =>
          useUiStore.getState().setFollowSeat(e.target.value === 'auto' ? null : (Number(e.target.value) as SeatIndex))
        }
        data-testid="follow-select"
      >
        <option value="auto">{t('ui:social.followAuto')}</option>
        {seats.map((x) => (
          <option key={x.index} value={x.index}>
            {x.index + 1}P {seatDisplayName(room, x.index) ?? ''}
          </option>
        ))}
      </select>
    </label>
  );
}

export function SpectatorList({ room }: { room: RoomView }): ReactNode {
  const t = useTx();
  const client = useClient();
  const run = useRun();
  const host = room.you.isHost;
  const inGame = room.phase !== 'lobby';
  return (
    <section className={s.specs} data-testid="spectator-list">
      <h3>
        👁 {t('hud:spectators.title')}{' '}
        <span className="num" data-testid="spectator-count" data-value={room.spectators.length}>
          {room.spectators.length}
        </span>
        {!room.settings.allowSpectators && <span className={s.tag}>{t('hud:spectators.disabled')}</span>}
      </h3>
      {room.spectators.length === 0 ? (
        <p className={s.empty}>{t('hud:spectators.none')}</p>
      ) : (
        <ul>
          {room.spectators.map((sp) => (
            <li key={sp.id} data-testid={`spectator-${sp.id}`}>
              <span>{sp.nickname}</span>
              {room.you.role === 'spectator' && room.you.id === sp.id && (
                <span className={s.tag}>{t('hud:spectators.you')}</span>
              )}
              {host && (
                <button
                  type="button"
                  className="btn btn--sm btn--cream"
                  onClick={() => void run(client.kick({ spectatorId: sp.id }))}
                  data-testid={`spectator-kick-${sp.id}`}
                >
                  {t('hud:spectators.kick')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {inGame && <FollowSwitch room={room} />}
      {host && (
        <details className={s.hostOpts} data-testid="spectator-host-opts">
          <summary>⚙ {t('ui:social.hostOptions')}</summary>
          <label className={s.check}>
            <input
              type="checkbox"
              checked={room.settings.allowSpectators}
              onChange={(e) => void run(client.updateSettings({ allowSpectators: e.target.checked }))}
              data-testid="spectators-allow"
            />
            <span>{t('ui:social.allowSpectators')}</span>
          </label>
          <label className={s.follow}>
            <span>{t('ui:social.spectatorChat')}</span>
            <select
              className="select"
              value={room.settings.spectatorChat}
              onChange={(e) => void run(client.updateSettings({ spectatorChat: e.target.value as SpectatorChat }))}
              data-testid="spectator-chat-mode"
            >
              {SPECTATOR_CHAT.map((m) => (
                <option key={m} value={m}>
                  {t(`ui:social.spectatorChatMode.${m}`)}
                </option>
              ))}
            </select>
          </label>
        </details>
      )}
    </section>
  );
}
