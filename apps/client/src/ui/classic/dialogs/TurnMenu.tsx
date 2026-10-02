// TURN_MENU 的原版场景（original-skin.md §4.2 通用：卡片欄 Panel#11 与目标选择；ui.md §2.2）：
// 经典外壳里平时由 GO 钮直接掷骰；点工具列的卡片 / 道具（或侧栏「菜单」）才展开回合菜单，这里画——
// - 卡片欄（Panel#11 图0 青绿）/ 道具欄（图1 砖红）5×3 格：卡片格只写卡名、道具格画图标与持有数；可用的格点下去即进入
//   目标选择，不可用的置灰（点它只看说明与原因）。悬停 / 焦点的卡在资料栏位置亮出插画（Data#530–559），日历位置的
//   消息框写名称、说明与不可用原因；
// - 道具欄右下角（第 15 格）：骑机车 / 坐汽车时画「车 + 禁止圈」（Panel#11 图15 / 16），点一下直接收起、改回步行
//   （STOW_VEHICLE，不用确认、不选目标），随即收起回合菜单；步行、工程车时这一格空着（原版道具函数表第 14 项）；
// - 欄上方一排木框文字钮：卡片 / 道具（切欄）、股市、公布栏、投降（没有原版图的次要操作）；工具列的卡片 / 道具钮同样切欄；
//   手机热区只往上补（正下方紧贴卡片欄，居中补的下半截会被欄盖住）；
// - 目标选择：见 TargetPanel（棋盘视窗里原版光标 + 高亮，右侧 DOM 候选列表）；确认 → USE_CARD / USE_ITEM；
// - 投降：讲话头像（沮丧）+ YES/NO 确认 → SURRENDER；
// - 股市、公布栏：原版场所屏（Panel#75 / #73）属于场所组（A12）；这里沿用程序化的 StockPanel / BoardPanel（Modal），
//   testid 与程序化回合菜单相同（turn-stock-sheet、turn-board-sheet）。
// 用卡 / 用道具之后收起整个回合菜单回到棋盘（与经典外壳的快捷入口一致）；Esc / 关闭钮同样收起。
// 状态与提交沿用 useDecision；各 testid 与程序化的 TurnMenuDialog / InventoryPanel / TargetPicker 相同（inv-card-<卡槽>、
// inv-item-<道具>、inv-stow-vehicle、turn-cards、turn-items、turn-stock、turn-board、turn-surrender、surrender-confirm…）。
import { cardDef, type ItemId, type TurnMenuCardRow, type TurnMenuItemRow, type UseTarget } from '@rich4/shared/engine';
import { type ReactNode, useContext, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../../components/Modal';
import { useGameText } from '../../components/names';
import type { TargetSource } from '../../decisions/TargetPicker';
import { TurnMenuSheetContext } from '../../decisions/turnMenuSheet';
import type { DecisionProps } from '../../decisions/types';
import { useDecision } from '../../decisions/useDecision';
import { BoardPanel } from '../../panels/BoardPanel';
import { StockPanel } from '../../panels/StockPanel';
import { DecisionStage } from '../common/DecisionStage';
import { speakerSheet } from '../common/SpeakerBubble';
import { TEXT } from '../common/textStyles';
import { YESNO_SHEET, YesNoBox } from '../common/YesNoBox';
import type { RequiredKeys } from '../decisions/scene';
import { REGION } from '../layout';
import d from './dialogs.module.css';
import { CARD_SHOW_AT } from './FreeCard';
import {
  CardArt,
  CardGrid,
  COMMON_SHEET,
  CURSOR_SHEET,
  characterOf,
  type GridCell,
  ITEM_BAR_SHEET,
  ItemCellContent,
  MessageBox,
  PlateButton,
  STOW_CELL,
  StowCellContent,
} from './parts';
import { TargetPanel } from './TargetPanel';

export const requiredKeys: RequiredKeys<'TURN_MENU'> = (p) => [
  ITEM_BAR_SHEET,
  COMMON_SHEET,
  YESNO_SHEET,
  CURSOR_SHEET,
  speakerSheet(characterOf(p.view, p.decision.seat)),
];

/** 卡片欄左上角（棋盘视窗里，避开右下角的 GO 钮）与上方文字钮的位置 */
export const TURN_LAYOUT = {
  bar: { x: REGION.board.x + 14, y: REGION.board.y + 178 },
  plates: { y: REGION.board.y + 154, x0: REGION.board.x + 14, dx: 69, w: 65, h: 20 },
  /** 说明消息框：日历位置（440,280 起），画点 = 框左上 + 锚点 */
  info: { x: REGION.calendar.x + 97, y: REGION.calendar.y + 2 + 81, lines: 9 },
} as const;

type Tab = 'cards' | 'items';
type Sheet = null | 'stock' | 'board' | 'surrender';

interface Targeting {
  source: TargetSource;
  row: TurnMenuCardRow | TurnMenuItemRow;
}

type Focus =
  | { k: 'card'; row: TurnMenuCardRow }
  | { k: 'item'; row: TurnMenuItemRow }
  | { k: 'stow'; vehicle: 'moto' | 'car' }
  | null;

export default function TurnMenuScene(props: DecisionProps<'TURN_MENU'>): ReactNode {
  const { t } = useTranslation();
  const { view, map, isMine, decision: d0 } = props;
  const ctl = useDecision(props);
  const text = useGameText(view, map);
  const o = d0.options;
  const [tab, setTab] = useState<Tab>('cards');
  const [sheet, setSheet] = useState<Sheet>(null);
  const [targeting, setTargeting] = useState<Targeting | null>(null);
  const [focus, setFocus] = useState<Focus>(null);
  const [viaShortcut, setViaShortcut] = useState(false);
  const sheetReq = useContext(TurnMenuSheetContext);
  const menuFull = o.menuActions.used >= o.menuActions.limit;
  const usableCards = o.cards.filter((c) => c.usable).length;
  const usableItems = o.items.filter((c) => c.usable).length;
  const character = characterOf(view, d0.seat);

  // 工具列（或侧栏菜单）请求直接打开某一欄 / 子页
  useEffect(() => {
    const req = sheetReq?.request;
    if (!req) return;
    setTargeting(null);
    setFocus(null);
    if (req === 'stock' || req === 'board') setSheet(req);
    else {
      setTab(req);
      setSheet(null);
    }
    setViaShortcut(true);
    sheetReq.consume();
  }, [sheetReq]);

  const collapse = (): void => {
    setSheet(null);
    setTargeting(null);
    sheetReq?.collapse();
  };

  const closeSheet = (): void => {
    setSheet(null);
    if (viaShortcut) collapse();
  };

  const confirmTarget = (target: UseTarget): void => {
    if (!targeting) return;
    const src = targeting.source;
    const ok =
      src.kind === 'card'
        ? ctl.send({ type: 'USE_CARD', slot: src.slot, card: src.card, target })
        : ctl.send({ type: 'USE_ITEM', item: src.item, target });
    if (ok) collapse();
  };

  const locked = !ctl.interactive || menuFull;
  const cardCells: GridCell[] = o.cards.map((row) => ({
    key: `c${row.slot}`,
    label: `${text.card(row.card)}${row.usable ? '' : `（${text.reason(row.reason ?? 'noTarget')}）`}`,
    content: <span>{text.card(row.card)}</span>,
    usable: row.usable,
    disabled: locked || !row.usable,
    selected: focus?.k === 'card' && focus.row.slot === row.slot,
    testId: `inv-card-${row.slot}`,
    onClick: () => setTargeting({ source: { kind: 'card', card: row.card, slot: row.slot }, row }),
    onHover: (on) => setFocus((f) => (on ? { k: 'card', row } : f?.k === 'card' && f.row.slot === row.slot ? null : f)),
  }));
  const itemCells: GridCell[] = o.items.map((row) => ({
    key: `i${row.item}`,
    label: `${text.item(row.item)} ×${row.count}${row.usable ? '' : `（${text.reason(row.reason ?? 'noTarget')}）`}`,
    content: <ItemCellContent item={row.item} count={row.count} />,
    usable: row.usable,
    disabled: locked || !row.usable,
    selected: focus?.k === 'item' && focus.row.item === row.item,
    testId: `inv-item-${row.item}`,
    onClick: () => setTargeting({ source: { kind: 'item', item: row.item as ItemId }, row }),
    onHover: (on) => setFocus((f) => (on ? { k: 'item', row } : f?.k === 'item' && f.row.item === row.item ? null : f)),
  }));
  // 收起交通工具：机车 / 汽车时固定在右下角那一格，点下去直接提交（旧存档里的决策没有 vehicle 字段：不显示）
  const v = o.vehicle;
  const stowVehicle = v?.canStow && (v.current === 'moto' || v.current === 'car') ? v.current : null;
  if (stowVehicle !== null) {
    const name = text.t('game:stow.label', { name: text.vehicle(stowVehicle) });
    itemCells.push({
      key: 'stow',
      at: STOW_CELL.at,
      label: name,
      content: <StowCellContent vehicle={stowVehicle} label={name} />,
      usable: true,
      disabled: locked,
      selected: focus?.k === 'stow',
      testId: 'inv-stow-vehicle',
      onClick: () => {
        if (ctl.send({ type: 'STOW_VEHICLE' })) collapse();
      },
      onHover: (on) => setFocus((f) => (on ? { k: 'stow', vehicle: stowVehicle } : f?.k === 'stow' ? null : f)),
    });
  }

  const info: ReactNode =
    focus?.k === 'card' ? (
      <>
        <p style={TEXT.title}>{text.card(focus.row.card)}</p>
        <p>{text.cardDesc(focus.row.card)}</p>
        <p>
          {t('dlg.common.points')} {cardDef(focus.row.card).price}
        </p>
        {!focus.row.usable && <p style={TEXT.warn}>{text.reason(focus.row.reason ?? 'noTarget')}</p>}
      </>
    ) : focus?.k === 'item' ? (
      <>
        <p style={TEXT.title}>
          {text.item(focus.row.item)} ×{focus.row.count}
        </p>
        <p>{text.itemDesc(focus.row.item)}</p>
        {!focus.row.usable && <p style={TEXT.warn}>{text.reason(focus.row.reason ?? 'noTarget')}</p>}
      </>
    ) : focus?.k === 'stow' && stowVehicle !== null ? (
      <>
        <p style={TEXT.title}>{text.t('game:stow.label', { name: text.vehicle(focus.vehicle) })}</p>
        <p>{text.t('game:stow.desc', { name: text.vehicle(focus.vehicle) })}</p>
      </>
    ) : (
      <>
        <p style={TEXT.title}>{t('dlg.turn.title')}</p>
        <p>{t('dlg.turn.subtitle', { used: o.menuActions.used, limit: o.menuActions.limit })}</p>
        <p>
          {t('dlg.turn.cards')} {t('dlg.turn.usable', { n: usableCards, total: o.cards.length })}
        </p>
        <p>
          {t('dlg.turn.items')} {t('dlg.turn.usable', { n: usableItems, total: o.items.length })}
        </p>
        {menuFull && <p style={TEXT.warn}>{text.reason('menuLimit')}</p>}
      </>
    );

  const plates: { id: string; label: string; pressed?: boolean; tone?: 'red'; onClick(): void }[] = [
    { id: 'turn-cards', label: t('dlg.turn.cards'), pressed: tab === 'cards', onClick: () => setTab('cards') },
    { id: 'turn-items', label: t('dlg.turn.items'), pressed: tab === 'items', onClick: () => setTab('items') },
    { id: 'turn-stock', label: t('dlg.turn.stock'), onClick: () => setSheet('stock') },
    { id: 'turn-board', label: t('dlg.turn.board'), onClick: () => setSheet('board') },
  ];
  if (o.canSurrender)
    plates.push({
      id: 'turn-surrender',
      label: t('dlg.turn.surrender'),
      tone: 'red',
      onClick: () => setSheet('surrender'),
    });
  plates.push({ id: 'turn-close', label: t('cmp.close'), onClick: () => collapse() });

  const timeNote =
    targeting?.source.kind === 'item' && targeting.source.item === 10 && o.timeMachine.anchorTurn !== null
      ? t(view.config.rules.timeMachine === 'perSeat' ? 'dlg.target.timeMachinePerSeat' : 'dlg.target.timeMachine', {
          turn: o.timeMachine.anchorTurn,
        })
      : undefined;

  const focusCard = focus?.k === 'card' ? focus.row.card : null;

  return (
    <DecisionStage
      ctl={ctl}
      decision={d0}
      view={view}
      map={map}
      isMine={isMine}
      label={t('dlg.turn.title')}
      onClose={() => (targeting ? setTargeting(null) : sheet === 'surrender' ? setSheet(null) : collapse())}
      closeButton={false}
      className={d.passThrough}
      countdownAt={{ x: REGION.board.x + REGION.board.w - 38, y: REGION.board.y + 6 }}
      attrs={{
        'data-tab': tab,
        'data-sheet': sheet ?? '',
        'data-targeting': targeting ? 'true' : 'false',
        'data-character': String(character),
      }}
    >
      {targeting ? (
        <TargetPanel
          key={targeting.source.kind === 'card' ? `c${targeting.source.slot}` : `i${targeting.source.item}`}
          candidates={targeting.row.targets}
          view={view}
          map={map}
          me={d0.seat}
          source={targeting.source}
          note={timeNote}
          disabled={!ctl.interactive}
          onCancel={() => setTargeting(null)}
          onConfirm={confirmTarget}
        />
      ) : sheet === 'surrender' ? (
        <YesNoBox
          lines={8}
          onYes={() => {
            if (ctl.send({ type: 'SURRENDER' })) collapse();
          }}
          onNo={() => setSheet(null)}
          yesLabel={t('dlg.turn.surrenderConfirm')}
          noLabel={t('dlg.common.cancel')}
          yesTestId="surrender-confirm"
          noTestId="surrender-cancel"
          testId="turn-surrender-sheet"
          speaker={{
            character,
            expression: 3,
            children: <p style={TEXT.title}>{t('dlg.turn.surrenderTitle')}</p>,
          }}
        >
          <p>{t('dlg.turn.surrenderBody', { name: text.player(d0.seat) })}</p>
        </YesNoBox>
      ) : (
        <>
          {plates.map((p, i) => (
            <PlateButton
              key={p.id}
              x={TURN_LAYOUT.plates.x0 + i * TURN_LAYOUT.plates.dx}
              y={TURN_LAYOUT.plates.y}
              w={TURN_LAYOUT.plates.w}
              h={TURN_LAYOUT.plates.h}
              label={p.label}
              pressed={p.pressed}
              tone={p.tone}
              onClick={p.onClick}
              testId={p.id}
              hitPad="up"
            />
          ))}
          <CardGrid
            kind={tab}
            x={TURN_LAYOUT.bar.x}
            y={TURN_LAYOUT.bar.y}
            cells={tab === 'cards' ? cardCells : itemCells}
            label={tab === 'cards' ? t('dlg.turn.cards') : t('dlg.turn.items')}
            testId="turn-inventory"
          />
          <CardArt card={focusCard} x={CARD_SHOW_AT.x} y={CARD_SHOW_AT.y} testId="turn-card-art" />
          <MessageBox x={TURN_LAYOUT.info.x} y={TURN_LAYOUT.info.y} lines={TURN_LAYOUT.info.lines} testId="turn-info">
            {info}
          </MessageBox>
        </>
      )}

      <Modal
        open={sheet === 'stock'}
        onOpenChange={(v) => !v && closeSheet()}
        title={t('dlg.turn.stock')}
        width={900}
        testId="turn-stock-sheet"
      >
        <StockPanel
          view={view}
          map={map}
          seat={d0.seat}
          market={o.stock}
          disabled={!ctl.interactive || menuFull}
          onTrade={(intent) => ctl.send(intent)}
        />
      </Modal>
      <Modal
        open={sheet === 'board'}
        onOpenChange={(v) => !v && closeSheet()}
        title={t('dlg.turn.board')}
        width={720}
        testId="turn-board-sheet"
      >
        <BoardPanel
          view={view}
          map={map}
          seat={d0.seat}
          board={o.board}
          disabled={!ctl.interactive || menuFull}
          onAct={(intent) => ctl.send(intent)}
        />
      </Modal>
    </DecisionStage>
  );
}
