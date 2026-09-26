// 玩家头像（portraitSvg 内联 data URL，任何 DPI 都清晰）+ 玩家色描边 + 形状标记（色弱辅助）
import type { CharacterId, SeatIndex } from '@rich4/shared/engine';
import type { GameView } from '@rich4/shared/view';
import clsx from 'clsx';
import type { CSSProperties, ReactNode } from 'react';
import { characterByIndex } from '../../game/procedural/character/defs';
import type { Expression } from '../../game/procedural/character/rig';
import { portraitSvg, svgDataUrl } from '../../game/procedural/character/svg';
import { SEAT_COLOR_VARS, SEAT_MARKS } from './cardVisuals';
import s from './components.module.css';

const portraitCache = new Map<string, string>();

/** 头像 data URL（按角色 + 表情缓存） */
export function portraitUrl(character: CharacterId, expr: Expression = 'normal'): string {
  const key = `${character}:${expr}`;
  let url = portraitCache.get(key);
  if (!url) {
    url = svgDataUrl(portraitSvg(characterByIndex(character), expr));
    portraitCache.set(key, url);
  }
  return url;
}

export function seatColor(seat: SeatIndex | null | undefined): string {
  return seat === null || seat === undefined ? 'var(--c-ink-soft)' : SEAT_COLOR_VARS[seat];
}

export interface AvatarProps {
  character: CharacterId;
  seat?: SeatIndex | null;
  size?: number;
  expr?: Expression;
  /** 可访问名称（通常是角色名）；缺省视为装饰 */
  label?: string;
  className?: string;
}

export function Avatar({ character, seat, size = 40, expr = 'normal', label, className }: AvatarProps): ReactNode {
  const style = { width: size, height: size, '--seat': seatColor(seat) } as CSSProperties;
  return (
    <span className={clsx(s.avatar, className)} style={style} data-seat={seat ?? undefined}>
      <img src={portraitUrl(character, expr)} alt={label ?? ''} draggable={false} />
    </span>
  );
}

/** 玩家形状标记 ●▲■★（玩家色） */
export function SeatMark({ seat }: { seat: SeatIndex | null }): ReactNode {
  if (seat === null) return null;
  return (
    <span className={s.seatMark} style={{ color: SEAT_COLOR_VARS[seat] }} aria-hidden="true">
      {SEAT_MARKS[seat]}
    </span>
  );
}

/** 头像 + 名字的胶囊（seat 不在 view 里时只显示名字） */
export function PlayerChip({
  view,
  seat,
  name,
  size = 28,
  children,
}: {
  view: GameView;
  seat: SeatIndex;
  name: string;
  size?: number;
  children?: ReactNode;
}): ReactNode {
  const p = view.players.find((x) => x.seat === seat);
  return (
    <span className={s.chip} data-seat={seat}>
      {p ? <Avatar character={p.character} seat={seat} size={size} /> : <SeatMark seat={seat} />}
      <span>{name}</span>
      {children}
    </span>
  );
}
