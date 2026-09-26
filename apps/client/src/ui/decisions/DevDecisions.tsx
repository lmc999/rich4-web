// /dev/decisions：用假数据逐个展示 23 种决策对话框与信息面板，便于目测（路由由主循环在 routes.tsx 注册）。
// 可切换「我的决策 / 只读等待态」、时限（30 秒 / 5 秒 / 不限时 / 已超时）、提交后「服务器接受」或「模拟 nack」。
import { DECISION_KINDS, type DecisionKind, type PlayerIntent, PlayerIntentSchema } from '@rich4/shared/engine';
import { type ReactNode, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'wouter';
import { Button } from '../components/Button';
import { useGameText } from '../components/names';
import { Panel } from '../components/Panel';
import { BankPanel } from '../panels/BankPanel';
import { InventoryPanel } from '../panels/InventoryPanel';
import { PlayerInfoPanel } from '../panels/PlayerInfoPanel';
import { PropertyListPanel } from '../panels/PropertyListPanel';
import { StockPanel } from '../panels/StockPanel';
import { TileInfoContent, TileInfoPopover } from '../panels/TileInfoPopover';
import { DecisionHost } from './DecisionHost';
import s from './decisions.module.css';
import { demoDecisions, demoMap, demoView } from './devFixtures';
import { type BoardBridge, BoardBridgeContext, type TargetHighlight } from './targeting';

type Limit = '30s' | '5s' | 'none' | 'expired';
const LIMIT_MS: Record<Limit, number | null> = { '30s': 30_000, '5s': 5_000, none: null, expired: -1 };

interface LogLine {
  n: number;
  kind: DecisionKind;
  intent: PlayerIntent;
  valid: boolean;
}

export default function DevDecisions(): ReactNode {
  const { t } = useTranslation();
  const map = useMemo(demoMap, []);
  const view = useMemo(() => demoView(map), [map]);
  const text = useGameText(view, map);
  const [isMine, setIsMine] = useState(true);
  const [limit, setLimit] = useState<Limit>('30s');
  const [nack, setNack] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [only, setOnly] = useState<DecisionKind | 'all'>('all');
  const [log, setLog] = useState<LogLine[]>([]);
  const [highlight, setHighlight] = useState<TargetHighlight | null>(null);
  const [tilePop, setTilePop] = useState<{ tile: number; at: { x: number; y: number } } | null>(null);

  const decisions = useMemo(() => {
    const all = demoDecisions(view, { now: Date.now(), timeoutMs: LIMIT_MS[limit] });
    for (const k of DECISION_KINDS) all[k].decisionId = `${all[k].decisionId}-${epoch}`;
    return all;
  }, [view, limit, epoch]);

  const bridge = useMemo<BoardBridge>(() => ({ highlight: setHighlight }), []);

  const submitFor =
    (kind: DecisionKind) =>
    (intent: PlayerIntent): Promise<boolean> | undefined => {
      const valid = PlayerIntentSchema.safeParse(intent).success;
      setLog((l) => [{ n: (l[0]?.n ?? 0) + 1, kind, intent, valid }, ...l].slice(0, 30));
      if (!nack) return undefined;
      return new Promise((r) => setTimeout(() => r(false), 600));
    };

  const kinds = only === 'all' ? DECISION_KINDS : [only];

  return (
    <BoardBridgeContext.Provider value={bridge}>
      <main className={s.devPage} data-testid="dev-decisions">
        <header className={`panel ${s.devHeader}`}>
          <h1>{t('dev.decisions.title')}</h1>
          <label className={s.row}>
            <input type="checkbox" checked={isMine} onChange={(e) => setIsMine(e.target.checked)} />
            {t('dev.decisions.isMine')}
          </label>
          <label className={s.row}>
            {t('dev.decisions.limit')}
            <select className="select" value={limit} onChange={(e) => setLimit(e.target.value as Limit)}>
              <option value="30s">30s</option>
              <option value="5s">5s</option>
              <option value="none">{t('cmp.countdown.unlimited')}</option>
              <option value="expired">{t('dev.decisions.expired')}</option>
            </select>
          </label>
          <label className={s.row}>
            <input type="checkbox" checked={nack} onChange={(e) => setNack(e.target.checked)} />
            {t('dev.decisions.nack')}
          </label>
          <label className={s.row}>
            {t('dev.decisions.only')}
            <select
              className="select"
              value={only}
              onChange={(e) => setOnly(e.target.value as DecisionKind | 'all')}
              data-testid="dev-only"
            >
              <option value="all">{t('dev.decisions.all')}</option>
              {DECISION_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          <Button size="sm" variant="blue" onClick={() => setEpoch((e) => e + 1)}>
            {t('dev.decisions.reset')}
          </Button>
          <Link href="/dev/gallery" className="btn btn--sm btn--cream">
            {t('nav.devGallery')}
          </Link>
          <Link href="/" className="btn btn--sm btn--cream">
            {t('common.back')}
          </Link>
        </header>

        <div className={s.devGrid} style={{ marginBottom: 16 }}>
          <Panel title={t('dev.decisions.log')} headingLevel={3}>
            <ol className={s.devLog} data-testid="dev-log">
              {log.map((l) => (
                <li key={l.n}>
                  <code>
                    {l.kind} → {JSON.stringify(l.intent)} {l.valid ? '✓' : '✗'}
                  </code>
                </li>
              ))}
            </ol>
          </Panel>
          <Panel title={t('dev.decisions.highlight')} headingLevel={3}>
            <pre className={s.devLog}>{highlight ? JSON.stringify(highlight) : '—'}</pre>
          </Panel>
        </div>

        <div className={s.devGrid}>
          {kinds.map((k) => (
            <section key={k} className={s.devCell}>
              <h2>{k}</h2>
              <DecisionHost decision={decisions[k]} isMine={isMine} view={view} map={map} submit={submitFor(k)} />
            </section>
          ))}
        </div>

        <h2 style={{ margin: '24px 0 12px', color: 'var(--c-ink)' }}>{t('dev.decisions.panels')}</h2>
        <div className={s.devGrid}>
          <Panel title={t('pnl.inventory.title')} headingLevel={3}>
            <InventoryPanel view={view} map={map} seat={0} menu={decisions.TURN_MENU.options} />
          </Panel>
          <Panel title={`${t('pnl.inventory.title')} · ${text.player(1)}`} headingLevel={3}>
            <InventoryPanel view={view} map={map} seat={1} />
          </Panel>
          <Panel title={t('pnl.stock.title')} headingLevel={3}>
            <StockPanel view={view} map={map} seat={0} />
          </Panel>
          <Panel title={t('pnl.bank.title')} headingLevel={3}>
            <BankPanel view={view} seat={2} />
          </Panel>
          {view.players.map((p) => (
            <Panel key={p.seat}>
              <PlayerInfoPanel view={view} map={map} seat={p.seat} />
            </Panel>
          ))}
          <Panel title={t('pnl.property.title')} headingLevel={3}>
            <PropertyListPanel view={view} map={map} viewer={0} />
          </Panel>
          <Panel title={t('pnl.tile.title')} headingLevel={3}>
            <TileInfoContent view={view} map={map} tile={6} viewer={0} />
            <div className={s.row} style={{ marginTop: 8 }}>
              {[5, 12, 17, 3].map((tile) => (
                <Button
                  key={tile}
                  size="sm"
                  variant="cream"
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setTilePop({ tile, at: { x: r.left + r.width / 2, y: r.top } });
                  }}
                >
                  {text.tile(tile)}
                </Button>
              ))}
            </div>
          </Panel>
        </div>
        <TileInfoPopover
          view={view}
          map={map}
          tile={tilePop?.tile ?? null}
          at={tilePop?.at ?? null}
          viewer={0}
          onClose={() => setTilePop(null)}
        />
      </main>
    </BoardBridgeContext.Provider>
  );
}
