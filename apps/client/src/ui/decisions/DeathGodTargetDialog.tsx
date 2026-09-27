// DEATH_GOD_TARGET（投降之后）：选一位对手，让死神附身到他身上（architecture §5.4 的 SeatPickDialog）
import type { SeatIndex } from '@rich4/shared/engine';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Avatar } from '../components/Avatar';
import { Button } from '../components/Button';
import { Money } from '../components/Money';
import { useGameText } from '../components/names';
import { DecisionFrame } from './DecisionFrame';
import s from './decisions.module.css';
import { playerOf } from './helpers';
import { useBoardHighlight } from './targeting';
import type { DecisionProps } from './types';
import { useDecision } from './useDecision';

export default function DeathGodTargetDialog(props: DecisionProps<'DEATH_GOD_TARGET'>): ReactNode {
  const { t } = useTranslation();
  const { view, map, isMine, decision: d } = props;
  const ctl = useDecision(props);
  const text = useGameText(view, map);
  const [pick, setPick] = useState<SeatIndex | null>(null);
  useBoardHighlight(
    ctl.interactive
      ? {
          tiles: [],
          lots: [],
          seats: d.options.candidates,
          objects: [],
          selected: pick !== null ? { seat: pick } : null,
        }
      : null,
  );

  return (
    <DecisionFrame
      ctl={ctl}
      kind={d.kind}
      seat={d.seat}
      view={view}
      isMine={isMine}
      title={t('dlg.deathGod.title')}
      icon="☠️"
      tone="purple"
      actions={
        <Button
          variant="purple"
          disabled={pick === null}
          onClick={() => pick !== null && ctl.send({ type: 'DEATH_GOD_TARGET', target: pick })}
          data-testid="deathgod-confirm"
        >
          {pick === null ? t('dlg.deathGod.pickFirst') : t('dlg.deathGod.confirm', { name: text.player(pick) })}
        </Button>
      }
    >
      <div className={s.stack}>
        <p className={s.note}>{t('dlg.deathGod.body')}</p>
        <ul className={s.choices}>
          {d.options.candidates.map((seat) => {
            const p = playerOf(view, seat);
            return (
              <li key={seat}>
                <button
                  type="button"
                  className={s.choice}
                  aria-pressed={pick === seat}
                  onClick={() => setPick(seat)}
                  data-testid={`deathgod-seat-${seat}`}
                >
                  {p && <Avatar character={p.character} seat={seat} size={36} />}
                  <span className={s.choiceMain}>
                    <strong>{text.player(seat)}</strong>
                    {p && (
                      <small>
                        {t('dlg.common.cash')} <Money value={p.cash} short />
                      </small>
                    )}
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
