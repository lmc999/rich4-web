// 终局（design/client.md §4.5 gameOver）：终局演出（烟花 + GameOverScreen）播完后由这里接手，
// 同样用 GameOverScreen 显示排名与每人的资产构成（现金、存款、股票、地产，贷款另列；presentation/handlers/endgame 的
// buildGameOverRows），底部是「再来一局」（房主）与「离开房间」。
import { CHARACTER_KEYS, type GameResult, type SeatIndex } from '@rich4/shared/engine';
import type { GameOverMsg, RoomView } from '@rich4/shared/net';
import type { GameView } from '@rich4/shared/view';
import type { ReactNode } from 'react';
import { useClient } from '../../app/services';
import { type LooseT, useTx } from '../../i18n/tx';
import { buildGameOverRows } from '../../presentation/handlers/endgame';
import { useGameStore } from '../../store/gameStore';
import { useUiStore } from '../../store/uiStore';
import { GameOverScreen } from '../popups/GameOverScreen';
import type { GameOverPopupSpec } from '../popups/popupStore';
import h from './hud.module.css';

/** GAME_OVER 结果 → 终局画面（排名以引擎 result.ranking 为准；缺失时退回 game:over 消息里的排名） */
export function gameOverSpec(over: GameOverMsg, view: GameView, t: LooseT): GameOverPopupSpec {
  const r = over.result;
  const result: GameResult =
    r.ranking.length > 0
      ? r
      : {
          ...r,
          ranking: over.ranking.map((x) => ({
            seat: x.seat,
            netWorth: x.netWorth,
            alive: view.players.find((p) => p.seat === x.seat)?.alive ?? true,
          })),
        };
  const name = (seat: SeatIndex): string => {
    const p = view.players.find((x) => x.seat === seat);
    return p ? t(`characters:${CHARACTER_KEYS[p.character]}.name`) : `${seat + 1}P`;
  };
  const rows = buildGameOverRows(result, view, name);
  const w = r.winner === null ? null : view.players.find((p) => p.seat === r.winner);
  return {
    kind: 'gameOver',
    title: t('hud:over.title'),
    subtitle: `${r.winner === null ? t('hud:over.noWinner') : t('hud:over.winner', { who: name(r.winner) })} · ${t(
      `hud:over.reason.${r.reason}`,
    )}`,
    winner: w ? { seat: w.seat, character: w.character, name: name(w.seat) } : null,
    rows,
  };
}

export function GameOverPanel({ view, room, onLeave }: { view: GameView; room: RoomView; onLeave(): void }): ReactNode {
  const t = useTx();
  const client = useClient();
  const over = useGameStore((s) => s.over);
  const playing = useGameStore((s) => s.anim.playing);
  if (!over || playing) return null;
  const spec = gameOverSpec(over, view, t);
  return (
    <div
      className={h.gameOver}
      role="dialog"
      aria-modal="true"
      aria-label={t('hud:over.title')}
      data-testid="game-over"
    >
      <GameOverScreen
        spec={spec}
        fireworks={false}
        actions={
          <>
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
          </>
        }
      />
    </div>
  );
}
