// 经典布局的决策层（original-skin.md §4.2）：与程序化布局的 hud/DecisionLayer 同一套行为——只显示本人的决策（批尾提交）、
// TURN_MENU 平时由 GO 钮直接掷骰、点工具列的卡片 / 道具 / 股票 / 公布栏才展开回合菜单、进入对局后空闲时预取对话框——
// 区别只在宿主：ClassicDecisionHost（原版场景优先，缺素材时整体回退程序化对话框）。
// 原版场景经 portal 挂到舞台上；这里的外层 <div data-testid="decision-layer"> 照旧留在棋盘叠层里（E2E 与观战断言沿用）。
// 进出场：AnimatePresence 按「座位:种类」保留退场中的层（原版场景播退场动画），退场期间换成 decision-layer-exit、不可操作。
import type { MapIndex } from '@rich4/shared/data';
import type { PlayerIntent } from '@rich4/shared/engine';
import type { RoomView, YourDecision } from '@rich4/shared/net';
import { type GameView, isAutopilot } from '@rich4/shared/view';
import { AnimatePresence, useIsPresent } from 'motion/react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef } from 'react';
import { useClient } from '../../../app/services';
import { useTx } from '../../../i18n/tx';
import { useGameStore } from '../../../store/gameStore';
import { mySeat } from '../../../store/roomStore';
import { useUiStore } from '../../../store/uiStore';
import { preloadDecisionDialogs } from '../../decisions/registry';
import { TurnMenuSheetContext, type TurnMenuSheetControl } from '../../decisions/turnMenuSheet';
import h from '../../hud/hud.module.css';
import { ClassicDecisionHost } from './ClassicDecisionHost';
import { preloadClassicScenes } from './registry';

export interface ClassicDecisionLayerProps {
  view: GameView;
  map: MapIndex;
  room: RoomView;
  /** 原版皮肤判定的素材包（null → 全部程序化对话框） */
  packId: string | null;
}

export function ClassicDecisionLayer({ view, map, room, packId }: ClassicDecisionLayerProps): ReactNode {
  const decision = useGameStore((s) => s.decision);
  const panel = useUiStore((s) => s.panel);
  const me = mySeat(room);

  // 进入对局后空闲时预取全部对话框与原版场景模块（观战者不需要）
  useEffect(() => {
    if (me === null) return;
    const w = window as Window & { requestIdleCallback?: (cb: () => void) => number };
    const run = (): void => {
      void preloadDecisionDialogs();
      if (packId) void preloadClassicScenes();
    };
    if (w.requestIdleCallback) w.requestIdleCallback(run);
    else setTimeout(run, 1500);
  }, [me, packId]);

  // 回合菜单只在本人 TURN_MENU 期间展开；决策变成别的 kind 就收起
  useEffect(() => {
    if (panel === 'menu' && decision?.kind !== 'TURN_MENU') useUiStore.getState().openPanel(null);
  }, [panel, decision?.kind]);

  // 回合菜单每次展开是一个新的层（key 带展开次数）：Esc 收起后在退场动画期间又从工具列展开时，AnimatePresence 对「同 key 的
  // 子元素在退场中重新加入」处理不好（退场播完后整层消失，直到下一次重渲染才出现）；换成新 key 时旧层照常退场、新层照常进场。
  // 其他种类仍按「座位:种类」保留同一实例（拍卖重问等不重建场景）
  const menuGen = useRef(0);
  const prevPanel = useRef(panel);
  if (panel === 'menu' && prevPanel.current !== 'menu') menuGen.current++;
  prevPanel.current = panel;

  const show = !!decision && me !== null && !(decision.kind === 'TURN_MENU' && panel !== 'menu');
  return (
    <AnimatePresence>
      {show && decision && (
        <LayerBody
          key={
            decision.kind === 'TURN_MENU'
              ? `${decision.seat}:TURN_MENU:${menuGen.current}`
              : `${decision.seat}:${decision.kind}`
          }
          decision={decision}
          view={view}
          map={map}
          room={room}
          packId={packId}
        />
      )}
    </AnimatePresence>
  );
}

function LayerBody({
  decision,
  view,
  map,
  room,
  packId,
}: {
  decision: YourDecision;
  view: GameView;
  map: MapIndex;
  room: RoomView;
  packId: string | null;
}): ReactNode {
  const t = useTx();
  const client = useClient();
  const present = useIsPresent();
  const menuSheet = useUiStore((s) => s.menuSheet);
  // 退场中的层（Esc 收起后的退场动画期间）不接子页请求：否则退场动画还没播完就点工具列的股票 / SALE，
  // 请求会被这个即将卸载的旧实例取走，新挂上的回合菜单只剩默认的卡片欄
  const sheetCtl = useMemo<TurnMenuSheetControl>(
    () => ({
      request: present ? menuSheet : null,
      consume: () => useUiStore.getState().clearMenuSheet(),
      collapse: () => useUiStore.getState().openPanel(null),
    }),
    [menuSheet, present],
  );
  const me = mySeat(room);
  const control = me === null ? 'human' : (room.seats[me]?.control ?? 'human');
  const decisionId = decision.decisionId;

  const submit = useCallback(
    async (intent: PlayerIntent) => {
      const r = await client.act(intent, decisionId);
      return { ok: r.ok };
    },
    [client, decisionId],
  );

  return (
    <div
      className={h.decisionLayer}
      data-testid={present ? 'decision-layer' : 'decision-layer-exit'}
      data-kind={decision.kind}
      data-decision={present ? decision.decisionId : undefined}
      aria-hidden={present ? undefined : true}
      inert={present ? undefined : true}
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
        <ClassicDecisionHost
          decision={decision}
          isMine={!isAutopilot(control)}
          view={view}
          map={map}
          submit={submit}
          packId={packId}
        />
      </TurnMenuSheetContext.Provider>
    </div>
  );
}
