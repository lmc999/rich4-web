// LOTTERY（乐透格）：36 个号码的网格，已售号码显示购买者的玩家色与形状并禁用；机选在未售号码里随机挑一个；显示奖池。
// 号码下标 0 = 显示的 1 号（LOTTERY_BUY.number 为下标）。
import type { SeatIndex } from '@rich4/shared/engine';
import clsx from 'clsx';
import { type CSSProperties, type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { seatColor } from '../components/Avatar';
import { Button } from '../components/Button';
import { SEAT_MARKS } from '../components/cardVisuals';
import { Money } from '../components/Money';
import { useGameText } from '../components/names';
import { Badge, KeyValues } from '../components/Panel';
import { DecisionFrame } from './DecisionFrame';
import s from './decisions.module.css';
import type { DecisionProps } from './types';
import { useDecision } from './useDecision';

/** 未售号码的下标 */
export function freeNumbers(sold: readonly (SeatIndex | null)[]): number[] {
  const out: number[] = [];
  sold.forEach((o, i) => {
    if (o === null) out.push(i);
  });
  return out;
}

/** 机选：在未售号码里等概率挑一个（random 注入以便测试）；全部售出时返回 null */
export function quickPick(sold: readonly (SeatIndex | null)[], random: () => number = Math.random): number | null {
  const free = freeNumbers(sold);
  if (free.length === 0) return null;
  const i = Math.min(free.length - 1, Math.floor(random() * free.length));
  return free[i]!;
}

export interface LotteryDialogProps extends DecisionProps<'LOTTERY'> {
  /** 机选用的随机源（测试注入） */
  random?: () => number;
}

export default function LotteryDialog(props: LotteryDialogProps): ReactNode {
  const { t } = useTranslation();
  const { view, map, isMine, decision: d } = props;
  const ctl = useDecision(props);
  const text = useGameText(view, map);
  const o = d.options;
  const [pick, setPick] = useState<number | null>(null);
  const free = freeNumbers(o.sold);
  const short = o.price > o.cash;
  const mine = o.sold.filter((x) => x === d.seat).length;

  return (
    <DecisionFrame
      ctl={ctl}
      kind={d.kind}
      seat={d.seat}
      view={view}
      isMine={isMine}
      title={t('dlg.lottery.title')}
      icon="🎱"
      tone="pink"
      actions={
        <>
          <Button variant="cream" onClick={() => ctl.send({ type: 'SKIP' })} data-testid="lottery-skip">
            {t('dlg.lottery.skip')}
          </Button>
          <Button
            variant="blue"
            disabled={free.length === 0}
            onClick={() => setPick(quickPick(o.sold, props.random))}
            data-testid="lottery-quick"
          >
            🎲 {t('dlg.lottery.quick')}
          </Button>
          <Button
            disabled={pick === null || short}
            onClick={() => pick !== null && ctl.send({ type: 'LOTTERY_BUY', number: pick })}
            data-testid="lottery-buy"
          >
            {pick === null ? t('dlg.lottery.pickFirst') : t('dlg.lottery.buy', { n: pick + 1 })}
          </Button>
        </>
      }
    >
      <div className={s.stack}>
        <div className={s.between}>
          <KeyValues
            rows={[
              [t('dlg.lottery.pool'), <Money key="p" value={o.pool} testId="lottery-pool" />],
              [t('dlg.lottery.price'), <Money key="c" value={o.price} />],
              [t('dlg.common.cash'), <Money key="h" value={o.cash} />],
            ]}
          />
          <Badge>{t('dlg.lottery.mine', { n: mine })}</Badge>
        </div>
        {short && (
          <p className={s.warn} role="alert">
            {t('dlg.common.notEnoughCash')}
          </p>
        )}
        <fieldset className={s.lotteryGrid} data-testid="lottery-grid">
          <legend className="visually-hidden">{t('dlg.lottery.numbers')}</legend>
          {o.sold.map((owner, i) => {
            const label =
              owner === null
                ? t('dlg.lottery.ballFree', { n: i + 1 })
                : t('dlg.lottery.ballSold', { n: i + 1, name: text.player(owner) });
            return (
              <button
                // biome-ignore lint/suspicious/noArrayIndexKey: 号码就是下标
                key={i}
                type="button"
                className={clsx(s.ball)}
                style={{ '--seat': seatColor(owner) } as CSSProperties}
                data-sold={owner !== null ? 'true' : 'false'}
                data-mine={owner === d.seat ? 'true' : 'false'}
                aria-pressed={pick === i}
                aria-label={label}
                title={label}
                disabled={owner !== null}
                onClick={() => setPick(i)}
                data-testid={`lottery-ball-${i + 1}`}
              >
                {i + 1}
                {owner !== null && (
                  <span className={s.ballMark} style={{ color: seatColor(owner) }} aria-hidden="true">
                    {SEAT_MARKS[owner]}
                  </span>
                )}
              </button>
            );
          })}
        </fieldset>
        <p className={s.muted}>{t('dlg.lottery.rule')}</p>
      </div>
    </DecisionFrame>
  );
}
