// PlayerInfoPanel（design/client.md §5.1、§5.4）：点玩家头像查看——资金、点券、卡片数、道具数、交通工具、附身神明、
// 各种状态天数、地产、股票市值与总资产（总资产用 shared 的 netWorth 选择器，与引擎同算法）。
import type { MapIndex } from '@rich4/shared/data';
import { type Counters2, netWorth, type SeatIndex } from '@rich4/shared/engine';
import type { GameView } from '@rich4/shared/view';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Avatar } from '../components/Avatar';
import { counterDays, stockAmount } from '../components/format';
import { Money } from '../components/Money';
import { type LooseT, useGameText } from '../components/names';
import { Badge } from '../components/Panel';
import s from './panels.module.css';

/** 阻碍计数的剩余天数（两段式编码，见 components/format.counterDays） */
export { counterDays };

const STATUS_KEYS = [
  'jail',
  'hospital',
  'hotel',
  'away',
  'hibernate',
  'sleepwalk',
  'stay',
  'tortoise',
] as const satisfies readonly (keyof Counters2)[];

export interface PlayerSummary {
  cash: number;
  deposit: number;
  loan: number;
  points: number;
  cardCount: number;
  itemCount: number;
  lands: number;
  facilities: number;
  houses: number;
  stockValue: number;
  netWorth: number;
}

/** 汇总（纯函数，面板与测试共用） */
export function summarizePlayer(view: GameView, map: MapIndex, seat: SeatIndex): PlayerSummary | null {
  const p = view.players.find((x) => x.seat === seat);
  if (!p) return null;
  let stockValue = 0;
  view.stocks.forEach((st, i) => {
    stockValue += stockAmount(st.priceCents, p.holdings[i]?.shares ?? 0);
  });
  const lands = view.lands.filter((l) => l.owner === seat);
  const facilities = view.facilities.filter((f) => f.owner === seat);
  return {
    cash: p.cash,
    deposit: p.deposit,
    loan: p.loan,
    points: p.points,
    cardCount: p.cardCount,
    itemCount: p.items.reduce((a, b) => a + b, 0),
    lands: lands.length,
    facilities: facilities.length,
    houses: lands.reduce((a, l) => a + l.level, 0),
    stockValue,
    netWorth: netWorth(view, map, seat),
  };
}

export interface PlayerInfoPanelProps {
  view: GameView;
  map: MapIndex;
  seat: SeatIndex;
}

export function PlayerInfoPanel({ view, map, seat }: PlayerInfoPanelProps): ReactNode {
  const { t } = useTranslation();
  const lt = t as unknown as LooseT;
  const text = useGameText(view, map);
  const p = view.players.find((x) => x.seat === seat);
  const sum = summarizePlayer(view, map, seat);
  if (!p || !sum) return null;
  const statuses = STATUS_KEYS.filter((k) => p.st[k] !== 0);
  const ownedLots = [...view.lands.filter((l) => l.owner === seat), ...view.facilities.filter((f) => f.owner === seat)];

  return (
    <section
      className={s.panel}
      aria-label={t('pnl.player.title', { name: text.player(seat) })}
      data-testid="player-info"
    >
      <header className={s.head}>
        <Avatar character={p.character} seat={seat} size={56} expr={p.alive ? 'normal' : 'sad'} />
        <h2>{text.player(seat)}</h2>
        {!p.alive && <Badge>{lt(`pnl.player.out.${p.out ?? 'bankrupt'}`)}</Badge>}
        {p.controller === 'ai' && <Badge>{t('pnl.player.ai')}</Badge>}
      </header>
      <div className={s.stats}>
        <div className={s.stat}>
          <span>{t('pnl.bank.cash')}</span>
          <Money value={sum.cash} testId="info-cash" />
        </div>
        <div className={s.stat}>
          <span>{t('pnl.bank.deposit')}</span>
          <Money value={sum.deposit} testId="info-deposit" />
        </div>
        {sum.loan > 0 && (
          <div className={s.stat}>
            <span>{t('pnl.bank.loan')}</span>
            <Money value={sum.loan} />
          </div>
        )}
        <div className={s.stat}>
          <span>{t('pnl.inventory.points')}</span>
          <Money value={sum.points} unit="points" testId="info-points" />
        </div>
        <div className={s.stat}>
          <span>{t('pnl.player.stockValue')}</span>
          <Money value={sum.stockValue} testId="info-stock-value" />
        </div>
        <div className={s.stat}>
          <span>{t('pnl.player.netWorth')}</span>
          <Money value={sum.netWorth} testId="info-net-worth" />
        </div>
      </div>
      <div className={s.badges}>
        <Badge>{t('pnl.player.cards', { n: sum.cardCount })}</Badge>
        <Badge>{t('pnl.player.items', { n: sum.itemCount })}</Badge>
        <Badge>{t('pnl.player.lots', { n: sum.lands + sum.facilities, houses: sum.houses })}</Badge>
        <Badge>{text.vehicle(p.vehicle)}</Badge>
        {p.god && (
          <Badge>
            {text.god(p.god.kind)} · {t('pnl.player.days', { n: p.god.days })}
          </Badge>
        )}
        {p.alliance && (
          <Badge>{t('pnl.player.alliance', { name: text.player(p.alliance.seat), n: p.alliance.days })}</Badge>
        )}
        {p.bomb && <Badge>💣 {t('pnl.player.bomb', { n: p.bomb.fuse })}</Badge>}
        {p.insuranceDays > 0 && <Badge>{t('pnl.player.insurance', { n: counterDays(p.insuranceDays) })}</Badge>}
        {statuses.map((k) => (
          <Badge key={k}>
            {lt(`game:status.${k}`)} · {t('pnl.player.days', { n: counterDays(p.st[k]) })}
          </Badge>
        ))}
      </div>
      {ownedLots.length > 0 && (
        <p className={s.muted} data-testid="info-lots">
          {ownedLots.map((l) => `${text.lot(l.id)} Lv${l.level}`).join('、')}
        </p>
      )}
    </section>
  );
}
