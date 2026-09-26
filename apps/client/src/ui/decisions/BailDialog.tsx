// BAIL（监狱或医院的保释格）：花点券保释在押 / 住院的玩家，或雇用住在这里的恶人；也可以什么都不做。
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Avatar } from '../components/Avatar';
import { Button } from '../components/Button';
import { Money } from '../components/Money';
import { useGameText } from '../components/names';
import { Badge } from '../components/Panel';
import { DecisionFrame } from './DecisionFrame';
import s from './decisions.module.css';
import { playerOf } from './helpers';
import type { DecisionProps } from './types';
import { useDecision } from './useDecision';

const VILLAIN_ICON = { thief: '🥷', robber: '🦹', thug: '👊', spy: '🕵️' } as const;

export default function BailDialog(props: DecisionProps<'BAIL'>): ReactNode {
  const { t } = useTranslation();
  const { view, map, isMine, decision: d } = props;
  const ctl = useDecision(props);
  const text = useGameText(view, map);
  const o = d.options;
  const jail = o.where === 'jail';
  const canBail = o.points >= o.costs.bail;
  const canHire = o.points >= o.costs.hire;

  return (
    <DecisionFrame
      ctl={ctl}
      kind={d.kind}
      seat={d.seat}
      view={view}
      isMine={isMine}
      title={t(jail ? 'dlg.bail.titleJail' : 'dlg.bail.titleHospital')}
      icon={jail ? '🚔' : '🏥'}
      tone="blue"
      actions={
        <Button variant="cream" onClick={() => ctl.send({ type: 'SKIP' })} data-testid="bail-skip">
          {t('dlg.bail.skip')}
        </Button>
      }
    >
      <div className={s.stack}>
        <div className={s.row}>
          <Badge>
            {t('dlg.common.points')} <Money value={o.points} unit="points" />
          </Badge>
        </div>
        <section>
          <h3 className={s.muted} style={{ margin: '0 0 4px' }}>
            {t(jail ? 'dlg.bail.inmatesJail' : 'dlg.bail.inmatesHospital')}
          </h3>
          {o.inmates.length === 0 ? (
            <p className={s.muted}>{t('dlg.bail.noInmates')}</p>
          ) : (
            <ul className={s.choices}>
              {o.inmates.map((m) => {
                const p = playerOf(view, m.seat);
                return (
                  <li key={m.seat}>
                    <button
                      type="button"
                      className={s.choice}
                      disabled={!canBail}
                      onClick={() => ctl.send({ type: 'BAIL', seat: m.seat })}
                      data-testid={`bail-seat-${m.seat}`}
                    >
                      {p && <Avatar character={p.character} seat={m.seat} size={32} />}
                      <span className={s.choiceMain}>
                        <strong>{text.player(m.seat)}</strong>
                        <small>{t('dlg.bail.remaining', { n: m.remaining })}</small>
                      </span>
                      <small>
                        {t('dlg.bail.bailFor')} <Money value={o.costs.bail} unit="points" />
                      </small>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        <section>
          <h3 className={s.muted} style={{ margin: '0 0 4px' }}>
            {t('dlg.bail.villains')}
          </h3>
          <ul className={s.choices}>
            {o.villains.map((v) => (
              <li key={v.kind}>
                <button
                  type="button"
                  className={s.choice}
                  disabled={!v.available || !canHire}
                  onClick={() => ctl.send({ type: 'HIRE', villain: v.kind })}
                  data-testid={`bail-hire-${v.kind}`}
                >
                  <span style={{ fontSize: 24 }} aria-hidden="true">
                    {VILLAIN_ICON[v.kind]}
                  </span>
                  <span className={s.choiceMain}>
                    <strong>{text.villain(v.kind)}</strong>
                    <small>{v.available ? t(`dlg.bail.villainDesc.${v.kind}`) : t('dlg.bail.villainAway')}</small>
                  </span>
                  <small>
                    {t('dlg.bail.hireFor')} <Money value={o.costs.hire} unit="points" />
                  </small>
                </button>
              </li>
            ))}
          </ul>
        </section>
        {(!canBail || !canHire) && <p className={s.muted}>{text.reason('notEnoughPoints')}</p>}
      </div>
    </DecisionFrame>
  );
}
