// DISCARD_CARD / BIRTHDAY_PICK 的原版场景（original-skin.md §4.2 通用：卡片欄 Panel#11、弃牌）：
// - DISCARD_CARD（手牌已满又得到新卡）：卡片欄列出手牌（格里写卡名与价格），点格选要丢的卡；资料栏位置亮出悬停 / 选中的卡
//   （没有时是新得到的那张）的插画，日历位置的消息框写新得到的卡与所选卡的说明，只有 YES（丢掉 X）→ DISCARD{slot}；
// - BIRTHDAY_PICK（命运「生日」）：上方选择玩家窗放有卡的对手（点头像切换），卡片欄列出他的手牌，每人各挑一张
//   （预选第一张）；消息框列出已挑的卡，只有 YES（收下礼物）→ PICK_CARDS{picks}。
// 逻辑与提交同程序化的 DiscardDialog / BirthdayPickDialog；testid 同名（discard-<卡槽>、birthday-<座位>-<卡槽>…）。
import { type CardId, cardDef, type SeatIndex } from '@rich4/shared/engine';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useGameText } from '../../components/names';
import { type DecisionProps, narrowDecision } from '../../decisions/types';
import { useDecision } from '../../decisions/useDecision';
import { DecisionStage } from '../common/DecisionStage';
import { TEXT } from '../common/textStyles';
import { YESNO_SHEET } from '../common/YesNoBox';
import type { RequiredKeys } from '../decisions/scene';
import { REGION } from '../layout';
import { CARD_SHOW_AT } from './FreeCard';
import {
  CardArt,
  CardGrid,
  COMMON_SHEET,
  ConfirmBox,
  CURSOR_SHEET,
  FACE_SHEET,
  type GridCell,
  ITEM_BAR,
  ITEM_BAR_SHEET,
  PICKER_SHEET,
  PlateButton,
  PlayerPicker,
} from './parts';
import { TURN_LAYOUT } from './TurnMenu';

type CardPickKind = 'DISCARD_CARD' | 'BIRTHDAY_PICK';

export const requiredKeys: RequiredKeys<CardPickKind> = (p) =>
  p.decision.kind === 'BIRTHDAY_PICK'
    ? [ITEM_BAR_SHEET, COMMON_SHEET, YESNO_SHEET, PICKER_SHEET, FACE_SHEET, CURSOR_SHEET]
    : [ITEM_BAR_SHEET, COMMON_SHEET, YESNO_SHEET];

/** 右下（日历位置）确认框的画点与行数 */
const SIDE_CONFIRM = { x: TURN_LAYOUT.info.x, y: TURN_LAYOUT.info.y, lines: 6 } as const;
/** 生日：选择玩家窗的画点 */
const VICTIMS_AT = { x: REGION.board.x + REGION.board.w / 2, y: REGION.board.y + 70 } as const;

function CardCell({ name, price }: { name: string; price?: number }): ReactNode {
  return (
    <>
      <span>{name}</span>
      {price !== undefined && <span style={TEXT.small}>{price}</span>}
    </>
  );
}

