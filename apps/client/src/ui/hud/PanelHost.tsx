// 查看类面板（非本人回合时的卡片 / 道具 / 股票 / 玩家信息）：用对话框代理 ui/panels 的组件以只读模式展示。
// 本人 TURN_MENU 期间的卡片 / 道具 / 股票由回合菜单（DecisionLayer）处理。
import type { MapIndex } from '@rich4/shared/data';
import type { SeatIndex } from '@rich4/shared/engine';
import type { RoomView } from '@rich4/shared/net';
import type { GameView } from '@rich4/shared/view';
import type { ReactNode } from 'react';
import { useClient } from '../../app/services';
import { useTx } from '../../i18n/tx';
import { currentSeat } from '../../store/gameStore';
import { mySeat } from '../../store/roomStore';
import { useUiStore } from '../../store/uiStore';
import { Modal } from '../components/Modal';
import { InventoryPanel } from '../panels/InventoryPanel';
import { PlayerInfoPanel } from '../panels/PlayerInfoPanel';
import { PropertyListPanel } from '../panels/PropertyListPanel';
import { StockPanel } from '../panels/StockPanel';

export function PanelHost({ view, map, room }: { view: GameView; map: MapIndex; room: RoomView }): ReactNode {
  const t = useTx();
  const client = useClient();
  const panel = useUiStore((s) => s.panel);
  const inspect = useUiStore((s) => s.inspectSeat);
  const me = mySeat(room);
  const seat = (inspect ?? me ?? currentSeat(view) ?? view.players[0]?.seat ?? 0) as SeatIndex;
  const close = (): void => useUiStore.getState().openPanel(null);
  const open = panel === 'cards' || panel === 'items' || panel === 'stock' || panel === 'board' || panel === 'info';
  if (!open) return null;
  const title =
    panel === 'cards'
      ? t('hud:panel.cards')
      : panel === 'items'
        ? t('hud:panel.items')
        : panel === 'stock'
          ? t('hud:panel.stock')
          : t('hud:panel.info');
  return (
    <Modal
      open
      onOpenChange={(o) => !o && close()}
      title={title}
      width={panel === 'stock' ? 900 : 720}
      testId={`panel-${panel}`}
    >
      {(panel === 'cards' || panel === 'items') && (
        <InventoryPanel view={view} map={map} seat={seat} menu={null} tab={panel === 'items' ? 'items' : 'cards'} />
      )}
      {panel === 'stock' && <StockPanel view={view} map={map} seat={me} market={null} />}
      {(panel === 'info' || panel === 'board') && (
        <>
          <PlayerInfoPanel view={view} map={map} seat={seat} />
          <PropertyListPanel
            view={view}
            map={map}
            viewer={me}
            onLocate={(lot) => {
              close();
              client.focusLot(lot);
            }}
          />
        </>
      )}
    </Modal>
  );
}
