// 玩家条 ×4（design/client.md §5.1）：头像、名字、现金 / 存款 / 点券（带 data-testid 与精确数值，E2E 比对四个页面一致）、
// 轮次高亮、离线 / 托管 / 破产徽标；点击切换 PlayerPanel 查看对象。
import { CHARACTER_KEYS, type SeatIndex } from '@rich4/shared/engine';
import type { RoomView } from '@rich4/shared/net';
import { type GameView, isAutopilot, type PlayerView } from '@rich4/shared/view';
import clsx from 'clsx';
import { type ReactNode, useEffect } from 'react';
import { useTx } from '../../i18n/tx';
import { formatMoney, formatMoneyShort } from '../../presentation/names';
import { currentSeat } from '../../store/gameStore';
import { type StatField, useUiStore } from '../../store/uiStore';
import { Avatar, SeatMark } from '../common/Avatar';
import { useHeadBubble } from '../social/socialStore';
import h from './hud.module.css';

export const FLASH_MS = 1300;

/** 数值 + 变化闪动（uiStore.flashes） */
export function Stat({
  seat,
  field,
  value,
  short,
  label,
  test,
}: {
  seat: SeatIndex;
  field: StatField;
  value: number;
  short?: boolean;
  label: string;
  /** 带 data-testid（只有玩家条带，避免重复） */
  test?: boolean;
}): ReactNode {
  const flash = useUiStore((s) => s.flashes.findLast((f) => f.seat === seat && f.field === field));
  useEffect(() => {
    if (!flash) return;
    const id = setTimeout(() => useUiStore.getState().clearFlash(flash.id), FLASH_MS);
    return () => clearTimeout(id);
  }, [flash]);
  const text = field === 'points' ? String(value) : short ? formatMoneyShort(value) : formatMoney(value);
  return (
    <span className={clsx(h.stat, h[`stat_${field}`])} title={label}>
      <span className={h.statLabel}>{label}</span>
      <span className="num" data-testid={test ? `p${seat}-${field}` : undefined} data-value={value}>
        {text}
      </span>
      {flash && (
        <span key={flash.id} className={clsx(h.flash, flash.delta > 0 ? h.flashUp : h.flashDown)} aria-hidden="true">
          {flash.delta > 0 ? '+' : '-'}
          {field === 'points' ? Math.abs(flash.delta) : formatMoneyShort(Math.abs(flash.delta))}
        </span>
      )}
    </span>
  );
}

export function seatName(room: RoomView, seat: SeatIndex): string {
  const o = room.seats[seat]?.occupant;
  return o ? (o.kind === 'human' ? o.nickname : o.name) : `${seat + 1}P`;
}

function Chip({ p, room, current }: { p: PlayerView; room: RoomView; current: boolean }): ReactNode {
  const t = useTx();
  const inspect = useUiStore((s) => s.inspectSeat);
  const sv = room.seats[p.seat];
  const control = sv?.control ?? 'human';
  const offline = sv?.occupant?.kind === 'human' && !sv.occupant.connected;
  const mine = room.you.role === 'player' && room.you.seat === p.seat;
  // 头顶气泡总线（ui/social/socialStore：已过滤屏蔽名单，表情 2 秒、聊天 3 秒；棋盘角色头顶同步显示）
  const bubble = useHeadBubble(p.seat);
  return (
    <li className={h.chipItem}>
      {bubble && (
        <span className={h.bubble} data-testid={`bubble-${p.seat}`} aria-live="polite">
          {bubble.kind === 'emote' ? bubble.glyph : bubble.text}
        </span>
      )}
      <button
        type="button"
        className={clsx(h.chip, current && h.chipCurrent, inspect === p.seat && h.chipInspect, !p.alive && h.chipOut)}
        style={{ borderColor: `var(--c-p${p.seat + 1})` }}
        onClick={() => useUiStore.getState().setInspectSeat(inspect === p.seat ? null : p.seat)}
        data-testid={`chip-${p.seat}`}
        data-current={current ? 'true' : 'false'}
        aria-pressed={inspect === p.seat}
      >
        <Avatar character={p.character} size={36} seat={p.seat} dim={!p.alive || offline} />
        <span className={h.chipBody}>
          <span className={h.chipName}>
            <SeatMark seat={p.seat} />
            {t(`characters:${CHARACTER_KEYS[p.character]}.name`)}
            {mine && <em className={h.youTag}>{t('hud:chips.you')}</em>}
          </span>
          <span className={h.chipSub}>{seatName(room, p.seat)}</span>
          <span className={h.chipStats}>
            <Stat seat={p.seat} field="cash" value={p.cash} short label={t('hud:stat.cash')} test />
            <Stat seat={p.seat} field="deposit" value={p.deposit} short label={t('hud:stat.deposit')} test />
            <Stat seat={p.seat} field="points" value={p.points} label={t('hud:stat.points')} test />
          </span>
        </span>
        <span className={h.chipBadges}>
          {!p.alive && <span className={h.badgeOut}>{t('hud:chips.out')}</span>}
          {offline && <span className={h.badgeOff}>{t('hud:chips.offline')}</span>}
          {isAutopilot(control) && (
            <span className={h.badgeAuto} data-testid={`chip-${p.seat}-autopilot`}>
              {t('hud:chips.autopilot')}
            </span>
          )}
          {control === 'ai' && <span className={h.badgeAi}>🤖</span>}
        </span>
      </button>
    </li>
  );
}

export function PlayerChips({ view, room }: { view: GameView; room: RoomView }): ReactNode {
  const cur = currentSeat(view);
  return (
    <ul className={h.chips} data-testid="player-chips">
      {view.players.map((p) => (
        <Chip key={p.seat} p={p} room={room} current={cur === p.seat} />
      ))}
    </ul>
  );
}
