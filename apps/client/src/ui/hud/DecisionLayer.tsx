// 决策层（design/client.md §5.3）：只在一批动画播完后（gameStore.decision 在批尾提交）显示本人的决策，
// 组件来自对话框代理的 ui/decisions（DecisionHost 按 kind 懒加载，未知 kind 与渲染失败退回 GenericChoice）。
// TURN_MENU 平时由 ActionPad 直接掷骰；点「卡片 / 道具 / 股票」时才展开完整的回合菜单（uiStore.panel === 'menu'）。
import type { MapIndex } from '@rich4/shared/data';
import type { PlayerIntent } from '@rich4/shared/engine';
import type { RoomView } from '@rich4/shared/net';
import { type GameView, isAutopilot } from '@rich4/shared/view';
import { type ReactNode, useCallback, useEffect, useMemo } from 'react';
import { useClient } from '../../app/services';
import { useTx } from '../../i18n/tx';
import { useGameStore } from '../../store/gameStore';
import { mySeat } from '../../store/roomStore';
import { useUiStore } from '../../store/uiStore';
import { DecisionHost } from '../decisions';
import { preloadDecisionDialogs } from '../decisions/registry';
import { TurnMenuSheetContext, type TurnMenuSheetControl } from '../decisions/turnMenuSheet';
import h from './hud.module.css';

export function DecisionLayer({ view, map, room }: { view: GameView; map: MapIndex; room: RoomView }): ReactNode {
  const t = useTx();
  const client = useClient();
  const decision = useGameStore((s) => s.decision);
  const panel = useUiStore((s) => s.panel);
  const menuSheet = useUiStore((s) => s.menuSheet);
  const sheetCtl = useMemo<TurnMenuSheetControl>(
    () => ({
      request: menuSheet,
      consume: () => useUiStore.getState().clearMenuSheet(),
      collapse: () => useUiStore.getState().openPanel(null),
    }),
    [menuSheet],
  );
  const me = mySeat(room);
  const control = me === null ? 'human' : (room.seats[me]?.control ?? 'human');
  const decisionId = decision?.decisionId ?? null;

  // 进入对局后空闲时预取全部对话框 chunk（观战者不需要）
  useEffect(() => {
    if (me === null) return;
    const w = window as Window & { requestIdleCallback?: (cb: () => void) => number };
    const run = (): void => void preloadDecisionDialogs();
    if (w.requestIdleCallback) w.requestIdleCallback(run);
    else setTimeout(run, 1500);
  }, [me]);

  // 回合菜单只在本人 TURN_MENU 期间展开；决策变成别的 kind 就收起
  useEffect(() => {
    if (panel === 'menu' && decision?.kind !== 'TURN_MENU') useUiStore.getState().openPanel(null);
  }, [panel, decision?.kind]);

  const submit = useCallback(
    async (intent: PlayerIntent) => {
      const r = await client.act(intent, decisionId ?? undefined);
      return { ok: r.ok };
    },
    [client, decisionId],
  );

  if (!decision || me === null) return null;
  if (decision.kind === 'TURN_MENU' && panel !== 'menu') return null;
  return (
    <div
      className={h.decisionLayer}
      data-testid="decision-layer"
      data-kind={decision.kind}
      data-decision={decision.decisionId}
    >
      {decision.kind === 'TURN_MENU' && (
        <button
          type="button"
          className={`btn btn--sm btn--cream ${h.decisionClose}`}
          onClick={() => useUiStore.getState().openPanel(null)}
          aria-label={t('hud:decision.collapse')}
          data-testid="decision-collapse"
        >
          ▾
        </button>
      )}
      <TurnMenuSheetContext.Provider value={sheetCtl}>
        <DecisionHost decision={decision} isMine={!isAutopilot(control)} view={view} map={map} submit={submit} />
      </TurnMenuSheetContext.Provider>
    </div>
  );
}
