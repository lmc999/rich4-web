// BIRTHDAY_PICK（命运「生日」）：每位有卡的对手送你 1 张，由你从他们的手牌里各挑一张。默认预选每人的第一张。
import type { SeatIndex } from '@rich4/shared/engine';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PlayerChip } from '../components/Avatar';
import { Button } from '../components/Button';
import { CardTile, TileGrid } from '../components/CardTile';
import { useGameText } from '../components/names';
import { DecisionFrame } from './DecisionFrame';
import s from './decisions.module.css';
import type { DecisionProps } from './types';
import { useDecision } from './useDecision';

export default function BirthdayPickDialog(props: DecisionProps<'BIRTHDAY_PICK'>): ReactNode {
  const { t } = useTranslation();
  const { view, map, isMine, decision: d } = props;
  const ctl = useDecision(props);
  const text = useGameText(view, map);
  const victims = d.options.victims.filter((v) => v.cards.length > 0);
  const [picks, setPicks] = useState<Partial<Record<SeatIndex, number>>>(() => {
    const init: Partial<Record<SeatIndex, number>> = {};
    for (const v of victims) init[v.seat] = v.cards[0]!.slot;
    return init;
  });
  const complete = victims.every((v) => picks[v.seat] !== undefined);

  const confirm = (): void => {
    ctl.send({
      type: 'PICK_CARDS',
      picks: victims.map((v) => ({ from: v.seat, slot: picks[v.seat] ?? v.cards[0]!.slot })),
    });
  };

  return (
    <DecisionFrame
      ctl={ctl}
      kind={d.kind}
      seat={d.seat}
      view={view}
      isMine={isMine}
      title={t('dlg.birthday.title')}
      icon="🎂"
      tone="pink"
      size="lg"
      actions={
        <Button onClick={confirm} disabled={!complete} data-testid="birthday-confirm">
          {t('dlg.birthday.confirm')}
        </Button>
      }
    >
      <div className={s.stack}>
        <p className={s.note}>{t('dlg.birthday.body')}</p>
        {victims.length === 0 && <p className={s.muted}>{t('dlg.birthday.none')}</p>}
        {victims.map((v) => (
          <section key={v.seat} data-testid={`birthday-victim-${v.seat}`}>
            <PlayerChip view={view} seat={v.seat} name={text.player(v.seat)} />
            <TileGrid label={text.player(v.seat)}>
              {v.cards.map((c) => (
                <CardTile
                  key={c.slot}
                  card={c.card}
                  name={text.card(c.card)}
                  description={text.cardDesc(c.card)}
                  selected={picks[v.seat] === c.slot}
                  onClick={() => setPicks((p) => ({ ...p, [v.seat]: c.slot }))}
                  testId={`birthday-${v.seat}-${c.slot}`}
                  width={84}
                />
              ))}
            </TileGrid>
          </section>
        ))}
      </div>
    </DecisionFrame>
  );
}
