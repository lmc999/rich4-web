// AUCTION_BID（拍卖，多人并发）：出价档 0（按起拍价）/100/500/1000/5000/10000、PASS（这一轮不加价）、QUIT（退出竞拍）。
// 每次有人加价，服务器都会带新价格与领先者重新询问（新 decisionId），价格与领先者随 options 实时刷新。
import type { BidIncrement } from '@rich4/shared/engine';
import { motion, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { PlayerChip } from '../components/Avatar';
import { BuildingPreview } from '../components/BuildingPreview';
import { Button } from '../components/Button';
import { formatInt } from '../components/format';
import { Money } from '../components/Money';
import { useGameText } from '../components/names';
import { KeyValues } from '../components/Panel';
import { DecisionFrame } from './DecisionFrame';
import s from './decisions.module.css';
import { lotStatus } from './helpers';
import type { DecisionProps } from './types';
import { useDecision } from './useDecision';

type Row = [ReactNode, ReactNode];

/** 出价后的新价格：无人领先时按起拍价 + inc，否则现价 + inc */
export function bidPrice(o: { leader: unknown; start: number; price: number }, inc: BidIncrement): number {
  return (o.leader === null ? o.start : o.price) + inc;
}

export default function AuctionDialog(props: DecisionProps<'AUCTION_BID'>): ReactNode {
  const { t } = useTranslation();
  const { view, map, isMine, decision: d } = props;
  const ctl = useDecision(props);
  const text = useGameText(view, map);
  const reduce = useReducedMotion();
  const o = d.options;
  const st = lotStatus(view, o.lot);
  const shown = o.leader === null ? o.start : o.price;

  return (
    <DecisionFrame
      ctl={ctl}
      kind={d.kind}
      seat={d.seat}
      view={view}
      isMine={isMine}
      title={t('dlg.auction.title')}
      subtitle={text.lot(o.lot)}
      icon="🔨"
      tone="red"
      actions={
        <>
          <Button variant="red" onClick={() => ctl.send({ type: 'QUIT' })} data-testid="auction-quit">
            {t('dlg.auction.quit')}
          </Button>
          <Button variant="cream" onClick={() => ctl.send({ type: 'PASS' })} data-testid="auction-pass">
            {t('dlg.auction.pass')}
          </Button>
        </>
      }
    >
      <div className={s.stack}>
        <div className={s.row} style={{ alignItems: 'center' }}>
          <BuildingPreview
            kind={st?.facility ? { t: 'facility', type: st.facility } : { t: 'house' }}
            level={o.level}
            owner={st?.owner ?? null}
            label={text.lot(o.lot)}
            size={88}
          />
          <div style={{ flex: 1 }}>
            <div className={s.muted}>{o.leader === null ? t('dlg.auction.startPrice') : t('dlg.auction.current')}</div>
            <motion.div
              key={shown}
              className={s.auctionPrice}
              data-testid="auction-price"
              aria-live="polite"
              initial={reduce ? false : { scale: 1.4, color: '#e53935' }}
              animate={{ scale: 1, color: '#3a2a1a' }}
            >
              {formatInt(shown)}
            </motion.div>
            <div data-testid="auction-leader">
              {o.leader === null ? (
                <span className={s.muted}>{t('dlg.auction.noLeader')}</span>
              ) : (
                <PlayerChip view={view} seat={o.leader} name={text.player(o.leader)}>
                  👑
                </PlayerChip>
              )}
            </div>
          </div>
        </div>
        <KeyValues
          rows={[
            ...(o.source ? [[t('dlg.auction.sourceLabel'), t(`dlg.auction.source.${o.source}`)] as Row] : []),
            [t('dlg.auction.seller'), o.seller === null ? t('dlg.auction.noSeller') : text.player(o.seller)],
            [t('dlg.auction.start'), <Money key="s" value={o.start} />],
            [t('dlg.buyLot.level'), t('dlg.common.levelN', { n: o.level })],
            [t('dlg.common.cash'), <Money key="c" value={o.cash} testId="auction-cash" />],
            ...(o.others === undefined
              ? []
              : [[t('dlg.auction.others'), t('dlg.auction.othersN', { n: o.others })] as Row]),
          ]}
        />
        <fieldset className={s.incGrid}>
          <legend className="visually-hidden">{t('dlg.auction.bids')}</legend>
          {o.increments.map((inc) => {
            const next = bidPrice(o, inc);
            return (
              <Button
                key={inc}
                variant={inc === 0 ? 'green' : 'sun'}
                disabled={next > o.cash}
                onClick={() => ctl.send({ type: 'BID', inc })}
                data-testid={`auction-bid-${inc}`}
                title={t('dlg.auction.bidTo', { price: formatInt(next) })}
              >
                {inc === 0 ? t('dlg.auction.bidStart') : `+${formatInt(inc)}`}
              </Button>
            );
          })}
        </fieldset>
        <p className={s.muted}>{t('dlg.auction.rule')}</p>
      </div>
    </DecisionFrame>
  );
}
