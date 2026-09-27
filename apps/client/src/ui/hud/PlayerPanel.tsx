// 玩家面板（design/client.md §5.1）：大头像、名字与玩家色、现金 / 存款 / 点券、神明徽章、交通工具、状态计数。
// 默认显示当前行动者；点击玩家条可切换查看对象。神明与状态徽章用 GodBadge / StatusBadges（与玩家条同一套判定）。
import { CHARACTER_KEYS, type SeatIndex } from '@rich4/shared/engine';
import type { RoomView } from '@rich4/shared/net';
import type { GameView } from '@rich4/shared/view';
import type { ReactNode } from 'react';
import { useTx } from '../../i18n/tx';
import { currentSeat } from '../../store/gameStore';
import { useUiStore } from '../../store/uiStore';
import { Avatar, SeatMark } from '../common/Avatar';
import h from './hud.module.css';
import { Stat, seatName } from './PlayerChips';
import { StatusBadges } from './StatusBadges';

export function PlayerPanel({ view, room }: { view: GameView; room: RoomView }): ReactNode {
  const t = useTx();
  const inspect = useUiStore((s) => s.inspectSeat);
  const me = room.you.role === 'player' ? room.you.seat : null;
  const seat: SeatIndex | null =
    inspect ?? (currentSeat(view) as SeatIndex | null) ?? me ?? view.players[0]?.seat ?? null;
  const p = view.players.find((x) => x.seat === seat);
  if (!p) return null;
  const charName = (s: SeatIndex): string => {
    const q = view.players.find((x) => x.seat === s);
    return q ? t(`characters:${CHARACTER_KEYS[q.character]}.name`) : seatName(room, s);
  };
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
        <StatusBadges player={p} nameOf={charName} />
        {!p.alive && <span className={h.badgeOut}>{t(`hud:out.${p.out ?? 'bankrupt'}`)}</span>}
      </div>
    </section>
  );
}
