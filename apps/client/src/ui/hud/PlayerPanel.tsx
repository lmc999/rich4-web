// 玩家面板（design/client.md §5.1）：大头像、名字与玩家色、现金 / 存款 / 点券、神明徽章、交通工具、状态计数。
// 默认显示当前行动者；点击玩家条可切换查看对象。
import { CHARACTER_KEYS, GOD_KEYS, type SeatIndex } from '@rich4/shared/engine';
import type { RoomView } from '@rich4/shared/net';
import type { GameView, PlayerView } from '@rich4/shared/view';
import type { ReactNode } from 'react';
import { useTx } from '../../i18n/tx';
import { currentSeat } from '../../store/gameStore';
import { useUiStore } from '../../store/uiStore';
import { Avatar, SeatMark } from '../common/Avatar';
import { counterDays, formatDateShort, formatInt } from '../components/format';
import h from './hud.module.css';
import { Stat, seatName } from './PlayerChips';

const STATUS_KEYS = ['jail', 'hospital', 'hotel', 'away', 'hibernate', 'sleepwalk', 'stay', 'tortoise'] as const;

export function playerStatuses(p: PlayerView): { key: string; n: number | string; due?: string }[] {
  const out: { key: string; n: number | string; due?: string }[] = [];
  for (const k of STATUS_KEYS) {
    const n = counterDays(p.st[k]);
    if (n > 0) out.push({ key: k, n });
  }
  if (p.bankReject > 0) out.push({ key: 'bankReject', n: counterDays(p.bankReject) });
  if (p.insuranceDays > 0) out.push({ key: 'insurance', n: counterDays(p.insuranceDays) });
  if (p.bomb) out.push({ key: 'bomb', n: p.bomb.fuse });
  if (p.loan > 0) out.push({ key: 'loan', n: formatInt(p.loan), due: formatDateShort(p.loanDue) });
  return out;
}

export function PlayerPanel({ view, room }: { view: GameView; room: RoomView }): ReactNode {
  const t = useTx();
  const inspect = useUiStore((s) => s.inspectSeat);
  const me = room.you.role === 'player' ? room.you.seat : null;
  const seat: SeatIndex | null =
    inspect ?? (currentSeat(view) as SeatIndex | null) ?? me ?? view.players[0]?.seat ?? null;
  const p = view.players.find((x) => x.seat === seat);
  if (!p) return null;
  const statuses = playerStatuses(p);
  return (
    <section
      className={h.playerPanel}
      data-testid="player-panel"
      data-seat={p.seat}
      style={{ borderColor: `var(--c-p${p.seat + 1})` }}
    >
      <div className={h.ppHead}>
        <Avatar character={p.character} size={64} seat={p.seat} expr={p.alive ? 'normal' : 'sad'} />
        <div>
          <div className={h.ppName}>
            <SeatMark seat={p.seat} /> {t(`characters:${CHARACTER_KEYS[p.character]}.name`)}
          </div>
          <div className={h.chipSub}>{seatName(room, p.seat)}</div>
          <div className={h.ppVehicle}>{t(`hud:vehicle.${p.vehicle}`)}</div>
        </div>
      </div>
      <div className={h.ppStats}>
        <Stat seat={p.seat} field="cash" value={p.cash} label={t('hud:stat.cash')} />
        <Stat seat={p.seat} field="deposit" value={p.deposit} label={t('hud:stat.deposit')} />
        <Stat seat={p.seat} field="points" value={p.points} label={t('hud:stat.points')} />
      </div>
      <div className={h.ppBadges}>
        {p.god && (
          <span className={h.godBadge} data-testid="god-badge">
            {t(`gods:${GOD_KEYS[p.god.kind]}.name`)} {t('hud:days', { n: p.god.days })}
          </span>
        )}
        {statuses.map((s) => (
          <span key={s.key} className={h.statusBadge}>
            {t(`hud:status.${s.key}`, { n: s.n, due: s.due })}
          </span>
        ))}
        {!p.alive && <span className={h.badgeOut}>{t(`hud:out.${p.out ?? 'bankrupt'}`)}</span>}
      </div>
    </section>
  );
}
