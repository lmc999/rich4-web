// 公开房间列表（lobby:list）：按需刷新，点击加入或观战
import type { PublicRoomSummary } from '@rich4/shared/net';
import { type ReactNode, useState } from 'react';
import { useClient } from '../../app/services';
import { useTx } from '../../i18n/tx';
import c from '../common/common.module.css';
import l from './lobby.module.css';

export function PublicRooms({ onJoin }: { onJoin(code: string, watch: boolean): void }): ReactNode {
  const t = useTx();
  const client = useClient();
  const [rooms, setRooms] = useState<PublicRoomSummary[] | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async (): Promise<void> => {
    setBusy(true);
    const r = await client.listPublicRooms();
    setBusy(false);
    setRooms(r.ok ? r.data.rooms : []);
  };

  return (
    <details
      className={l.publicRooms}
      onToggle={(e) => (e.currentTarget.open && rooms === null ? void refresh() : undefined)}
    >
      <summary data-testid="public-rooms-toggle">{t('lobby:public.title')}</summary>
      <div className={c.row} style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn--sm btn--cream" onClick={() => void refresh()} disabled={busy}>
          {t('lobby:public.refresh')}
        </button>
      </div>
      {rooms !== null && rooms.length === 0 && <p className={c.muted}>{t('lobby:public.empty')}</p>}
      <ul className={l.roomList}>
        {(rooms ?? []).map((r) => (
          <li key={r.code} data-testid={`public-room-${r.code}`}>
            <span className="num">{r.code}</span>
            <span>{r.hostName}</span>
            <span>{t(`lobby:maps.${r.mapId}`, { defaultValue: r.mapId })}</span>
            <span>{t(`lobby:phase.${r.phase}`)}</span>
            <span className="num">
              {r.humans}+{r.ais}
            </span>
            {r.phase === 'lobby' && r.humans + r.ais < 4 && (
              <button type="button" className="btn btn--sm btn--blue" onClick={() => onJoin(r.code, false)}>
                {t('lobby:public.join')}
              </button>
            )}
            {r.allowSpectators && (
              <button type="button" className="btn btn--sm btn--cream" onClick={() => onJoin(r.code, true)}>
                {t('lobby:public.watch')}
              </button>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
