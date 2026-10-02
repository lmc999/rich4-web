// 房间大厅（design/client.md §5.5）：座位、选角、邀请、设置（房主可改）、准备 / 开始、观战者、聊天。
// 读档后（net.md §8.4）：顶部显示存档横幅（非官方 / 兼容性提示），角色与对局设置锁定，
// 所有存档座位都有人（真人认领或补电脑）且真人都准备后才能开始。
import { DEFAULT_PACING, type RoomView } from '@rich4/shared/net';
import { type ReactNode, useEffect, useState } from 'react';
import { useClient } from '../../app/services';
import { useTx } from '../../i18n/tx';
import { formatDate } from '../../presentation/names';
import { canStart, mySeatView } from '../../store/roomStore';
import c from '../common/common.module.css';
import { ChatPanel } from '../social/ChatPanel';
import { SpectatorList } from '../social/SpectatorList';
import { SaveLoadMenu, warningText } from '../system/SaveLoadMenu';
import { CharacterPicker } from './CharacterPicker';
import { InviteLink } from './InviteLink';
import l from './lobby.module.css';
import { RoomSettingsFields } from './RoomSettingsFields';
import { SeatGrid, useRun } from './SeatGrid';
import {
  draftFromSettings,
  draftToPatch,
  fetchMapList,
  handPrivateNow,
  type MapListingLite,
  soloHumanNow,
  timerHintActive,
} from './settingsDraft';
import { useCommitPick, usePickCursor } from './useCharacterPick';

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
  // 现在座位上只有一名真人：开局就不计时（design/net.md §5.4）
  const solo = soloHumanNow(room);
  // 此刻适用（档位不是 off）时说明换成「现在只有一名真人：开局后不计时」并高亮——文字本身不同，读屏与色弱用户也能分辨
  const untimedNow = timerHintActive(room.settings.timerPreset, solo);
  // 开局后他人看不到本人的手牌与道具（真人 ≥ 2 时服务器锁定私密）；只有一名真人时说明「两名以上真人时…」
  const handPrivate = handPrivateNow(room);
  // 第三项：值下方的一行小字说明（计时档位：只有一名真人时不计时，design/net.md §5.4）
  const rows: [string, string, string?][] = [
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
    [
      t('lobby:settings.timer'),
      t(`lobby:timer.${room.settings.timerPreset}`),
      t(untimedNow ? 'lobby:settings.timerHintActive' : 'lobby:settings.timerHint'),
    ],
    [t('lobby:settings.pacing'), t(`lobby:pacing.${room.settings.pacing ?? DEFAULT_PACING}`)],
    [t('lobby:settings.visibility'), t(`lobby:visibility.${room.settings.visibility}`)],
    [t('lobby:settings.spectators'), room.settings.allowSpectators ? t('lobby:yes') : t('lobby:no')],
  ];

  return (
    <section className={`panel ${l.settingsBox}`} data-testid="room-settings">
      <h2>{t('lobby:room.settings')}</h2>
      {editing ? (
        <>
          <RoomSettingsFields draft={draft} onChange={setDraft} maps={maps} withAi={false} soloHuman={solo} />
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
            {rows.map(([k, v, hint]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>
                  {v}
                  {hint && (
                    <small
                      className={l.kvHint}
                      data-testid="room-timer-hint"
                      data-active={untimedNow ? 'true' : 'false'}
                    >
                      {hint}
                    </small>
                  )}
                </dd>
              </div>
            ))}
          </dl>
          <p className={l.kvHint} data-testid="room-hand-hint" data-active={handPrivate ? 'true' : 'false'}>
            {t(handPrivate ? 'lobby:settings.handHintActive' : 'lobby:settings.handHint')}
          </p>
          {host && room.loadedSave === undefined && (
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

/** 读档后还没人坐的存档座位 */
export function unclaimedSeats(room: RoomView): number[] {
  if (!room.loadedSave) return [];
  return room.seats.filter((s) => s.savedSeat !== undefined && s.occupant === null).map((s) => s.index);
}

/** 读档横幅：存档名、游戏日期、天数；非官方存档与兼容性提示 */
function LoadedSaveBanner({ room }: { room: RoomView }): ReactNode {
  const t = useTx();
  const ls = room.loadedSave;
  if (!ls) return null;
  return (
    <div className={l.loadedBanner} role="status" data-testid="loaded-save" data-save={ls.saveId}>
      <span>
        💾 {t('lobby:saved.banner', { name: ls.name, date: ls.date ? formatDate(ls.date) : '', day: ls.gameDay })}
      </span>
      {!ls.verified && (
        <span className={l.warnTag} data-testid="loaded-unofficial" title={t('ui:saveMenu.unofficialNote')}>
          {t('hud:saves.unofficial')}
        </span>
      )}
      {(ls.warnings ?? []).map((w) => (
        <span key={w} className={l.warnTag} data-testid={`loaded-warn-${w}`}>
          {warningText(t, w)}
        </span>
      ))}
      <span className={l.note}>{t('lobby:saved.hint')}</span>
    </div>
  );
}

export function LobbyView({ room, onLeave }: { room: RoomView; onLeave(): void }): ReactNode {
  const t = useTx();
  const client = useClient();
  const run = useRun();
  const me = mySeatView(room);
  const host = room.you.isHost;
  const ready = me?.occupant?.kind === 'human' && me.occupant.ready;
  const unclaimed = unclaimedSeats(room);
  const startable = canStart(room) && unclaimed.length === 0;
  const [savesOpen, setSavesOpen] = useState(false);
  // 选角光标在这里持有：开始 / 准备前先提交光标上的角色（lobby/characterPick）
  const [cursor, setCursor] = usePickCursor(room);
  const commitPick = useCommitPick(room, cursor);

  return (
    <main className={l.lobby} data-testid="screen-room" data-phase={room.phase}>
      <header className={`panel ${l.lobbyHead}`}>
        <h1>{t('lobby:room.title', { code: room.code })}</h1>
        <InviteLink code={room.code} allowWatch={room.settings.allowSpectators} />
        {room.you.role === 'spectator' && <span className={l.specBadge}>👁 {t('lobby:room.spectating')}</span>}
      </header>
      <LoadedSaveBanner room={room} />
      <div className={l.lobbyBody}>
        <div className={l.lobbyMain}>
          <SeatGrid room={room} />
          <div className={`${c.row} ${l.lobbyActions}`}>
            {room.you.role === 'player' && !host && (
              <button
                type="button"
                className={ready ? 'btn btn--cream' : 'btn btn--green'}
                onClick={() =>
                  void (ready
                    ? run(client.setReady(false))
                    : commitPick().then((ok) => ok && run(client.setReady(true))))
                }
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
                onClick={() => void commitPick().then((ok) => ok && run(client.startGame()))}
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
          {host && !startable && (
            <p className={c.muted} data-testid="start-hint">
              {unclaimed.length > 0
                ? t('lobby:saved.startHint', { seats: unclaimed.map((i) => `${i + 1}P`).join('、') })
                : t('lobby:room.startHint')}
            </p>
          )}
          {room.loadedSave ? (
            <p className={c.muted}>{t('lobby:saved.characterLocked')}</p>
          ) : (
            <CharacterPicker room={room} cursor={cursor} onCursor={setCursor} />
          )}
        </div>
        <aside className={l.lobbySide}>
          <SettingsBox room={room} />
          <SpectatorList room={room} />
          {host && (
            <details
              className={`panel ${l.savesBox}`}
              data-testid="lobby-saves"
              open={savesOpen}
              onToggle={(e) => setSavesOpen(e.currentTarget.open)}
            >
              <summary data-testid="lobby-saves-toggle">{t('lobby:room.loadSave')}</summary>
              {savesOpen && <SaveLoadMenu mode="lobby" isHost={host} onLoaded={() => setSavesOpen(false)} />}
            </details>
          )}
          <ChatPanel room={room} className={l.lobbyChat} />
        </aside>
      </div>
    </main>
  );
}
