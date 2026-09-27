// 大厅座位（原版没有对应物，用原版素材风格：72×72 头像 Data#2、深棕金边框）：显示与操作逻辑同程序化 SeatGrid
// （ui/lobby/SeatGrid）——空位（坐下 / 补电脑）、真人（昵称、准备、离线、房主）、电脑（个性预设）；房主可踢人、补电脑、
// 改电脑个性、转让房主；读档后显示「原：角色 / 昵称」、待认领与认领按钮，电脑座位的个性只读。
// testid 与 SeatGrid 相同（seat-<i>、seat-<i>-name / -origin / -unclaimed / -ready / -ai-saved / -ai-preset /
// -claim / -add-ai / -take / -remove-ai / -kick / -host），E2E 在两种皮肤下共用。
import { AI_PRESETS, type AiPreset, CHARACTER_KEYS, type CharacterId, type SeatIndex } from '@rich4/shared/engine';
import type { RoomView, SeatView } from '@rich4/shared/net';
import type { ReactNode } from 'react';
import { useClient } from '../../../app/services';
import { useTx } from '../../../i18n/tx';
import { useRun } from '../../lobby/SeatGrid';
import { Sprite } from '../Sprite';
import { FACE_SHEET } from './layout';
import s from './screens.module.css';

/** 72×72 头像按比例缩小（没有角色时画空框） */
export function FaceThumb({ character, size }: { character: CharacterId | null; size: number }): ReactNode {
  return (
    <span className={s.plateFace} style={{ width: size, height: size }} aria-hidden="true">
      {character !== null && (
        <Sprite
          sheet={FACE_SHEET}
          frame={character}
          x={0}
          y={0}
          origin="topLeft"
          scale={size / 72}
          fallback={<span className={s.face}>{character + 1}</span>}
        />
      )}
    </span>
  );
}

function charName(t: ReturnType<typeof useTx>, id: CharacterId | null): string | null {
  return id === null ? null : t(`characters:${CHARACTER_KEYS[id]}.name`);
}

function SeatRow({ seat, room }: { seat: SeatView; room: RoomView }): ReactNode {
  const t = useTx();
  const client = useClient();
  const run = useRun();
  const host = room.you.isHost;
  const i = seat.index;
  const o = seat.occupant;
  const iAmSpectator = room.you.role === 'spectator';
  const mine = room.you.role === 'player' && room.you.seat === i;
  const name = charName(t, seat.characterId);
  const loaded = room.loadedSave !== undefined;
  const ss = seat.savedSeat;
  const outOfSave = loaded && !ss;
  return (
    <li
      className={s.seatRow}
      data-testid={`seat-${i}`}
      data-kind={o ? o.kind : 'empty'}
      data-saved={ss ? (o === null ? 'unclaimed' : 'claimed') : undefined}
      data-mine={mine ? 'true' : 'false'}
    >
      <FaceThumb character={seat.characterId} size={40} />
      <div className={s.seatHead}>
        <span>{t('lobby:seat.label', { n: i + 1 })}</span>
        {seat.isHost && <span className={s.badge}>{t('lobby:seat.host')}</span>}
        {mine && <span className={s.badge}>{t('lobby:seat.you')}</span>}
        {o?.kind === 'human' && <span data-testid={`seat-${i}-name`}>{o.nickname}</span>}
        {o?.kind === 'ai' && <span>{t('lobby:seat.ai')}</span>}
        {o === null && !ss && <span>{outOfSave ? t('lobby:saved.notInSave') : t('lobby:seat.empty')}</span>}
      </div>
      {ss && (
        <div className={s.seatStatus} data-testid={`seat-${i}-origin`}>
          {t('lobby:saved.origin', {
            character: charName(t, ss.characterId) ?? '',
            nickname: ss.wasHuman ? ss.nickname : t('lobby:seat.ai'),
          })}
        </div>
      )}
      <div className={s.seatStatus}>
        {o === null && ss && (
          <span className={s.badge} data-tone="warn" data-testid={`seat-${i}-unclaimed`}>
            {t('lobby:saved.unclaimed')}
          </span>
        )}
        {o?.kind === 'human' && (
          <>
            <span>{name ?? t('lobby:seat.noCharacter')}</span>{' '}
            {!o.connected ? (
              <span className={s.badge} data-tone="warn">
                {t('lobby:seat.offline')}
              </span>
            ) : seat.isHost ? null : o.ready ? (
              <span className={s.badge} data-tone="ready" data-testid={`seat-${i}-ready`}>
                ✓ {t('lobby:seat.ready')}
              </span>
            ) : (
              <span className={s.badge}>{t('lobby:seat.notReady')}</span>
            )}
          </>
        )}
        {o?.kind === 'ai' && <span>{name ?? t('lobby:seat.randomCharacter')}</span>}
      </div>
      <div className={s.seatActions}>
        {o?.kind === 'ai' &&
          (ss ? (
            <span className={s.seatStatus} data-testid={`seat-${i}-ai-saved`}>
              {ss.wasHuman
                ? t('lobby:saved.aiStandIn')
                : t('lobby:saved.aiPresetSaved', { preset: t(`lobby:aiPreset.${o.ai.preset}`) })}
            </span>
          ) : host ? (
            <select
              className={s.rowSelect}
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
            <span className={s.seatStatus}>{t(`lobby:aiPreset.${o.ai.preset}`)}</span>
          ))}
        {ss?.claimableByYou && (
          <button
            type="button"
            className={s.railBtn}
            data-tone="green"
            onClick={() => void run(client.claimSeat(i as SeatIndex))}
            data-testid={`seat-${i}-claim`}
          >
            {t('lobby:saved.claim')}
          </button>
        )}
        {o === null && host && !outOfSave && (
          <button
            type="button"
            className={s.railBtn}
            data-tone="blue"
            onClick={() => void run(client.setSeatAi(i, { preset: 'character' }))}
            data-testid={`seat-${i}-add-ai`}
          >
            {loaded ? t('lobby:saved.fillAi') : t('lobby:seat.addAi')}
          </button>
        )}
        {o === null && !loaded && (iAmSpectator || (room.you.role === 'player' && !mine)) && (
          <button
            type="button"
            className={s.railBtn}
            onClick={() => void run(client.takeSeat(i as SeatIndex))}
            data-testid={`seat-${i}-take`}
          >
            {t('lobby:seat.take')}
          </button>
        )}
        {o?.kind === 'ai' && host && (
          <button
            type="button"
            className={s.railBtn}
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
              className={s.railBtn}
              onClick={() => void run(client.kick({ seat: i }))}
              data-testid={`seat-${i}-kick`}
            >
              {t('lobby:seat.kick')}
            </button>
            {o.connected && (
              <button
                type="button"
                className={s.railBtn}
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

export function ClassicSeatList({ room }: { room: RoomView }): ReactNode {
  return (
    <ul className={s.seatList} data-testid="seat-grid">
      {room.seats.map((st) => (
        <SeatRow key={st.index} seat={st} room={room} />
      ))}
    </ul>
  );
}
