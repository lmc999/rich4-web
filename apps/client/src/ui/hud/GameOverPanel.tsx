// 终局（design/client.md §4.5 gameOver）：动画播完后显示排名与总资产；房主可以「再来一局」回到大厅
import { CHARACTER_KEYS } from '@rich4/shared/engine';
import type { RoomView } from '@rich4/shared/net';
import type { GameView } from '@rich4/shared/view';
import type { ReactNode } from 'react';
import { useClient } from '../../app/services';
import { useTx } from '../../i18n/tx';
import { formatMoney } from '../../presentation/names';
import { useGameStore } from '../../store/gameStore';
import { useUiStore } from '../../store/uiStore';
import { Avatar } from '../common/Avatar';
import h from './hud.module.css';

export function GameOverPanel({ view, room, onLeave }: { view: GameView; room: RoomView; onLeave(): void }): ReactNode {
  const t = useTx();
  const client = useClient();
  const over = useGameStore((s) => s.over);
  const playing = useGameStore((s) => s.anim.playing);
  if (!over || playing) return null;
  const r = over.result;
  const name = (seat: number): string => {
    const p = view.players.find((x) => x.seat === seat);
    return p ? t(`characters:${CHARACTER_KEYS[p.character]}.name`) : `${seat + 1}P`;
  };
  return (
    <div
      className={h.gameOver}
      role="dialog"
      aria-modal="true"
      aria-label={t('hud:over.title')}
      data-testid="game-over"
    >
      <div className={`panel ${h.gameOverCard}`}>
        <h2>{t('hud:over.title')}</h2>
        <p>
          {r.winner === null ? t('hud:over.noWinner') : t('hud:over.winner', { who: name(r.winner) })} ·{' '}
          {t(`hud:over.reason.${r.reason}`)}
        </p>
        <ol className={h.ranking}>
          {over.ranking.map((x, i) => {
            const p = view.players.find((q) => q.seat === x.seat);
            return (
              <li key={x.seat} data-testid={`rank-${i + 1}`} data-seat={x.seat}>
                <span className="num">{i + 1}</span>
                {p && <Avatar character={p.character} size={36} seat={x.seat} />}
                <span>{name(x.seat)}</span>
                <span className="num">{formatMoney(x.netWorth)}</span>
              </li>
            );
          })}
        </ol>
        <div className={h.overActions}>
          {room.you.isHost && (
            <button
              type="button"
              className="btn btn--green"
              onClick={async () => {
                const res = await client.rematch();
                if (!res.ok) useUiStore.getState().toast(client.errorText(res.error), 'warn');
              }}
              data-testid="over-rematch"
            >
              {t('hud:over.rematch')}
            </button>
          )}
          <button type="button" className="btn btn--cream" onClick={onLeave} data-testid="over-leave">
            {t('hud:over.leave')}
          </button>
        </div>
      </div>
    </div>
  );
}
