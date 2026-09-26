// 观战者名单（design/client.md §5.6）：人数与昵称，房主可以请出
import type { RoomView } from '@rich4/shared/net';
import type { ReactNode } from 'react';
import { useClient } from '../../app/services';
import { useTx } from '../../i18n/tx';
import { useRun } from '../lobby/SeatGrid';
import s from './social.module.css';

export function SpectatorList({ room }: { room: RoomView }): ReactNode {
  const t = useTx();
  const client = useClient();
  const run = useRun();
  const host = room.you.isHost;
  return (
    <section className={s.specs} data-testid="spectator-list">
      <h3>
        👁 {t('hud:spectators.title')} <span className="num">{room.spectators.length}</span>
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
    </section>
  );
}
