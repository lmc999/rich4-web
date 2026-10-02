// 等待条（design/client.md §5.1）：非我的决策时显示「等待 钱夫人 选择是否购买 台北…（12s）」；观战者同样看到。
// 截止时间来自服务器（已扣动画时长），倒计时用 time:ping 校准后的服务器时间。
import type { MapIndex } from '@rich4/shared/data';
import { CHARACTER_KEYS, type DecisionKind } from '@rich4/shared/engine';
import type { RoomView } from '@rich4/shared/net';
import { type GameView, isAutopilot, type PendingView } from '@rich4/shared/view';
import type { ReactNode } from 'react';
import { uiLanguage } from '../../i18n';
import { useTx } from '../../i18n/tx';
import { makeNames } from '../../presentation/names';
import { useGameStore } from '../../store/gameStore';
import { mySeat } from '../../store/roomStore';
import { COUNTDOWN_URGENT_S } from '../common/countdownLogic';
import { useRemainingMs } from '../components/Countdown';
import h from './hud.module.css';
import { useServerNow } from './useServerClock';

/**
 * 私密手牌模式（联机）下会说出「他手里有这张被动卡」的决策：对别人只说「做决定」。
 * 决策出现造成的停顿本身仍然看得出来（决策种类也在 PendingView 里下发），登记为已知偏差。
 */
const HAND_REVEALING_KINDS: ReadonlySet<DecisionKind> = new Set<DecisionKind>(['USE_FREE_CARD', 'SCAPEGOAT']);

/** 等待条上的动作说明；handHidden = 这名玩家的手牌对我不公开（view 里 cards 为 null） */
export function waitingActionKey(kind: DecisionKind, handHidden: boolean): string {
  return handHidden && HAND_REVEALING_KINDS.has(kind) ? 'hud:waiting.decide' : `hud:waiting.kind.${kind}`;
}

/** 等待条要显示的决策：第一个不属于我的 */
export function waitingFor(pending: readonly PendingView[], me: number | null): PendingView | null {
  return pending.find((p) => p.seat !== me) ?? null;
}

export function WaitingBanner({
  view,
  room,
  map,
}: {
  view: GameView;
  room: RoomView;
  map: MapIndex | null;
}): ReactNode {
  const t = useTx();
  const pending = useGameStore((s) => s.pending);
  const me = mySeat(room);
  const p = waitingFor(pending, me);
  const now = useServerNow();
  const { remainingMs } = useRemainingMs(p?.deadlineAt ?? null, now, p?.decisionId ?? '');
  if (!p) return null;
  const player = view.players.find((x) => x.seat === p.seat);
  const who = player ? t(`characters:${CHARACTER_KEYS[player.character]}.name`) : `${p.seat + 1}P`;
  const names = makeNames({ t, view: () => view, map: () => map, lang: uiLanguage });
  const lot = p.publicInfo.lot ? names.lot(p.publicInfo.lot) : '';
  const action = t(waitingActionKey(p.kind, player?.cards === null), { lot, amount: p.publicInfo.amount ?? '' });
  const secs = remainingMs === null ? null : Math.ceil(remainingMs / 1000);
  const auto = isAutopilot(p.control) || p.control === 'ai';
  return (
    <div className={h.waiting} role="status" data-testid="waiting-banner" data-seat={p.seat} data-kind={p.kind}>
      <span className={h.waitingDot} style={{ background: `var(--c-p${p.seat + 1})` }} aria-hidden="true" />
      <span>{t(auto ? 'hud:waiting.textAi' : 'hud:waiting.text', { who, action })}</span>
      {secs !== null && !auto && (
        <span className={`num ${h.waitingSecs}`} data-urgent={secs <= COUNTDOWN_URGENT_S ? 'true' : 'false'}>
          {t('hud:waiting.secs', { n: secs })}
        </span>
      )}
    </div>
  );
}
