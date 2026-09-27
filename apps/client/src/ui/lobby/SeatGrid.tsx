// 4 个座位（design/client.md §5.5）：空（坐下 / 补电脑）、真人（头像、昵称、准备、离线、房主）、电脑（预设）、离线。
// 房主可以踢人、补电脑、改电脑预设、转让房主。
// 读档后（net.md §8.4）：存档里的座位显示「原：角色 / 昵称」，没人坐的标「待认领」；可认领的座位给出认领按钮
// （room:claimSeat：自己的存档座位可以把占座者让到观战），房主可给待认领的座位补电脑；不在存档里的座位不可用。
// 读档后电脑座位的预设只读：存档里本来是电脑的显示原预设（服务器也锁定为存档配置），存档里是真人、由电脑补上的
// 标「电脑代打」——读档开局用存档 state 里的 aiTraits，大厅改预设不会生效。
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
  const loaded = room.loadedSave !== undefined;
  const ss = seat.savedSeat;
  /** 读档后不在存档里的座位：不能坐、不能补电脑 */
  const outOfSave = loaded && !ss;
  return (
    <li
      className={clsx(l.seat, mine && l.seatMine, !o && l.seatEmpty, outOfSave && l.seatUnused)}
      data-testid={`seat-${i}`}
      data-kind={o ? o.kind : 'empty'}
      data-saved={ss ? (o === null ? 'unclaimed' : 'claimed') : undefined}
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
      {ss && (
        <div className={l.savedOrigin} data-testid={`seat-${i}-origin`}>
          {t('lobby:saved.origin', {
            character: t(`characters:${charKey(ss.characterId)}.name`),
            nickname: ss.wasHuman ? ss.nickname : t('lobby:seat.ai'),
          })}
        </div>
      )}
      {o === null && !ss && (
        <div className={l.seatName}>{outOfSave ? t('lobby:saved.notInSave') : t('lobby:seat.empty')}</div>
      )}
      {o === null && ss && (
        <div className={l.seatStatus}>
          <span className={l.badgeUnclaimed} data-testid={`seat-${i}-unclaimed`}>
            {t('lobby:saved.unclaimed')}
          </span>
        </div>
      )}
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
          {ss ? (
            <div className={l.seatStatus} data-testid={`seat-${i}-ai-saved`}>
              {ss.wasHuman
                ? t('lobby:saved.aiStandIn')
                : t('lobby:saved.aiPresetSaved', { preset: t(`lobby:aiPreset.${o.ai.preset}`) })}
            </div>
          ) : host ? (
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
        {ss?.claimableByYou && (
          <button
            type="button"
            className="btn btn--sm btn--green"
            onClick={() => void run(client.claimSeat(i as SeatIndex))}
            data-testid={`seat-${i}-claim`}
          >
            {t('lobby:saved.claim')}
          </button>
        )}
        {o === null && host && !outOfSave && (
          <button
            type="button"
            className="btn btn--sm btn--blue"
            onClick={() => void run(client.setSeatAi(i, { preset: 'character' }))}
            data-testid={`seat-${i}-add-ai`}
          >
            {loaded ? t('lobby:saved.fillAi') : t('lobby:seat.addAi')}
          </button>
        )}
        {o === null && !loaded && (iAmSpectator || (room.you.role === 'player' && !mine)) && (
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
