// DISCARD_CARD（手牌已满 15 张又得到新卡，handFull='choose'）：选一张手牌丢回牌堆
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../components/Button';
import { CardTile, TileGrid } from '../components/CardTile';
import { useGameText } from '../components/names';
import { DecisionFrame } from './DecisionFrame';
import s from './decisions.module.css';
import type { DecisionProps } from './types';
import { useDecision } from './useDecision';

export default function DiscardDialog(props: DecisionProps<'DISCARD_CARD'>): ReactNode {
  const { t } = useTranslation();
  const { view, map, isMine, decision: d } = props;
  const ctl = useDecision(props);
  const text = useGameText(view, map);
  const o = d.options;
  const [pick, setPick] = useState<number | null>(null);
  const row = o.hand.find((h) => h.slot === pick) ?? null;

  return (
    <DecisionFrame
      ctl={ctl}
      kind={d.kind}
      seat={d.seat}
      view={view}
      isMine={isMine}
      title={t('dlg.discard.title')}
      icon="🗑️"
      tone="orange"
      size="lg"
      actions={
        <Button
          variant="red"
          disabled={row === null}
          onClick={() => row && ctl.send({ type: 'DISCARD', slot: row.slot })}
          data-testid="discard-confirm"
        >
          {row ? t('dlg.discard.confirm', { name: text.card(row.card) }) : t('dlg.discard.pickFirst')}
        </Button>
      }
    >
      <div className={s.stack}>
        <div className={s.row}>
          <span>{t('dlg.discard.incoming')}</span>
          <CardTile
            card={o.incoming}
            name={text.card(o.incoming)}
            description={text.cardDesc(o.incoming)}
            width={84}
            testId="discard-incoming"
          />
        </div>
        <TileGrid label={t('dlg.discard.hand')}>
          {o.hand.map((h) => (
            <CardTile
              key={h.slot}
              card={h.card}
              name={text.card(h.card)}
              description={text.cardDesc(h.card)}
              price={h.price}
              selected={pick === h.slot}
              onClick={() => setPick(h.slot)}
              testId={`discard-${h.slot}`}
              width={84}
            />
          ))}
        </TileGrid>
      </div>
    </DecisionFrame>
  );
}
