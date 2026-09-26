// 房间大厅（design/client.md §5.5）：座位、选角、邀请、设置（房主可改）、准备 / 开始、观战者、聊天。
import type { RoomView } from '@rich4/shared/net';
import { type ReactNode, useEffect, useState } from 'react';
import { useClient } from '../../app/services';
import { useTx } from '../../i18n/tx';
import { canStart, mySeatView } from '../../store/roomStore';
import c from '../common/common.module.css';
import { ChatPanel } from '../social/ChatPanel';
import { SpectatorList } from '../social/SpectatorList';
import { SaveLoadMenu } from '../system/SaveLoadMenu';
import { CharacterPicker } from './CharacterPicker';
import { InviteLink } from './InviteLink';
import l from './lobby.module.css';
import { RoomSettingsFields } from './RoomSettingsFields';
import { SeatGrid, useRun } from './SeatGrid';
import { draftFromSettings, draftToPatch, fetchMapList, type MapListingLite } from './settingsDraft';

function SettingsBox({ room }: { room: RoomView }): ReactNode {
  const t = useTx();
  const client = useClient();
  const run = useRun();
  const host = room.you.isHost;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => draftFromSettings(room.settings));
  const [maps, setMaps] = useState<MapListingLite[]>([]);

  useEffect(() => {
    if (!editing) setDraft(draftFromSettings(room.settings));
  }, [room.settings, editing]);

  useEffect(() => {
    if (!editing) return;
    let stale = false;
    void fetchMapList().then((r) => !stale && setMaps(r.maps));
    return () => {
      stale = true;
    };
  }, [editing]);

  const g = room.settings.game;
  const rows: [string, string][] = [
    [t('lobby:settings.map'), t(`lobby:maps.${g.mapId}`, { defaultValue: g.mapId })],
    [t('lobby:settings.fund'), t('lobby:settings.fundValue', { n: g.initialFund / 10000 })],
    [t('lobby:settings.vehicle'), t(`lobby:vehicle.${g.vehicle}`)],
    [t('lobby:settings.tenure'), t(`lobby:tenure.${g.tenure}`)],
    [t('lobby:settings.timeLimit'), t(`lobby:timeLimit.${g.timeLimitDays}`)],
    [
      t('lobby:settings.win'),
      g.winMultiple === 0 ? t('lobby:win.none') : t('lobby:win.multiple', { n: g.winMultiple }),
    ],
    [
      t('lobby:settings.rules'),
      t(`lobby:rules.${g.rules.preset === 'manual' ? 'manual' : g.rules.preset === 'custom' ? 'custom' : 'program'}`),
    ],
    [t('lobby:settings.timer'), t(`lobby:timer.${room.settings.timerPreset}`)],
    [t('lobby:settings.visibility'), t(`lobby:visibility.${room.settings.visibility}`)],
    [t('lobby:settings.spectators'), room.settings.allowSpectators ? t('lobby:yes') : t('lobby:no')],
  ];

  return (
    <section className={`panel ${l.settingsBox}`} data-testid="room-settings">
      <h2>{t('lobby:room.settings')}</h2>
      {editing ? (
        <>
          <RoomSettingsFields draft={draft} onChange={setDraft} maps={maps} withAi={false} />
          <div className={c.row} style={{ marginTop: 8 }}>
            <button
              type="button"
              className="btn btn--sm btn--green"
              onClick={async () => {
                if (await run(client.updateSettings(draftToPatch(draft)))) setEditing(false);
              }}
              data-testid="settings-save"
            >
              {t('lobby:room.saveSettings')}
            </button>
            <button type="button" className="btn btn--sm btn--cream" onClick={() => setEditing(false)}>
              {t('lobby:room.cancel')}
            </button>
          </div>
        </>
      ) : (
        <>
          <dl className={l.kv}>
            {rows.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          {host && (
            <button
              type="button"
              className="btn btn--sm btn--cream"
              onClick={() => setEditing(true)}
              data-testid="settings-edit"
            >
              {t('lobby:room.editSettings')}
            </button>
          )}
        </>
      )}
    </section>
  );
}

export function LobbyView({ room, onLeave }: { room: RoomView; onLeave(): void }): ReactNode {
  const t = useTx();
  const client = useClient();
  const run = useRun();
  const me = mySeatView(room);
  const host = room.you.isHost;
  const ready = me?.occupant?.kind === 'human' && me.occupant.ready;
  const startable = canStart(room);

  return (
    <main className={l.lobby} data-testid="screen-room" data-phase={room.phase}>
      <header className={`panel ${l.lobbyHead}`}>
        <h1>{t('lobby:room.title', { code: room.code })}</h1>
        <InviteLink code={room.code} allowWatch={room.settings.allowSpectators} />
        {room.you.role === 'spectator' && <span className={l.specBadge}>👁 {t('lobby:room.spectating')}</span>}
      </header>
      <div className={l.lobbyBody}>
        <div className={l.lobbyMain}>
          <SeatGrid room={room} />
          <div className={`${c.row} ${l.lobbyActions}`}>
            {room.you.role === 'player' && !host && (
              <button
                type="button"
                className={ready ? 'btn btn--cream' : 'btn btn--green'}
                onClick={() => void run(client.setReady(!ready))}
                data-testid="room-ready"
                aria-pressed={ready}
              >
                {ready ? t('lobby:room.unready') : t('lobby:room.ready')}
              </button>
            )}
            {host && (
              <button
                type="button"
                className="btn btn--green"
                disabled={!startable}
                onClick={() => void run(client.startGame())}
                data-testid="room-start"
              >
                {t('lobby:room.start')}
              </button>
            )}
            {room.you.role === 'player' && room.settings.allowSpectators && (
              <button
                type="button"
                className="btn btn--sm btn--cream"
                onClick={() => void run(client.toSpectator())}
                data-testid="room-to-spectator"
              >
                {t('lobby:room.toSpectator')}
              </button>
            )}
            <button type="button" className="btn btn--sm btn--cream" onClick={onLeave} data-testid="room-leave">
              {t('lobby:room.leave')}
            </button>
            {host && (
              <button
                type="button"
                className="btn btn--sm btn--cream"
                onClick={() => void run(client.dissolve())}
                data-testid="room-dissolve"
              >
                {t('lobby:room.dissolve')}
              </button>
            )}
          </div>
          {host && !startable && <p className={c.muted}>{t('lobby:room.startHint')}</p>}
          <CharacterPicker room={room} />
        </div>
        <aside className={l.lobbySide}>
          <SettingsBox room={room} />
          <SpectatorList room={room} />
          {host && (
            <details className={`panel ${l.savesBox}`} data-testid="lobby-saves">
              <summary>{t('lobby:room.loadSave')}</summary>
              <SaveLoadMenu mode="lobby" isHost={host} />
            </details>
          )}
          <ChatPanel room={room} className={l.lobbyChat} />
        </aside>
      </div>
    </main>
  );
}
