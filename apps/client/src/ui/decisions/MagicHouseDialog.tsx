// MAGIC_CAST（魔法屋）：女巫抽到的条件与被点名的玩家，选一个魔法效果施放在他们身上（不能放弃）。
import type { MagicEffectId } from '@rich4/shared/engine';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PlayerChip } from '../components/Avatar';
import { Button } from '../components/Button';
import { useGameText } from '../components/names';
import { DecisionFrame } from './DecisionFrame';
import s from './decisions.module.css';
import type { DecisionProps } from './types';
import { useDecision } from './useDecision';

export default function MagicHouseDialog(props: DecisionProps<'MAGIC_CAST'>): ReactNode {
  const { t } = useTranslation();
  const { view, map, isMine, decision: d } = props;
  const ctl = useDecision(props);
  const text = useGameText(view, map);
  const o = d.options;
  const [pick, setPick] = useState<MagicEffectId | null>(null);
  const includesMe = o.targets.includes(d.seat);

  return (
    <DecisionFrame
      ctl={ctl}
      kind={d.kind}
      seat={d.seat}
      view={view}
      isMine={isMine}
      title={t('dlg.magic.title')}
      icon="🔮"
      tone="purple"
      size="lg"
      actions={
        <Button
          variant="purple"
          disabled={pick === null}
          onClick={() => pick !== null && ctl.send({ type: 'MAGIC_CAST', effect: pick })}
          data-testid="magic-confirm"
        >
          {pick === null ? t('dlg.magic.pickFirst') : t('dlg.magic.cast', { name: text.magicEffect(pick) })}
        </Button>
      }
    >
      <div className={s.stack}>
        <p className={s.note} data-testid="magic-condition">
          {t('dlg.magic.condition', { cond: text.magicCondition(o.condition) })}
        </p>
        <div className={s.row} data-testid="magic-targets">
          {o.targets.map((seat) => (
            <PlayerChip key={seat} view={view} seat={seat} name={text.player(seat)} />
          ))}
        </div>
        {includesMe && <p className={s.warn}>{t('dlg.magic.includesMe')}</p>}
        <ul className={s.choices}>
          {o.effects.map((e) => (
            <li key={e}>
              <button
                type="button"
                className={s.choice}
                aria-pressed={pick === e}
                onClick={() => setPick(e)}
                data-testid={`magic-effect-${e}`}
              >
                <span className={s.choiceMain}>
                  <strong>{text.magicEffect(e)}</strong>
                  <small>{text.magicEffectDesc(e)}</small>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </DecisionFrame>
  );
}
