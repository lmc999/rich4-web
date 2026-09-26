// 角色头像（HUD、座位、选角）：M3a 的 SVG 纸娃娃胸像，按角色与表情缓存 data URL
import { CHARACTER_KEYS, type CharacterId } from '@rich4/shared/engine';
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { characterByKey } from '../../game/procedural/character/defs';
import type { Expression } from '../../game/procedural/character/rig';
import { portraitSvg, svgDataUrl } from '../../game/procedural/character/svg';
import s from './common.module.css';

const cache = new Map<string, string>();

export function portraitUrl(character: CharacterId, expr: Expression = 'normal'): string {
  const key = `${character}:${expr}`;
  let url = cache.get(key);
  if (!url) {
    url = svgDataUrl(portraitSvg(characterByKey(CHARACTER_KEYS[character]), expr));
    cache.set(key, url);
  }
  return url;
}

export interface AvatarProps {
  character: CharacterId | null;
  size?: number;
  expr?: Expression;
  /** 玩家色描边（座位） */
  seat?: number | null;
  dim?: boolean;
  className?: string;
  alt?: string;
}

export function Avatar({
  character,
  size = 48,
  expr = 'normal',
  seat = null,
  dim,
  className,
  alt = '',
}: AvatarProps): ReactNode {
  return (
    <span
      className={clsx(s.avatar, dim && s.dim, className)}
      style={{ width: size, height: size, ...(seat !== null ? { borderColor: `var(--c-p${seat + 1})` } : {}) }}
      data-seat={seat ?? undefined}
    >
      {character === null ? (
        <span className={s.avatarEmpty} aria-hidden="true">
          ?
        </span>
      ) : (
        <img src={portraitUrl(character, expr)} alt={alt} width={size} height={size} draggable={false} />
      )}
    </span>
  );
}

/** 玩家形状标记（色弱辅助）：●▲■★ */
export const SEAT_MARKS = ['●', '▲', '■', '★'] as const;

export function SeatMark({ seat }: { seat: number }): ReactNode {
  return (
    <span className={s.seatMark} style={{ color: `var(--c-p${seat + 1})` }} aria-hidden="true">
      {SEAT_MARKS[seat % 4]}
    </span>
  );
}