export default function CardPickScene(props: DecisionProps<CardPickKind>): ReactNode {
  const { t } = useTranslation();
  const { view, map, isMine } = props;
  const d0 = narrowDecision(props.decision);
  const ctl = useDecision(props);
  const text = useGameText(view, map);
  const [focus, setFocus] = useState<CardId | null>(null);
  const hover = (card: CardId) => (on: boolean) => setFocus((f) => (on ? card : f === card ? null : f));

  // ── 生日 ──
  const victims = d0.kind === 'BIRTHDAY_PICK' ? d0.options.victims.filter((v) => v.cards.length > 0) : [];
  const [active, setActive] = useState<SeatIndex | null>(victims[0]?.seat ?? null);
  const [picks, setPicks] = useState<Partial<Record<SeatIndex, number>>>(() => {
    const init: Partial<Record<SeatIndex, number>> = {};
    for (const v of victims) init[v.seat] = v.cards[0]!.slot;
    return init;
  });
  // ── 弃牌 ──
  const [pick, setPick] = useState<number | null>(null);

  if (d0.kind === 'DISCARD_CARD') {
    const o = d0.options;
    const row = o.hand.find((h) => h.slot === pick) ?? null;
    const cells: GridCell[] = o.hand.map((h) => ({
      key: `c${h.slot}`,
      label: `${text.card(h.card)} ${h.price}`,
      content: <CardCell name={text.card(h.card)} price={h.price} />,
      selected: pick === h.slot,
      testId: `discard-${h.slot}`,
      onClick: () => setPick(h.slot),
      onHover: hover(h.card),
    }));
    const shown = focus ?? row?.card ?? o.incoming;
    return (
      <DecisionStage
        ctl={ctl}
        decision={d0}
        view={view}
        map={map}
        isMine={isMine}
        label={t('dlg.discard.title')}
        countdownAt={{ x: REGION.board.x + REGION.board.w - 38, y: REGION.board.y + 6 }}
        attrs={{ 'data-pick': pick === null ? '' : String(pick) }}
      >
        <CardGrid
          kind="cards"
          x={TURN_LAYOUT.bar.x}
          y={TURN_LAYOUT.bar.y}
          cells={cells}
          label={t('dlg.discard.hand')}
          testId="discard-hand"
        />
        {/* 卡片欄只有 15 格：满手时多出来的（新得到的那张）列在欄下方 */}
        {cells.slice(ITEM_BAR.cols * ITEM_BAR.rows).map((cell, i) => (
          <PlateButton
            key={cell.key}
            x={TURN_LAYOUT.bar.x + i * 112}
            y={TURN_LAYOUT.bar.y + ITEM_BAR.h + 4}
            w={108}
            label={cell.label}
            pressed={cell.selected}
            onClick={() => cell.onClick?.()}
            testId={cell.testId}
          />
        ))}
        <CardArt card={shown} x={CARD_SHOW_AT.x} y={CARD_SHOW_AT.y} testId="discard-card-art" />
        <ConfirmBox
          x={SIDE_CONFIRM.x}
          y={SIDE_CONFIRM.y}
          lines={SIDE_CONFIRM.lines}
          yes={{
            label: row ? t('dlg.discard.confirm', { name: text.card(row.card) }) : t('dlg.discard.pickFirst'),
            onClick: () => row && ctl.send({ type: 'DISCARD', slot: row.slot }),
            disabled: row === null,
            testId: 'discard-confirm',
          }}
          testId="classic-discard-box"
        >
          <p style={TEXT.title}>{t('dlg.discard.title')}</p>
          <p data-testid="discard-incoming" data-card={o.incoming}>
            {t('dlg.discard.incoming')}
            {text.card(o.incoming)}
          </p>
          {row ? (
            <>
              <p>{t('dlg.discard.confirm', { name: text.card(row.card) })}</p>
              <p>{text.cardDesc(row.card)}</p>
            </>
          ) : (
            <p>{t('dlg.discard.pickFirst')}</p>
          )}
        </ConfirmBox>
      </DecisionStage>
    );
  }

  const complete = victims.every((v) => picks[v.seat] !== undefined);
  const cur = victims.find((v) => v.seat === active) ?? null;
  const cells: GridCell[] = cur
    ? cur.cards.map((c) => ({
        key: `c${c.slot}`,
        label: `${text.player(cur.seat)} ${text.card(c.card)}`,
        content: <CardCell name={text.card(c.card)} price={cardDef(c.card).price} />,
        selected: picks[cur.seat] === c.slot,
        testId: `birthday-${cur.seat}-${c.slot}`,
        onClick: () => setPicks((p) => ({ ...p, [cur.seat]: c.slot })),
        onHover: hover(c.card),
      }))
    : [];
  const pickedCard = (seat: SeatIndex): CardId | null => {
    const v = victims.find((x) => x.seat === seat);
    return v?.cards.find((c) => c.slot === picks[seat])?.card ?? null;
  };
  const activeCard = active === null ? null : pickedCard(active);
  return (
    <DecisionStage
      ctl={ctl}
      decision={d0}
      view={view}
      map={map}
      isMine={isMine}
      label={t('dlg.birthday.title')}
      countdownAt={{ x: REGION.board.x + REGION.board.w - 38, y: REGION.board.y + 6 }}
      attrs={{ 'data-active': active === null ? '' : String(active) }}
    >
      {victims.length > 0 && (
        <PlayerPicker
          x={VICTIMS_AT.x}
          y={VICTIMS_AT.y}
          seats={victims.map((v) => v.seat)}
          view={view}
          selected={active}
          onPick={setActive}
          nameOf={(seat) => text.player(seat)}
          noteOf={(seat) => {
            const c = pickedCard(seat);
            return c === null ? null : text.card(c);
          }}
          testIdOf={(seat) => `birthday-victim-${seat}`}
          disabled={!ctl.interactive}
          label={t('dlg.birthday.title')}
        />
      )}
      {cur && (
        <CardGrid
          kind="cards"
          x={TURN_LAYOUT.bar.x}
          y={TURN_LAYOUT.bar.y}
          cells={cells}
          label={text.player(cur.seat)}
          testId={`birthday-hand-${cur.seat}`}
        />
      )}
      <CardArt card={focus ?? activeCard} x={CARD_SHOW_AT.x} y={CARD_SHOW_AT.y} testId="birthday-card-art" />
      <ConfirmBox
        x={SIDE_CONFIRM.x}
        y={SIDE_CONFIRM.y}
        lines={SIDE_CONFIRM.lines + 1}
        yes={{
          label: t('dlg.birthday.confirm'),
          onClick: () =>
            ctl.send({
              type: 'PICK_CARDS',
              picks: victims.map((v) => ({ from: v.seat, slot: picks[v.seat] ?? v.cards[0]!.slot })),
            }),
          disabled: !complete,
          testId: 'birthday-confirm',
        }}
        testId="classic-birthday-box"
      >
        <p style={TEXT.title}>{t('dlg.birthday.title')}</p>
        <p>{t('dlg.birthday.body')}</p>
        {victims.length === 0 ? (
          <p>{t('dlg.birthday.none')}</p>
        ) : (
          victims.map((v) => (
            <p key={v.seat} data-testid={`birthday-picked-${v.seat}`}>
              {text.player(v.seat)}：{pickedCard(v.seat) === null ? '—' : text.card(pickedCard(v.seat)!)}
            </p>
          ))
        )}
      </ConfirmBox>
    </DecisionStage>
  );
}
