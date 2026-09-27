// 行动按钮区（design/client.md §5.1）：[卡片][道具][股票][查看][托管] + 骰子数选择 + [🎲 掷骰]；另有倍速与跳过动画。
// 掷骰按钮只在「我的 TURN_MENU 已就绪（动画播完）且未提交」时可用；按钮全部带 data-testid，E2E 一律点这里。
// 🤖：点按切换托管（game:autopilot）；长按 / 右键或旁边的 ⚙ 打开托管设置（openTrusteeSettings，对话框挂在 SystemMenu）。
import type { DiceCount } from '@rich4/shared/engine';
import type { RoomView } from '@rich4/shared/net';
import { isAutopilot, isDecisionForYouOf } from '@rich4/shared/view';
import clsx from 'clsx';
import { type MouseEvent, type PointerEvent, type ReactNode, useEffect, useRef } from 'react';
import { useClient } from '../../app/services';
import { useTx } from '../../i18n/tx';
import { useGameStore } from '../../store/gameStore';
import { mySeat } from '../../store/roomStore';
import { type AnimSpeed, useSettingsStore } from '../../store/settingsStore';
import { type PanelId, useUiStore } from '../../store/uiStore';
import { openTrusteeSettings } from '../system/TrusteeSettings';
import h from './hud.module.css';

const DICE_GLYPH = ['⚀', '⚁', '⚂'] as const;

/** 🤖 长按多久打开托管设置 */
export const AUTOPILOT_LONG_PRESS_MS = 550;

/** 托管按钮：点按切换；长按、右键或 ⚙ 打开托管设置 */
function AutopilotButtons({ auto, onToggle }: { auto: boolean; onToggle(): void }): ReactNode {
  const t = useTx();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 本次按下已触发长按：随后的 click 不再切换 */
  const longPressed = useRef(false);
  const clear = (): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const openSettings = (): void => {
    clear();
    longPressed.current = true;
    openTrusteeSettings();
  };
  const down = (e: PointerEvent<HTMLButtonElement>): void => {
    longPressed.current = false;
    clear();
    // 只有主键（鼠标左键、触摸、笔）才计长按；右键另由 contextmenu 处理
    if (e.button > 0) return;
    timer.current = setTimeout(openSettings, AUTOPILOT_LONG_PRESS_MS);
  };
  const click = (e: MouseEvent<HTMLButtonElement>): void => {
    // 键盘触发的 click（detail 0）总是切换
    if (longPressed.current && e.detail !== 0) {
      longPressed.current = false;
      return;
    }
    onToggle();
  };
  return (
    <span className={h.padSplit}>
      <button
        type="button"
        className={clsx('btn btn--sm', auto ? 'btn--blue' : 'btn--cream')}
        aria-pressed={auto}
        title={t('ui:trustee.toggleHint')}
        onPointerDown={down}
        onPointerUp={clear}
        onPointerLeave={clear}
        onPointerCancel={clear}
        onContextMenu={(e) => {
          e.preventDefault();
          openSettings();
        }}
        onClick={click}
        data-testid="action-autopilot"
      >
        🤖 <span className={h.padLabel}>{auto ? t('hud:action.autopilotOn') : t('hud:action.autopilot')}</span>
      </button>
      <button
        type="button"
        className="btn btn--sm btn--cream"
        onClick={() => openTrusteeSettings()}
        aria-label={t('ui:trustee.openSettings')}
        title={t('ui:trustee.openSettings')}
        data-testid="action-trustee-settings"
      >
        ⚙
      </button>
    </span>
  );
}

