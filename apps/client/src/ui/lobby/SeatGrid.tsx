// 4 个座位（design/client.md §5.5）：空（坐下 / 补电脑）、真人（头像、昵称、准备、离线、房主）、电脑（预设）、离线。
// 房主可以踢人、补电脑、改电脑预设、转让房主。
import { AI_PRESETS, type AiPreset, CHARACTER_KEYS, type CharacterId, type SeatIndex } from '@rich4/shared/engine';
import type { Result, RoomView, SeatView } from '@rich4/shared/net';
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { useClient } from '../../app/services';
import { useTx } from '../../i18n/tx';
import { useUiStore } from '../../store/uiStore';
import { Avatar, SeatMark } from '../common/Avatar';
import l from './lobby.module.css';

/** 执行房间操作，失败时 toast 错误 */
export function useRun(): (p: Promise<Result<unknown>>) => Promise<boolean> {
  const client = useClient();
  return async (p) => {
    const r = await p;
    if (!r.ok) useUiStore.getState().toast(client.errorText(r.error), 'warn');
    return r.ok;
  };
}

function SeatCard({ seat, room }: { seat: SeatView; room: RoomView }): ReactNode {
  const t = useTx();
  const client = useClient();
  const run = useRun();
  const host = room.you.isHost;
  const i = seat.index;
  const o = seat.occupant;
  const iAmSpectator = room.you.role === 'spectator';
  const mine = room.you.role === 'player' && room.you.seat === i;
  const charName = seat.characterId === null ? null : t(`characters:${charKey(seat.characterId)}.name`);
  return (
    <li
      className={clsx(l.seat, mine && l.seatMine, !o && l.seatEmpty)}
      data-testid={`seat-${i}`}
      data-kind={o ? o.kind : 'empty'}
      style={{ borderColor: `var(--c-p${i + 1})` }}
    >
      <div className={l.seatHead}>
        <SeatMark seat={i} />
        <span className="num">{t('lobby:seat.label', { n: i + 1 })}</span>
        {seat.isHost && (
          <span className={l.tag} title={t('lobby:seat.host')}>
            👑
          </span>
        )}
        {mine && <span className={l.tag}>{t('lobby:seat.you')}</span>}
      </div>
      <Avatar character={seat.characterId} size={64} seat={i} dim={o?.kind === 'human' && !o.connected} />
      {o === null && <div className={l.seatName}>{t('lobby:seat.empty')}</div>}
      {o?.kind === 'human' && (
        <>
          <div className={l.seatName} data-testid={`seat-${i}-name`}>
            {o.nickname}
          </div>
          <div className={l.seatSub}>{charName ?? t('lobby:seat.noCharacter')}</div>
          <div className={l.seatStatus}>
            {!o.connected ? (
              <span className={l.badgeOff}>{t('lobby:seat.offline')}</span>
            ) : seat.isHost ? (
              <span className={l.badgeHost}>{t('lobby:seat.host')}</span>
            ) : o.ready ? (
              <span className={l.badgeReady} data-testid={`seat-${i}-ready`}>
                ✓ {t('lobby:seat.ready')}
              </span>
            ) : (
              <span className={l.badgeWait}>{t('lobby:seat.notReady')}</span>
            )}
          </div>
        </>
      )}
      {o?.kind === 'ai' && (
        <>
          <div className={l.seatName}>🤖 {t('lobby:seat.ai')}</div>
          <div className={l.seatSub}>{charName ?? t('lobby:seat.randomCharacter')}</div>
          {host ? (
            <select
              className="select"
              value={o.ai.preset}
              aria-label={t('lobby:settings.aiPreset')}
              data-testid={`seat-${i}-ai-preset`}
              onChange={(e) => void run(client.setSeatAi(i, { preset: e.target.value as AiPreset }))}
            >
              {AI_PRESETS.map((p) => (
                <option key={p} value={p}>
                  {t(`lobby:aiPreset.${p}`)}
                </option>
              ))}
            </select>
          ) : (
            <div className={l.seatStatus}>{t(`lobby:aiPreset.${o.ai.preset}`)}</div>
          )}
        </>
      )}
      <div className={l.seatActions}>
        {o === null && host && (
          <button
            type="button"
            className="btn btn--sm btn--blue"
            onClick={() => void run(client.setSeatAi(i, { preset: 'character' }))}
            data-testid={`seat-${i}-add-ai`}
          >
            {t('lobby:seat.addAi')}
          </button>
        )}
        {o === null && (iAmSpectator || (room.you.role === 'player' && !mine)) && (
          <button
            type="button"
            className="btn btn--sm btn--cream"
            onClick={() => void run(client.takeSeat(i as SeatIndex))}
            data-testid={`seat-${i}-take`}
          >
            {t('lobby:seat.take')}
          </button>
        )}
        {o?.kind === 'ai' && host && (
          <button
            type="button"
            className="btn btn--sm btn--cream"
            onClick={() => void run(client.setSeatAi(i, null))}
            data-testid={`seat-${i}-remove-ai`}
          >
            {t('lobby:seat.removeAi')}
          </button>
        )}
        {o?.kind === 'human' && host && !mine && (
          <>
            <button
              type="button"
              className="btn btn--sm btn--cream"
              onClick={() => void run(client.kick({ seat: i }))}
              data-testid={`seat-${i}-kick`}
            >
              {t('lobby:seat.kick')}
            </button>
            {o.connected && (
              <button
                type="button"
                className="btn btn--sm btn--cream"
                onClick={() => void run(client.transferHost(i))}
                data-testid={`seat-${i}-host`}
              >
                {t('lobby:seat.makeHost')}
              </button>
            )}
          </>
        )}
      </div>
    </li>
  );
}

function charKey(id: CharacterId): string {
  return CHARACTER_KEYS[id];
}

export function SeatGrid({ room }: { room: RoomView }): ReactNode {
  return (
    <ul className={l.seatGrid} data-testid="seat-grid">
      {room.seats.map((s) => (
        <SeatCard key={s.index} seat={s} room={room} />
      ))}
    </ul>
  );
}
