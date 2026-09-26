// 选角（design/client.md §5.5）：12 个角色轮播，预览待机动画（M3a 的 SVG 纸娃娃），被其他座位占用的置灰。
import { CHARACTER_IDS, CHARACTER_KEYS, type CharacterId } from '@rich4/shared/engine';
import type { RoomView } from '@rich4/shared/net';
import clsx from 'clsx';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { useClient } from '../../app/services';
import { characterByKey } from '../../game/procedural/character/defs';
import { characterSvg, svgDataUrl } from '../../game/procedural/character/svg';
import { useTx } from '../../i18n/tx';
import { Avatar } from '../common/Avatar';
import l from './lobby.module.css';
import { useRun } from './SeatGrid';

const IDLE_MS = 600;
const frameCache = new Map<string, string>();

function frameUrl(id: CharacterId, pose: 'idle0' | 'idle1' | 'cheer'): string {
  const key = `${id}:${pose}`;
  let url = frameCache.get(key);
  if (!url) {
    url = svgDataUrl(characterSvg(characterByKey(CHARACTER_KEYS[id]), pose, 'front'));
    frameCache.set(key, url);
  }
  return url;
}

export function CharacterPicker({ room }: { room: RoomView }): ReactNode {
  const t = useTx();
  const client = useClient();
  const run = useRun();
  const me = room.you.role === 'player' ? room.you.seat : null;
  const mine = me === null ? null : (room.seats[me]?.characterId ?? null);
  const taken = useMemo(() => {
    const m = new Map<CharacterId, number>();
    for (const s of room.seats) if (s.characterId !== null && s.index !== me) m.set(s.characterId, s.index);
    return m;
  }, [room.seats, me]);
  const [cursor, setCursor] = useState<CharacterId>(mine ?? CHARACTER_IDS[0]!);
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (mine !== null) setCursor(mine);
  }, [mine]);

  useEffect(() => {
    const id = setInterval(() => setFrame((f) => f + 1), IDLE_MS);
    return () => clearInterval(id);
  }, []);

  if (me === null) return null;
  const key = CHARACTER_KEYS[cursor];
  const step = (d: number): void => setCursor(CHARACTER_IDS[(CHARACTER_IDS.indexOf(cursor) + d + 12) % 12]!);
  const cursorTaken = taken.has(cursor);
  const pose =
    cursor === mine ? (frame % 4 === 0 ? 'cheer' : frame % 2 ? 'idle1' : 'idle0') : frame % 2 ? 'idle1' : 'idle0';

  return (
    <section className={`panel ${l.picker}`} data-testid="character-picker">
      <h2>{t('lobby:picker.title')}</h2>
      <div className={l.pickerStage}>
        <button
          type="button"
          className="btn btn--sm btn--cream"
          onClick={() => step(-1)}
          data-testid="char-prev"
          aria-label={t('lobby:picker.prev')}
        >
          ◀
        </button>
        <figure className={clsx(l.preview, cursorTaken && l.taken)}>
          <img src={frameUrl(cursor, pose)} alt={t(`characters:${key}.name`)} width={128} height={160} />
          <figcaption>
            <strong data-testid="char-preview-name">{t(`characters:${key}.name`)}</strong>
            <span>{t(`characters:${key}.tag`)}</span>
          </figcaption>
        </figure>
        <button
          type="button"
          className="btn btn--sm btn--cream"
          onClick={() => step(1)}
          data-testid="char-next"
          aria-label={t('lobby:picker.next')}
        >
          ▶
        </button>
      </div>
      <button
        type="button"
        className="btn btn--green"
        disabled={cursorTaken || cursor === mine}
        onClick={() => void run(client.selectCharacter(cursor))}
        data-testid="char-select"
      >
        {cursor === mine
          ? t('lobby:picker.selected')
          : cursorTaken
            ? t('lobby:picker.taken', { n: (taken.get(cursor) ?? 0) + 1 })
            : t('lobby:picker.select')}
      </button>
      <ul className={l.charGrid}>
        {CHARACTER_IDS.map((id) => {
          const by = taken.get(id);
          return (
            <li key={id}>
              <button
                type="button"
                className={clsx(l.charBtn, id === cursor && l.charCursor, id === mine && l.charMine)}
                onClick={() => setCursor(id)}
                onDoubleClick={() => by === undefined && void run(client.selectCharacter(id))}
                aria-pressed={id === mine}
                aria-disabled={by !== undefined}
                title={t(`characters:${CHARACTER_KEYS[id]}.name`)}
                data-testid={`char-${id}`}
                data-taken={by !== undefined ? 'true' : 'false'}
              >
                <Avatar character={id} size={44} dim={by !== undefined} seat={by ?? (id === mine ? me : null)} />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
