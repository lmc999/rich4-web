// SCAPEGOAT / DEATH_GOD_TARGET 的原版场景（original-skin.md §4.2 通用；ui.md §2.1 选择玩家窗 Data#477）：
// 选择玩家窗里放候选的 72×72 头像，点头像选人（选中格旁出现原版手形光标）；候选同时高亮到棋盘，棋盘上点候选棋子也能选中，
// 棋盘视窗里的鼠标光标换成原版手形。下方宝石消息框写明情境：
// - SCAPEGOAT（嫁祸卡）：YES（嫁祸给 X，先选人）→ SCAPEGOAT{target}、NO / Esc（认了）→ DECLINE；资料栏亮出嫁祸卡插画；
// - DEATH_GOD_TARGET（投降后指定死神附身的对手）：只有一个 intent，消息框只放 YES（送给 X，先选人）。
// 逻辑与提交同程序化的 PassiveCardDialog / DeathGodTargetDialog；testid 同名（scapegoat-seat-N、deathgod-confirm…）。
import { CARD, type SeatIndex } from '@rich4/shared/engine';
import { type ReactNode, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatMoney } from '../../../presentation/names';
import { type LooseT, useGameText } from '../../components/names';
import { passiveText } from '../../decisions/PassiveCardDialog';
import { type BoardPick, useBoardHighlight, useBoardPick } from '../../decisions/targeting';
import { type DecisionProps, narrowDecision } from '../../decisions/types';
import { useDecision } from '../../decisions/useDecision';
import { DecisionStage } from '../common/DecisionStage';
import { TEXT } from '../common/textStyles';
import { YESNO_SHEET, YesNoBox } from '../common/YesNoBox';
import type { RequiredKeys } from '../decisions/scene';
import { REGION } from '../layout';
import d from './dialogs.module.css';
import { CARD_SHOW_AT } from './FreeCard';
import {
  CardArt,
  COMMON_SHEET,
  ConfirmBox,
  CURSOR_SHEET,
  FACE_SHEET,
  PICKER_SHEET,
  PlayerPicker,
  useBoardCursor,
} from './parts';

type PickKind = 'SCAPEGOAT' | 'DEATH_GOD_TARGET';

export const requiredKeys: RequiredKeys<PickKind> = [YESNO_SHEET, COMMON_SHEET, PICKER_SHEET, FACE_SHEET, CURSOR_SHEET];

/** 选择玩家窗的画点（棋盘视窗上部居中） */
export const PICKER_AT = { x: REGION.board.x + REGION.board.w / 2, y: REGION.board.y + 110 } as const;

export default function PickSeatScene(props: DecisionProps<PickKind>): ReactNode {
  const { t } = useTranslation();
  const lt = t as unknown as LooseT;
  const { view, map, isMine } = props;
  const d0 = narrowDecision(props.decision);
  const ctl = useDecision(props);
  const text = useGameText(view, map);
  const [pick, setPick] = useState<SeatIndex | null>(null);
  const candidates = d0.options.candidates;
  const scapegoat = d0.kind === 'SCAPEGOAT';

  useBoardHighlight(
    ctl.interactive
      ? { tiles: [], lots: [], seats: candidates, objects: [], selected: pick !== null ? { seat: pick } : null }
      : null,
  );
  const onBoard = useCallback(
    (p: BoardPick) => {
      const hit = candidates.find((seat) => {
        const pl = view.players.find((x) => x.seat === seat);
        return !!pl?.placed && pl.alive && pl.node === p.tile;
      });
      if (hit !== undefined) setPick(hit);
    },
    [candidates, view.players],
  );
  useBoardPick(ctl.interactive ? onBoard : null);
  useBoardCursor(ctl.interactive ? 'hand' : null);

  const picker = (
    <PlayerPicker
      x={PICKER_AT.x}
      y={PICKER_AT.y}
      seats={candidates}
      view={view}
      selected={pick}
      onPick={setPick}
      nameOf={(seat) => text.player(seat)}
      testIdOf={(seat) => (scapegoat ? `scapegoat-seat-${seat}` : `deathgod-seat-${seat}`)}
      noteOf={
        scapegoat
          ? undefined
          : (seat) => {
              const pl = view.players.find((x) => x.seat === seat);
              return pl ? `${t('dlg.common.cash')} ${formatMoney(pl.cash)}` : null;
            }
      }
      disabled={!ctl.interactive}
      label={scapegoat ? t('dlg.passive.scapegoatTitle') : t('dlg.deathGod.title')}
    />
  );

  if (d0.kind === 'SCAPEGOAT') {
    const o = d0.options;
    return (
      <DecisionStage
        ctl={ctl}
        decision={d0}
        view={view}
        map={map}
        isMine={isMine}
        label={t('dlg.passive.scapegoatTitle')}
        onClose={() => ctl.send({ type: 'DECLINE' })}
        closeButton={false}
        className={d.passThrough}
        countdownAt={{ x: REGION.board.x + REGION.board.w - 38, y: REGION.board.y + 6 }}
      >
        <CardArt card={CARD.SCAPEGOAT} x={CARD_SHOW_AT.x} y={CARD_SHOW_AT.y} testId="scapegoat-card-art" />
        {picker}
        <YesNoBox
          lines={5}
          onYes={() => pick !== null && ctl.send({ type: 'SCAPEGOAT', target: pick })}
          onNo={() => ctl.send({ type: 'DECLINE' })}
          yesDisabled={pick === null}
          yesLabel={
            pick === null ? t('dlg.passive.pickFirst') : t('dlg.passive.scapegoatTo', { name: text.player(pick) })
          }
          noLabel={t('dlg.passive.noScapegoat')}
          yesTestId="scapegoat-confirm"
          noTestId="scapegoat-decline"
          testId="classic-scapegoat-box"
        >
          <p style={TEXT.title}>{t('dlg.passive.scapegoatTitle')}</p>
          <p data-testid="scapegoat-text">{passiveText(lt, o.context, o.amount, o.days, null)}</p>
          <p>
            {pick === null ? t('dlg.passive.pickFirst') : t('dlg.passive.scapegoatTo', { name: text.player(pick) })}
          </p>
        </YesNoBox>
      </DecisionStage>
    );
  }

  return (
    <DecisionStage
      ctl={ctl}
      decision={d0}
      view={view}
      map={map}
      isMine={isMine}
      label={t('dlg.deathGod.title')}
      className={d.passThrough}
      countdownAt={{ x: REGION.board.x + REGION.board.w - 38, y: REGION.board.y + 6 }}
    >
      {picker}
      <ConfirmBox
        lines={5}
        yes={{
          label: pick === null ? t('dlg.deathGod.pickFirst') : t('dlg.deathGod.confirm', { name: text.player(pick) }),
          onClick: () => pick !== null && ctl.send({ type: 'DEATH_GOD_TARGET', target: pick }),
          disabled: pick === null,
          testId: 'deathgod-confirm',
        }}
        testId="classic-deathgod-box"
      >
        <p style={TEXT.title}>{t('dlg.deathGod.title')}</p>
        <p>{t('dlg.deathGod.body')}</p>
        <p>{pick === null ? t('dlg.deathGod.pickFirst') : t('dlg.deathGod.confirm', { name: text.player(pick) })}</p>
      </ConfirmBox>
    </DecisionStage>
  );
}
