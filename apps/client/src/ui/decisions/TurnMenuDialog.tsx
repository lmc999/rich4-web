// TURN_MENU（掷骰前的行动面板，architecture §5.4：ActionPad + InventoryPanel / StockPanel / 公布栏 + TargetPicker）：
// 选骰子数并掷骰；用卡 / 用道具（背包 → 选目标 → 提交）；买卖股票；公布栏；投降。
// 除 ROLL / SURRENDER 外都是非终结操作：服务器处理后以新 decisionId 重发 TURN_MENU，面板与已打开的弹窗保持不变。
import type { DiceCount, TurnMenuCardRow, TurnMenuItemRow, UseTarget } from '@rich4/shared/engine';
import { ToggleGroup } from 'radix-ui';
import { type ReactNode, useContext, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { type LooseT, useGameText } from '../components/names';
import { BoardPanel } from '../panels/BoardPanel';
import { InventoryPanel, type InventoryTab } from '../panels/InventoryPanel';
import { StockPanel } from '../panels/StockPanel';
import { DecisionFrame } from './DecisionFrame';
import s from './decisions.module.css';
import { TargetPicker, type TargetSource } from './TargetPicker';
import { TurnMenuSheetContext } from './turnMenuSheet';
import type { DecisionProps } from './types';
import { useDecision } from './useDecision';

type Sheet = null | { k: 'inventory'; tab: InventoryTab } | { k: 'stock' } | { k: 'board' } | { k: 'surrender' };

interface Targeting {
  source: TargetSource;
  row: TurnMenuCardRow | TurnMenuItemRow;
}

const DICE_FACES = ['⚀', '⚁', '⚂'] as const;

export default function TurnMenuDialog(props: DecisionProps<'TURN_MENU'>): ReactNode {
  const { t } = useTranslation();
  const lt = t as unknown as LooseT;
  const { view, map, isMine, decision: d } = props;
  const ctl = useDecision(props);
  const text = useGameText(view, map);
  const o = d.options;
  const [dice, setDice] = useState<DiceCount>(o.dice.current);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [targeting, setTargeting] = useState<Targeting | null>(null);
  const diceLocked = o.dice.locked !== null;
  const allowed = o.dice.allowed;
  const diceNow: DiceCount = allowed.includes(dice) ? dice : (allowed[allowed.length - 1] ?? o.dice.current);
  const usableCards = o.cards.filter((c) => c.usable).length;
  const usableItems = o.items.filter((c) => c.usable).length;
  const menuFull = o.menuActions.used >= o.menuActions.limit;
  const sheetReq = useContext(TurnMenuSheetContext);
  const [viaShortcut, setViaShortcut] = useState(false);

  // HUD 请求直接打开某个子页（ActionPad 的卡片 / 道具 / 股票 / 公布栏）
  useEffect(() => {
    const req = sheetReq?.request;
    if (!req) return;
    setTargeting(null);
    setSheet(req === 'stock' ? { k: 'stock' } : req === 'board' ? { k: 'board' } : { k: 'inventory', tab: req });
    setViaShortcut(true);
    sheetReq.consume();
  }, [sheetReq]);

  const roll = (): void => {
    ctl.send(diceLocked || allowed.length === 0 ? { type: 'ROLL' } : { type: 'ROLL', dice: diceNow });
  };

  const closeSheet = (): void => {
    setSheet(null);
    setTargeting(null);
    if (viaShortcut) {
      setViaShortcut(false);
      sheetReq?.collapse();
    }
  };

  const confirmTarget = (target: UseTarget): void => {
    if (!targeting) return;
    const src = targeting.source;
    const ok =
      src.kind === 'card'
        ? ctl.send({ type: 'USE_CARD', slot: src.slot, card: src.card, target })
        : ctl.send({ type: 'USE_ITEM', item: src.item, target });
    if (ok) closeSheet();
  };

  const inventoryTitle = targeting
    ? t('dlg.turn.pickTarget')
    : sheet?.k === 'inventory' && sheet.tab === 'items'
      ? t('dlg.turn.items')
      : t('dlg.turn.cards');

  return (
    <DecisionFrame
      ctl={ctl}
      kind={d.kind}
      seat={d.seat}
      view={view}
      isMine={isMine}
      title={t('dlg.turn.title')}
      subtitle={t('dlg.turn.subtitle', { used: o.menuActions.used, limit: o.menuActions.limit })}
      icon="🎲"
      tone="sun"
      className={s.menu}
    >
      <div className={s.stack}>
        <div className={s.diceRow}>
          <span>{t('dlg.turn.dice')}</span>
          <ToggleGroup.Root
            type="single"
            className={s.diceToggle}
            value={String(diceNow)}
            onValueChange={(v) => {
              if (v) setDice(Number(v) as DiceCount);
            }}
            aria-label={t('dlg.turn.dice')}
            disabled={diceLocked}
          >
            {([1, 2, 3] as const).map((n) => (
              <ToggleGroup.Item
                key={n}
                value={String(n)}
                className={s.diceItem}
                disabled={diceLocked || !allowed.includes(n)}
                aria-label={t('dlg.turn.diceN', { n })}
                data-testid={`dice-${n}`}
              >
                {DICE_FACES.slice(0, n).join('')}
              </ToggleGroup.Item>
            ))}
          </ToggleGroup.Root>
        </div>
        {o.dice.locked && (
          <p className={s.note} data-testid="dice-locked">
            {lt(`dlg.turn.locked.${o.dice.locked}`)}
          </p>
        )}
        <Button size="lg" block className={s.rollBtn} onClick={roll} data-testid="turn-roll">
          🎲 {diceLocked ? t('dlg.turn.go') : t('dlg.turn.roll', { n: diceNow })}
        </Button>
        <div className={s.menuGrid}>
          <Button
            variant="cream"
            className={s.menuBtn}
            onClick={() => setSheet({ k: 'inventory', tab: 'cards' })}
            data-testid="turn-cards"
          >
            🃏 {t('dlg.turn.cards')}
            <small>{t('dlg.turn.usable', { n: usableCards, total: o.cards.length })}</small>
          </Button>
          <Button
            variant="cream"
            className={s.menuBtn}
            onClick={() => setSheet({ k: 'inventory', tab: 'items' })}
            data-testid="turn-items"
          >
            🧰 {t('dlg.turn.items')}
            <small>{t('dlg.turn.usable', { n: usableItems, total: o.items.length })}</small>
          </Button>
          <Button
            variant="cream"
            className={s.menuBtn}
            onClick={() => setSheet({ k: 'stock' })}
            data-testid="turn-stock"
          >
            📈 {t('dlg.turn.stock')}
            <small>
              {o.stock.open ? t('dlg.turn.marketOpen') : lt(`pnl.stock.closed.${o.stock.reason ?? 'holiday'}`)}
            </small>
          </Button>
          <Button
            variant="cream"
            className={s.menuBtn}
            onClick={() => setSheet({ k: 'board' })}
            data-testid="turn-board"
          >
            📋 {t('dlg.turn.board')}
            <small>{t('dlg.turn.listings', { n: o.board.listings.length })}</small>
          </Button>
          {o.canSurrender && (
            <Button
              variant="red"
              className={s.menuBtn}
              onClick={() => setSheet({ k: 'surrender' })}
              data-testid="turn-surrender"
            >
              🏳️ {t('dlg.turn.surrender')}
            </Button>
          )}
        </div>
        {menuFull && <p className={s.warn}>{text.reason('menuLimit')}</p>}
      </div>

      <Modal
        open={sheet?.k === 'inventory'}
        onOpenChange={(v) => !v && closeSheet()}
        title={inventoryTitle}
        width={720}
        testId="turn-inventory"
      >
        {targeting ? (
          <TargetPicker
            candidates={targeting.row.targets}
            view={view}
            map={map}
            me={d.seat}
            source={targeting.source}
            disabled={!ctl.interactive}
            onCancel={() => setTargeting(null)}
            onConfirm={confirmTarget}
          />
        ) : (
          <InventoryPanel
            view={view}
            map={map}
            seat={d.seat}
            menu={o}
            disabled={!ctl.interactive || menuFull}
            tab={sheet?.k === 'inventory' ? sheet.tab : 'cards'}
            onTabChange={(tab) => setSheet({ k: 'inventory', tab })}
            onUseCard={(row) => setTargeting({ source: { kind: 'card', card: row.card, slot: row.slot }, row })}
            onUseItem={(row) => setTargeting({ source: { kind: 'item', item: row.item }, row })}
          />
        )}
      </Modal>

      <Modal
        open={sheet?.k === 'stock'}
        onOpenChange={(v) => !v && closeSheet()}
        title={t('dlg.turn.stock')}
        width={900}
        testId="turn-stock-sheet"
      >
        <StockPanel
          view={view}
          map={map}
          seat={d.seat}
          market={o.stock}
          disabled={!ctl.interactive || menuFull}
          onTrade={(intent) => ctl.send(intent)}
        />
      </Modal>

      <Modal
        open={sheet?.k === 'board'}
        onOpenChange={(v) => !v && closeSheet()}
        title={t('dlg.turn.board')}
        width={720}
        testId="turn-board-sheet"
      >
        <BoardPanel
          view={view}
          map={map}
          seat={d.seat}
          board={o.board}
          disabled={!ctl.interactive || menuFull}
          onAct={(intent) => ctl.send(intent)}
        />
      </Modal>

      <Modal
        open={sheet?.k === 'surrender'}
        onOpenChange={(v) => !v && closeSheet()}
        title={t('dlg.turn.surrenderTitle')}
        width={420}
        testId="turn-surrender-sheet"
        footer={
          <>
            <Button variant="cream" onClick={closeSheet}>
              {t('dlg.common.cancel')}
            </Button>
            <Button
              variant="red"
              disabled={!ctl.interactive}
              onClick={() => {
                if (ctl.send({ type: 'SURRENDER' })) closeSheet();
              }}
              data-testid="surrender-confirm"
            >
              {t('dlg.turn.surrenderConfirm')}
            </Button>
          </>
        }
      >
        <p>{t('dlg.turn.surrenderBody', { name: text.player(d.seat) })}</p>
      </Modal>
    </DecisionFrame>
  );
}
