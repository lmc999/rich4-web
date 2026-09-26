// 被动卡询问：USE_FREE_CARD（要付过路费 / 设施费 / 税款时，用免费卡免付？）与 SCAPEGOAT（嫁祸卡：把惩罚或费用转给谁？）
import { CARD, type PassiveContext, type SeatIndex } from '@rich4/shared/engine';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Avatar } from '../components/Avatar';
import { Button } from '../components/Button';
import { CardTile } from '../components/CardTile';
import { Money } from '../components/Money';
import { type LooseT, useGameText } from '../components/names';
import { DecisionFrame } from './DecisionFrame';
import s from './decisions.module.css';
import { playerOf } from './helpers';
import { useBoardHighlight } from './targeting';
import { type DecisionProps, narrowDecision } from './types';
import { useDecision } from './useDecision';

/** 场景文案（金额类 / 天数类） */
export function passiveText(
  lt: LooseT,
  ctx: PassiveContext,
  amount: number | null,
  days: number | null,
  lot: string | null,
): string {
  if (days !== null && (ctx === 'frame' || ctx === 'sleepwalk' || ctx === 'confine')) {
    return lt(`dlg.passive.ctxDays.${ctx}`, { days });
  }
  return lt(`dlg.passive.ctx.${ctx}`, { amount: amount ?? 0, lot: lot ?? '' });
}

export default function PassiveCardDialog(props: DecisionProps<'USE_FREE_CARD' | 'SCAPEGOAT'>): ReactNode {
  const { t } = useTranslation();
  const lt = t as unknown as LooseT;
  const { view, map, isMine } = props;
  const d = narrowDecision(props.decision);
  const ctl = useDecision(props);
  const text = useGameText(view, map);
  const [pick, setPick] = useState<SeatIndex | null>(null);
  const candidates = d.kind === 'SCAPEGOAT' ? d.options.candidates : [];
  useBoardHighlight(
    d.kind === 'SCAPEGOAT' && ctl.interactive
      ? { tiles: [], lots: [], seats: candidates, objects: [], selected: pick !== null ? { seat: pick } : null }
      : null,
  );

  if (d.kind === 'USE_FREE_CARD') {
    const o = d.options;
    return (
      <DecisionFrame
        ctl={ctl}
        kind={d.kind}
        seat={d.seat}
        view={view}
        isMine={isMine}
        title={t('dlg.passive.freeTitle')}
        icon="🆓"
        tone="blue"
        size="sm"
        actions={
          <>
            <Button variant="cream" onClick={() => ctl.send({ type: 'DECLINE' })} data-testid="free-decline">
              {t('dlg.passive.pay')}
            </Button>
            <Button variant="blue" onClick={() => ctl.send({ type: 'CONFIRM' })} data-testid="free-confirm">
              {t('dlg.passive.useFree')}
            </Button>
          </>
        }
      >
        <div className={s.row} style={{ alignItems: 'flex-start' }}>
          <CardTile card={CARD.FREE} name={text.card(CARD.FREE)} description={text.cardDesc(CARD.FREE)} />
          <div className={s.stack} style={{ flex: 1 }}>
            <p style={{ margin: 0 }} data-testid="free-text">
              {passiveText(lt, o.context, o.amount, null, o.lot ? text.lot(o.lot) : null)}
            </p>
            <p className={s.big}>
              <Money value={o.amount} testId="free-amount" />
            </p>
          </div>
        </div>
      </DecisionFrame>
    );
  }

  const o = d.options;
  return (
    <DecisionFrame
      ctl={ctl}
      kind={d.kind}
      seat={d.seat}
      view={view}
      isMine={isMine}
      title={t('dlg.passive.scapegoatTitle')}
      icon="🎭"
      tone="purple"
      actions={
        <>
          <Button variant="cream" onClick={() => ctl.send({ type: 'DECLINE' })} data-testid="scapegoat-decline">
            {t('dlg.passive.noScapegoat')}
          </Button>
          <Button
            variant="purple"
            disabled={pick === null}
            onClick={() => pick !== null && ctl.send({ type: 'SCAPEGOAT', target: pick })}
            data-testid="scapegoat-confirm"
          >
            {pick === null ? t('dlg.passive.pickFirst') : t('dlg.passive.scapegoatTo', { name: text.player(pick) })}
          </Button>
        </>
      }
    >
      <div className={s.stack}>
        <div className={s.row} style={{ alignItems: 'flex-start' }}>
          <CardTile
            card={CARD.SCAPEGOAT}
            name={text.card(CARD.SCAPEGOAT)}
            description={text.cardDesc(CARD.SCAPEGOAT)}
          />
          <p style={{ margin: 0, flex: 1 }} data-testid="scapegoat-text">
            {passiveText(lt, o.context, o.amount, o.days, null)}
          </p>
        </div>
        <ul className={s.choices}>
          {candidates.map((seat) => {
            const p = playerOf(view, seat);
            return (
              <li key={seat}>
                <button
                  type="button"
                  className={s.choice}
                  aria-pressed={pick === seat}
                  onClick={() => setPick(seat)}
                  data-testid={`scapegoat-seat-${seat}`}
                >
                  {p && <Avatar character={p.character} seat={seat} size={32} />}
                  <span className={s.choiceMain}>
                    <strong>{text.player(seat)}</strong>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </DecisionFrame>
  );
}