export function ActionPad({ room, onFocusMe }: { room: RoomView; onFocusMe(): void }): ReactNode {
  const t = useTx();
  const client = useClient();
  const decision = useGameStore((s) => s.decision);
  const submitting = useGameStore((s) => s.submitting);
  const playing = useGameStore((s) => s.anim.playing);
  const diceChoice = useUiStore((s) => s.diceChoice);
  const panel = useUiStore((s) => s.panel);
  const speed = useSettingsStore((s) => s.speed);
  const me = mySeat(room);
  if (me === null) {
    return (
      <nav className={h.actionPad} data-testid="action-pad" data-role="spectator">
        <span className={h.specBadge}>👁 {t('hud:top.spectating')}</span>
        <SpeedButtons speed={speed} playing={playing} onSkip={() => client.player.skipAll()} />
      </nav>
    );
  }
  const turn = decision && isDecisionForYouOf(decision, 'TURN_MENU') ? decision : null;
  const ready = turn !== null && submitting !== turn.decisionId;
  const dice = turn?.options.dice;
  const locked = dice ? dice.locked !== null : true;
  const allowed: readonly DiceCount[] = dice?.allowed ?? [];
  const chosen: DiceCount = diceChoice && allowed.includes(diceChoice) ? diceChoice : (dice?.current ?? 1);
  const control = room.seats[me]?.control ?? 'human';
  const auto = isAutopilot(control);

  const roll = (): void => {
    if (!turn) return;
    void client.act(
      locked || allowed.length === 0 ? { type: 'ROLL' } : { type: 'ROLL', dice: chosen },
      turn.decisionId,
    );
  };
  const open = (p: PanelId): void => {
    // 本人回合：展开回合菜单并直接打开对应子页（卡片 / 道具 / 股票 / 公布栏），不用再点一次
    if (turn && (p === 'cards' || p === 'items' || p === 'stock' || p === 'board')) {
      useUiStore.getState().openMenu(p);
      return;
    }
    useUiStore.getState().openPanel(panel === p ? null : p);
  };

  return (
    <nav className={h.actionPad} data-testid="action-pad" data-ready={ready ? 'true' : 'false'}>
      <div className={h.padGroup}>
        <button
          type="button"
          className="btn btn--sm btn--cream"
          onClick={() => open('cards')}
          data-testid="action-cards"
        >
          🃏 <span className={h.padLabel}>{t('hud:action.cards')}</span>
        </button>
        <button
          type="button"
          className="btn btn--sm btn--cream"
          onClick={() => open('items')}
          data-testid="action-items"
        >
          🧰 <span className={h.padLabel}>{t('hud:action.items')}</span>
        </button>
        <button
          type="button"
          className="btn btn--sm btn--cream"
          onClick={() => open('stock')}
          data-testid="action-stock"
        >
          📈 <span className={h.padLabel}>{t('hud:action.stock')}</span>
        </button>
        <button
          type="button"
          className="btn btn--sm btn--cream"
          onClick={() => open('board')}
          data-testid="action-board"
        >
          📋 <span className={h.padLabel}>{t('hud:action.board')}</span>
        </button>
        <button type="button" className="btn btn--sm btn--cream" onClick={() => open('info')} data-testid="action-info">
          🔍 <span className={h.padLabel}>{t('hud:action.info')}</span>
        </button>
        {/* 本人回合：展开完整的回合菜单（公布栏、投降、时光机提示等都在这里） */}
        <button
          type="button"
          className="btn btn--sm btn--cream"
          disabled={!ready}
          onClick={() => useUiStore.getState().openMenu(null)}
          data-testid="action-menu"
          title={t('hud:action.moreTitle')}
        >
          ⋯ <span className={h.padLabel}>{t('hud:action.more')}</span>
        </button>
        <AutopilotButtons auto={auto} onToggle={() => void client.autopilot(!auto)} />
        <button
          type="button"
          className="btn btn--sm btn--cream"
          onClick={onFocusMe}
          data-testid="action-focus"
          title={t('hud:action.focus')}
        >
          🎯
        </button>
      </div>
      <SpeedButtons speed={speed} playing={playing} onSkip={() => client.player.skipAll()} />
      <div className={h.padGroup}>
        {allowed.length > 1 && !locked && (
          <fieldset className={h.diceChoice} aria-label={t('hud:action.diceCount')}>
            {([1, 2, 3] as const).map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={chosen === n}
                className={clsx(h.diceBtn, chosen === n && h.diceOn)}
                disabled={!allowed.includes(n) || !ready}
                onClick={() => useUiStore.getState().setDiceChoice(n)}
                data-testid={`action-dice-${n}`}
                title={t('hud:action.diceN', { n })}
              >
                {DICE_GLYPH.slice(0, n).join('')}
              </button>
            ))}
          </fieldset>
        )}
        <button
          type="button"
          className={clsx('btn', h.rollBtn)}
          disabled={!ready}
          onClick={roll}
          data-testid="action-roll"
        >
          🎲 {locked && dice ? t(`hud:action.locked.${dice.locked}`) : t('hud:action.roll', { n: chosen })}
        </button>
      </div>
    </nav>
  );
}

function SpeedButtons({ speed, playing, onSkip }: { speed: AnimSpeed; playing: boolean; onSkip(): void }): ReactNode {
  const t = useTx();
  const next: AnimSpeed = speed === 3 ? 1 : ((speed + 1) as AnimSpeed);
  return (
    <div className={h.padGroup}>
      <button
        type="button"
        className="btn btn--sm btn--cream"
        onClick={() => useSettingsStore.getState().setSpeed(next)}
        title={t('hud:action.speed')}
        data-testid="action-speed"
      >
        ⏩ <span className="num">{speed}x</span>
      </button>
      {playing && (
        <button type="button" className="btn btn--sm btn--cream" onClick={onSkip} data-testid="action-skip">
          ⏭ <span className={h.padLabel}>{t('hud:action.skip')}</span>
        </button>
      )}
    </div>
  );
}
