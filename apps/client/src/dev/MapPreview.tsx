// /dev/map：地图预览开发页。渲染完整棋盘，可旋转 / 缩放 / 拖动，点击格子查看 TileDef，4 个角色沿路随机行走演示。
import type { AnyLot, MapDef } from '@rich4/shared/data';
import i18next from 'i18next';
import { type MouseEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'wouter';
import { GameRenderer } from '../game/GameRenderer';
import type { PickResult } from '../game/iso/picking';
import { MiniMapPainter, miniToWorld } from '../game/minimap/MiniMapPainter';
import { FACILITY_MAX_LEVEL, FACILITY_STYLES, MAX_HOUSE_LEVEL } from '../game/procedural/building/styles';
import { DEMO_CHARACTERS, runDemoWalk } from './demoWalk';
import styles from './MapPreview.module.css';
import { isFixtureChoice, type LoadedMap, loadMapDef, MAP_CHOICES, type MapChoice } from './mapSource';
import { exposeRenderer } from './testHooks';

const MINI_W = 220;
const MINI_H = 150;

/** 棋盘内招牌文字的 i18n 查询（键形如 "tiles:industry.bank"） */
function boardLabel(key: string): string | undefined {
  if (!i18next.isInitialized || !i18next.exists(key)) return undefined;
  return (i18next.t as unknown as (k: string) => string)(key);
}

function lotOf(def: MapDef, id: string | null): AnyLot | null {
  if (!id) return null;
  return [...def.lots, ...def.companies].find((l) => l.id === id) ?? null;
}

export default function MapPreview(): ReactNode {
  const { t } = useTranslation(['ui', 'tiles']);
  const hostRef = useRef<HTMLDivElement>(null);
  const miniRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<GameRenderer | null>(null);
  const painterRef = useRef<MiniMapPainter | null>(null);
  const walkRef = useRef<AbortController | null>(null);
  const [ready, setReady] = useState(false);
  const [choice, setChoice] = useState<MapChoice>('test-allkinds');
  const [loaded, setLoaded] = useState<LoadedMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rendered, setRendered] = useState(false);
  const [pick, setPick] = useState<PickResult | null>(null);
  const [rotation, setRotation] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [walking, setWalking] = useState(false);
  const [showIds, setShowIds] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [stats, setStats] = useState<ReturnType<GameRenderer['board']['stats']> | null>(null);

  // 挂载渲染器（StrictMode 下会挂载两次：异步创建完成前被卸载则立即销毁）
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let created: GameRenderer | null = null;
    GameRenderer.create({
      host,
      labels: { label: boardLabel },
      onTap: (p) => {
        setPick(p);
        rendererRef.current?.board.markers.select(p?.tile ?? null);
      },
      onDoubleTap: () => void rendererRef.current?.camera.fitAll(400),
    }).then(
      (r) => {
        if (cancelled) {
          r.destroy();
          return;
        }
        created = r;
        rendererRef.current = r;
        exposeRenderer(r);
        setReady(true);
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
      walkRef.current?.abort();
      created?.destroy();
      rendererRef.current = null;
      exposeRenderer(null);
      setReady(false);
    };
  }, []);

  // 读取地图
  useEffect(() => {
    let stale = false;
    setError(null);
    setLoaded(null);
    loadMapDef(choice).then(
      (m) => !stale && setLoaded(m),
      (e: unknown) =>
        !stale && setError(t('dev.map.loadFailed', { reason: e instanceof Error ? e.message : String(e) })),
    );
    return () => {
      stale = true;
    };
  }, [choice, t]);

  // 渲染地图（showIds 只在加载时同步一次，之后由开关单独处理）
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在渲染器就绪或地图变化时重建棋盘
  useEffect(() => {
    const r = rendererRef.current;
    if (!ready || !r || !loaded) return;
    walkRef.current?.abort();
    walkRef.current = null;
    r.follow(null);
    setWalking(false);
    setRendered(false);
    setPick(null);
    let stale = false;
    r.loadMap(loaded.def).then(() => {
      if (stale) return;
      r.board.markers.showIds(showIds);
      setStats(r.board.stats());
      setRotation(r.rotation);
      const ctx = miniRef.current?.getContext('2d');
      painterRef.current = ctx ? new MiniMapPainter(ctx, loaded.def, r.rotation, { w: MINI_W, h: MINI_H }) : null;
      setRendered(true);
    });
    return () => {
      stale = true;
    };
  }, [ready, loaded]);

  // 小地图与缩放读数：250ms 节流重绘
  useEffect(() => {
    if (!rendered) return;
    const id = window.setInterval(() => {
      const r = rendererRef.current;
      const painter = painterRef.current;
      if (!r) return;
      setZoom(r.camera.zoom);
      if (!painter) return;
      const { w, h } = { w: r.app.screen.width, h: r.app.screen.height };
      const viewport = [
        r.camera.screenToWorld({ x: 0, y: 0 }),
        r.camera.screenToWorld({ x: w, y: 0 }),
        r.camera.screenToWorld({ x: w, y: h }),
        r.camera.screenToWorld({ x: 0, y: h }),
      ];
      const players = r.board
        .allActors()
        .filter((a) => a.tile !== null)
        .map((a) => ({ seat: a.seat, tile: a.tile! }));
      painter.paint({ viewport, players });
    }, 250);
    return () => window.clearInterval(id);
  }, [rendered]);

  const rotate = useCallback((d: number) => {
    const r = rendererRef.current;
    if (!r) return;
    const rot = r.rotate(d);
    painterRef.current?.setRotation(rot);
    setRotation(rot);
  }, []);

  const zoomBy = useCallback((f: number) => {
    const r = rendererRef.current;
    if (!r) return;
    void r.camera.zoomTo(r.camera.zoom * f, 180, r.camera.screenAnchor());
    r.camera.onUserGesture();
  }, []);

  const fit = useCallback(() => void rendererRef.current?.camera.fitAll(350), []);

  const toggleWalk = useCallback(() => {
    const r = rendererRef.current;
    if (!r) return;
    if (walkRef.current) {
      walkRef.current.abort();
      walkRef.current = null;
      r.follow(null);
      setWalking(false);
      return;
    }
    const ac = new AbortController();
    walkRef.current = ac;
    setWalking(true);
    const names = DEMO_CHARACTERS.map((k) => (i18next.t as unknown as (k: string) => string)(`characters:${k}.name`));
    void runDemoWalk(r, names, ac.signal).finally(() => {
      if (walkRef.current === ac) walkRef.current = null;
    });
    r.follow(0);
  }, []);

  const randomLots = useCallback(() => {
    const r = rendererRef.current;
    if (!r?.board.loaded) return;
    const seat = (): number | null => (Math.random() < 0.2 ? null : Math.floor(Math.random() * 4));
    for (const id of r.board.landLotIds())
      r.board.setLotState(id, { owner: seat(), level: Math.floor(Math.random() * (MAX_HOUSE_LEVEL + 1)) });
    for (const id of r.board.facilityIds()) {
      const facility = FACILITY_STYLES[Math.floor(Math.random() * FACILITY_STYLES.length)]!;
      r.board.setLotState(id, {
        owner: seat(),
        level: 1 + Math.floor(Math.random() * FACILITY_MAX_LEVEL[facility]),
        facility,
      });
    }
    for (const id of r.board.companyIds()) r.board.setLotState(id, { owner: seat(), level: 1 });
  }, []);

  const clearLots = useCallback(() => rendererRef.current?.board.clearLotStates(), []);

  const onSpeed = (s: number): void => {
    setSpeed(s);
    rendererRef.current?.setSpeed(s);
  };

  const onIds = (on: boolean): void => {
    setShowIds(on);
    rendererRef.current?.board.markers.showIds(on);
  };

  // 键盘：Q/E 旋转、+/- 缩放、F 全图
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === 'q' || e.key === 'Q') rotate(-1);
      else if (e.key === 'e' || e.key === 'E') rotate(1);
      else if (e.key === '+' || e.key === '=') zoomBy(1.25);
      else if (e.key === '-') zoomBy(0.8);
      else if (e.key === 'f' || e.key === 'F') fit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rotate, zoomBy, fit]);

  const onMiniClick = (e: MouseEvent<HTMLCanvasElement>): void => {
    const r = rendererRef.current;
    const painter = painterRef.current;
    if (!r || !painter) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const p = miniToWorld(painter.layout, { x: e.clientX - rect.left, y: e.clientY - rect.top });
    r.camera.onUserGesture();
    void r.camera.panTo(p, 400);
  };

  const def = loaded?.def ?? null;
  const tile = def && pick?.tile != null ? (def.tiles.find((x) => x.id === pick.tile) ?? null) : null;
  const lot = def ? lotOf(def, pick?.lot ?? null) : null;
  const landmark = def && pick?.landmark ? (def.landmarks.find((m) => m.id === pick.landmark) ?? null) : null;
  const mapName = (key: string | undefined): string | undefined => (key && def ? def.strings['zh-CN'][key] : undefined);

  return (
    <div className={styles.page} data-testid="dev-map">
      <div ref={hostRef} className={styles.board} data-testid="board-host" />

      <div className={`panel ${styles.toolbar}`}>
        <h1>{t('dev.map.title')}</h1>
        <label className={styles.group}>
          <span>{t('dev.map.map')}</span>
          <select
            className="select"
            value={choice}
            onChange={(e) => setChoice(e.target.value as MapChoice)}
            data-testid="map-select"
          >
            {MAP_CHOICES.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <span className={styles.group}>
          <button
            type="button"
            className="btn btn--sm btn--cream"
            onClick={() => rotate(-1)}
            aria-keyshortcuts="Q"
            data-testid="rotate-left"
          >
            ⟲ {t('dev.map.rotateLeft')}
          </button>
          <button
            type="button"
            className="btn btn--sm btn--cream"
            onClick={() => rotate(1)}
            aria-keyshortcuts="E"
            data-testid="rotate-right"
          >
            {t('dev.map.rotateRight')} ⟳
          </button>
          <span className="num">{t('dev.map.rotation', { n: rotation + 1 })}</span>
        </span>
        <span className={styles.group}>
          <button
            type="button"
            className="btn btn--sm btn--cream"
            onClick={() => zoomBy(0.8)}
            aria-label={t('dev.map.zoomOut')}
          >
            －
          </button>
          <button
            type="button"
            className="btn btn--sm btn--cream"
            onClick={() => zoomBy(1.25)}
            aria-label={t('dev.map.zoomIn')}
          >
            ＋
          </button>
          <button type="button" className="btn btn--sm btn--cream" onClick={fit} aria-keyshortcuts="F">
            {t('dev.map.fitAll')}
          </button>
          <span className="num">{t('dev.map.zoom', { z: zoom.toFixed(2) })}</span>
        </span>
        <span className={styles.group}>
          <button
            type="button"
            className="btn btn--sm btn--green"
            onClick={toggleWalk}
            disabled={!rendered}
            data-testid="walk-toggle"
          >
            {walking ? t('dev.map.walkStop') : t('dev.map.walkStart')}
          </button>
          <button
            type="button"
            className="btn btn--sm"
            onClick={randomLots}
            disabled={!rendered}
            data-testid="random-lots"
          >
            {t('dev.map.randomLots')}
          </button>
          <button type="button" className="btn btn--sm btn--cream" onClick={clearLots} disabled={!rendered}>
            {t('dev.map.clearLots')}
          </button>
          <select className="select" value={speed} onChange={(e) => onSpeed(Number(e.target.value))} aria-label="speed">
            {[1, 2, 3].map((s) => (
              <option key={s} value={s}>
                {s}x
              </option>
            ))}
          </select>
          <label className={styles.group}>
            <input type="checkbox" checked={showIds} onChange={(e) => onIds(e.target.checked)} />
            ID
          </label>
          <Link href="/" className="btn btn--sm btn--blue">
            {t('common.back')}
          </Link>
        </span>
        <div className={styles.meta}>
          {t('dev.map.hint')}
          {loaded && stats && (
            <>
              {' '}
              ·{' '}
              {t('dev.map.stats', {
                tiles: stats.tiles,
                lots: stats.lots + stats.facilities,
                companies: stats.companies,
                landmarks: stats.landmarks,
                via: stats.viaCells,
              })}{' '}
              · {t('dev.map.issues', { errors: loaded.errors, warns: loaded.warns })} · {loaded.source}
            </>
          )}
        </div>
        {error && (
          <div className={styles.error} role="alert" data-testid="map-error">
            {error}
            {!isFixtureChoice(choice) && <div>{t('dev.map.dataHint', { id: choice })}</div>}
          </div>
        )}
      </div>

      <aside className={`panel ${styles.info}`} data-testid="tile-info">
        <h2>{t('dev.map.selected')}</h2>
        {!pick && <p>{t('dev.map.none')}</p>}
        {pick && (
          <div className={styles.kv}>
            <span>{t('dev.map.cell')}</span>
            <span className="num">
              ({pick.cell.x}, {pick.cell.y})
            </span>
            <span>{t('dev.map.terrain')}</span>
            <span>{pick.terrain ?? '—'}</span>
            {pick.road && (
              <>
                <span>{t('dev.map.road')}</span>
                <span>✓</span>
              </>
            )}
          </div>
        )}
        {tile && (
          <>
            <h2 style={{ marginTop: 10 }}>
              #{tile.id} · {t(`tiles:kind.${tile.kind}`)}
            </h2>
            <pre data-testid="tile-json">{JSON.stringify(tile, null, 1)}</pre>
          </>
        )}
        {lot && (
          <>
            <h2 style={{ marginTop: 10 }}>
              {lot.id} · {mapName(lot.nameKey) ?? ''}
            </h2>
            <pre>{JSON.stringify(lot, null, 1)}</pre>
          </>
        )}
        {landmark && (
          <>
            <h2 style={{ marginTop: 10 }}>
              {t(`tiles:landmark.${landmark.kind}`)} · {mapName(landmark.nameKey) ?? ''}
            </h2>
            <pre>{JSON.stringify(landmark, null, 1)}</pre>
          </>
        )}
      </aside>

      <div className={`panel ${styles.minimap}`}>
        <canvas ref={miniRef} width={MINI_W} height={MINI_H} onClick={onMiniClick} aria-label="minimap" />
      </div>

      {!rendered && !error && (
        <div className={`panel ${styles.status}`} role="status">
          {t('dev.map.loading')}
        </div>
      )}
    </div>
  );
}
