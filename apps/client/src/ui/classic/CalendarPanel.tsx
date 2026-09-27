// 右下日历区（Panel#2，贴 (440,280) 200×200）：太阳钮 = 日历（四季风景 + 大字日期）、月亮钮 = 月历（淡化风景 +
// S M T W T F S + 整月日期，今天加框）；节日当天换成节日插画（台湾图 Data#4–27），节日过去回到原来的模式；
// 右上角切换到缩小地图（地块主人色、玩家点、视口框；点选平移镜头；下方两颗旋转钮 Data#476 图18–21）。
// 日期、星期、节日名都用 DOM 文字（原版为 GDI 文字）；坐标按月历页图目视取值。
import type { MapIndex } from '@rich4/shared/data';
import type { GameView } from '@rich4/shared/view';
import clsx from 'clsx';
import { type MouseEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import type { Pt } from '../../game/iso/projection';
import { MiniMapPainter, miniToWorld } from '../../game/minimap/MiniMapPainter';
import { useTx } from '../../i18n/tx';
import { holidayName } from '../../presentation/names';
import { type SurfaceRotation, toProceduralRotation } from '../../skin/BoardSurface';
import { lotOwners } from '../hud/MiniMap';
import { ensureClassicImage, holidayArtKey, useClassicAssets } from './assets';
import { useClassicBox } from './ClassicStage';
import { type CalendarMode, dayFrame, monthFrame, monthGrid, seasonOf, ymd } from './calendar';
import c from './classic.module.css';
import { REGION, regionStyle } from './layout';
import { Sprite, useSheetStatus } from './Sprite';

/**
 * 月历网格：对齐页图上烘焙的 S M T W T F S。月历页图（Panel#2 图4–7）7 个星期圆圈实测列中心
 * 30.5、53.5、76.5、98.5、121.5、144.5、166.5（间距约 22.67），按首尾两列取等距：
 * 列中心 x = 30.5 + (136 / 6)·列，即 left = 30.5 − colW / 2；首行 y = 92
 */
export const MONTH_GRID = { left: 30.5 - 68 / 6, top: 92, colW: 136 / 6, rowH: 15 } as const;
/**
 * 太阳 / 月亮钮：与月历页图上烘焙的图标重合（逐像素比对：太阳 = 图9 画在 (10,9)，月亮 = 图10 画在 (42,11)）。
 * 日历页图（图0–3）没有烘焙图标，钮的位置保持一致
 */
export const SUN_RECT = { x: 10, y: 9, w: 24, h: 23 } as const;
export const MOON_RECT = { x: 42, y: 11, w: 20, h: 20 } as const;
export const MINI_REPAINT_MS = 250;

export interface CalendarPanelProps {
  view: GameView;
  map: MapIndex | null;
  rotation: SurfaceRotation;
  viewport?: () => Pt[] | null;
  onPan?(world: Pt): void;
  onRotate?(dir: -1 | 1): void;
  /** 初始模式（缺省月历） */
  initialMode?: CalendarMode;
}

function MiniMapBox({
  view,
  map,
  rotation,
  viewport,
  onPan,
  onRotate,
}: Required<Pick<CalendarPanelProps, 'view' | 'rotation'>> & {
  map: MapIndex;
  viewport?: () => Pt[] | null;
  onPan?(world: Pt): void;
  onRotate?(dir: -1 | 1): void;
}): ReactNode {
  const t = useTx();
  const box = useClassicBox();
  const ref = useRef<HTMLCanvasElement>(null);
  const painter = useRef<MiniMapPainter | null>(null);
  const latest = useRef(view);
  latest.current = view;
  // 画布按实际显示尺寸（舞台缩放 × 设备像素比）渲染，避免放大后发糊
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const px = Math.max(100, Math.round(200 * (box?.scale ?? 1) * dpr));
  const rot4 = toProceduralRotation(rotation);

  useEffect(() => {
    const ctx = ref.current?.getContext('2d') ?? null;
    painter.current = ctx ? new MiniMapPainter(ctx, map.def, rot4, { w: px, h: px }) : null;
  }, [map, rot4, px]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 画家随 px / 旋转 / 地图重建后要立即重画
  useEffect(() => {
    const paint = (): void => {
      const p = painter.current;
      if (!p) return;
      const v = latest.current;
      const vp = viewport?.() ?? null;
      p.paint({
        owners: lotOwners(v),
        players: v.players.filter((x) => x.placed && x.node > 0).map((x) => ({ seat: x.seat, tile: x.node })),
        ...(vp ? { viewport: vp } : {}),
      });
    };
    paint();
    const id = setInterval(paint, MINI_REPAINT_MS);
    return () => clearInterval(id);
  }, [viewport, px, rot4, map]);

  const onClick = (e: MouseEvent<HTMLCanvasElement>): void => {
    const p = painter.current;
    if (!p || !onPan) return;
    const r = e.currentTarget.getBoundingClientRect();
    const sx = (e.clientX - r.left) * (px / Math.max(1, r.width));
    const sy = (e.clientY - r.top) * (px / Math.max(1, r.height));
    onPan(miniToWorld(p.layout, { x: sx, y: sy }));
  };

  return (
    <div className={c.miniBox} data-testid="classic-minimap">
      <canvas ref={ref} width={px} height={px} onClick={onClick} aria-label={t('classic:calendar.map')} />
      {([-1, 1] as const).map((dir) => (
        <button
          key={dir}
          type="button"
          className={c.rotBtn}
          style={dir < 0 ? { left: 4 } : { right: 4 }}
          data-dir={dir < 0 ? 'left' : 'right'}
          onClick={() => onRotate?.(dir)}
          aria-label={dir < 0 ? t('hud:board.rotateLeft') : t('hud:board.rotateRight')}
          data-testid={dir < 0 ? 'rotate-left' : 'rotate-right'}
        >
          <Sprite
            sheet="ui.common"
            frame={dir < 0 ? 18 : 19}
            x={0}
            y={0}
            origin="topLeft"
            className={c.rotNormal}
            fallback={
              <span className={c.rotFallback} aria-hidden="true">
                {dir < 0 ? '⟲' : '⟳'}
              </span>
            }
          />
          <Sprite sheet="ui.common" frame={dir < 0 ? 20 : 21} x={0} y={0} origin="topLeft" className={c.rotHover} />
        </button>
      ))}
    </div>
  );
}

export function CalendarPanel({
  view,
  map,
  rotation,
  viewport,
  onPan,
  onRotate,
  initialMode = 'month',
}: CalendarPanelProps): ReactNode {
  const t = useTx();
  const [mode, setMode] = useState<CalendarMode>(initialMode);
  /** 节日时自动切到日历（插画），节日过去后回到这里记下的模式 */
  const before = useRef<CalendarMode | null>(null);
  const calStatus = useSheetStatus('ui.calendar');
  const art = calStatus === 'ready';
  const packId = useClassicAssets((s) => s.packId);
  const clock = view.clock;
  const { y, m, d } = ymd(clock.date);
  const mapId = view.dataRef.mapId;
  const holiday = clock.holiday;
  const holidayText = holiday ? holidayName(t, mapId, holiday) : null;
  const artKey = holidayArtKey(mapId, holiday);
  const holidayImg = useClassicAssets((s) => (artKey ? (s.images[artKey] ?? null) : null));

  // biome-ignore lint/correctness/useExhaustiveDependencies: 换了素材包（packId）要重新取插画 URL
  useEffect(() => {
    if (artKey) ensureClassicImage(artKey);
  }, [artKey, packId]);

  useEffect(() => {
    if (holiday) {
      setMode((cur) => {
        if (before.current === null) before.current = cur;
        return cur === 'map' ? cur : 'day';
      });
    } else if (before.current !== null) {
      const back = before.current;
      before.current = null;
      setMode((cur) => (cur === 'day' ? back : cur));
    }
  }, [holiday]);

  const choose = (next: CalendarMode): void => {
    // 手动选择后不再在节日结束时切回
    before.current = null;
    setMode(next);
  };

  const showHolidayArt = mode === 'day' && holiday !== null;
  const grid = mode === 'month' ? monthGrid(clock.date, clock.weekday) : null;
  const weekdays = [0, 1, 2, 3, 4, 5, 6].map((i) => t(`classic:calendar.weekdays.${i}`));

  return (
    <section
      className={`${c.region} ${c.calendar}`}
      style={regionStyle(REGION.calendar)}
      aria-label={t(`classic:calendar.${mode}`)}
      data-testid="classic-calendar"
      data-mode={mode}
      data-holiday={holiday ?? ''}
    >
      <span className={c.srOnly} data-testid="hud-date" data-date={clock.date}>
        {t('classic:calendar.yearMonth', { y, m })} {t('classic:calendar.monthDay', { m, d })}
      </span>
      {mode === 'map' && map ? (
        <MiniMapBox view={view} map={map} rotation={rotation} viewport={viewport} onPan={onPan} onRotate={onRotate} />
      ) : (
        <>
          {showHolidayArt ? (
            holidayImg ? (
              <span
                className={c.calBg}
                style={{ backgroundImage: `url("${holidayImg.url}")` }}
                data-testid="classic-cal-bg"
                data-bg={artKey ?? ''}
              />
            ) : (
              <span className={c.calHolidayFallback} data-testid="classic-cal-bg" data-bg="holiday-fallback">
                <span className={c.outline}>{holidayText ?? t('events:holiday.generic')}</span>
              </span>
            )
          ) : art ? (
            <span data-testid="classic-cal-bg" data-bg={`ui.calendar/${mode === 'day' ? dayFrame(m) : monthFrame(m)}`}>
              <Sprite sheet="ui.calendar" frame={mode === 'day' ? dayFrame(m) : monthFrame(m)} x={0} y={0} />
            </span>
          ) : calStatus === 'loading' ? null : (
            <span
              className={clsx(c.calBg, c.calFallback)}
              data-season={seasonOf(m)}
              data-wash={mode === 'month' ? 'true' : 'false'}
              data-testid="classic-cal-bg"
              data-bg={`fallback-${mode}-${seasonOf(m)}`}
            />
          )}
          {mode === 'day' && !showHolidayArt && (
            <div className={clsx(c.dayBig, c.outline)} data-testid="classic-day">
              <span className={c.dayYear}>{y}</span>
              <span className={c.dayMonthDay}>{t('classic:calendar.monthDay', { m, d })}</span>
              <span className={c.dayWeek}>{t(`classic:calendar.weekdays.${clock.weekday}`)}</span>
            </div>
          )}
          {grid && (
            <>
              <span className={clsx(c.calHeader, c.outline)} data-testid="classic-month-title">
                {t('classic:calendar.yearMonth', { y, m })}
                {holidayText ? ` · ${holidayText}` : ''}
              </span>
              {!art && (
                <div className={c.weekRow} aria-hidden="true">
                  {weekdays.map((w, i) => (
                    <span key={w + String(i)}>{w}</span>
                  ))}
                </div>
              )}
              <table
                className={c.monthGrid}
                style={{
                  left: MONTH_GRID.left,
                  top: MONTH_GRID.top,
                  width: MONTH_GRID.colW * 7,
                }}
                data-testid="classic-month"
              >
                <thead className={c.srOnly}>
                  <tr>
                    {weekdays.map((w, i) => (
                      <th key={w + String(i)} scope="col">
                        {w}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {grid.weeks.map((week) => (
                    <tr key={week.join('-')} style={{ height: MONTH_GRID.rowH }}>
                      {week.map((day, i) => (
                        <td
                          // biome-ignore lint/suspicious/noArrayIndexKey: 固定 7 列
                          key={i}
                          className={day ? c.outline : undefined}
                          data-today={day === grid.today ? 'true' : undefined}
                          aria-current={day === grid.today ? 'date' : undefined}
                        >
                          {day || ''}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {holidayText && mode === 'day' && (
            <span className={holidayImg ? c.srOnly : clsx(c.holidayName, c.outline)} data-testid="classic-holiday-name">
              {holidayText}
            </span>
          )}
          <button
            type="button"
            className={c.calBtn}
            style={regionStyle(SUN_RECT)}
            data-cal="sun"
            aria-pressed={mode === 'day'}
            aria-label={t('classic:calendar.day')}
            title={t('classic:calendar.day')}
            onClick={() => choose('day')}
            data-testid="classic-cal-sun"
          >
            <Sprite
              sheet="ui.calendar"
              frame={mode === 'day' ? 8 : 9}
              x={12}
              y={11}
              fallback={
                <span className={c.calBtnFallback} style={{ background: '#ffb000' }} aria-hidden="true">
                  ☀
                </span>
              }
            />
          </button>
          <button
            type="button"
            className={c.calBtn}
            style={regionStyle(MOON_RECT)}
            data-cal="moon"
            aria-pressed={mode === 'month'}
            aria-label={t('classic:calendar.month')}
            title={t('classic:calendar.month')}
            onClick={() => choose('month')}
            data-testid="classic-cal-moon"
          >
            <Sprite
              sheet="ui.calendar"
              frame={mode === 'month' ? 10 : 11}
              x={10}
              y={10}
              fallback={
                <span className={c.calBtnFallback} style={{ background: '#e8c64a' }} aria-hidden="true">
                  ☾
                </span>
              }
            />
          </button>
        </>
      )}
      {map && (
        <button
          type="button"
          className={c.calToggle}
          onClick={() => choose(mode === 'map' ? 'month' : 'map')}
          aria-pressed={mode === 'map'}
          data-testid="classic-cal-toggle"
        >
          {mode === 'map' ? t('classic:calendar.showCalendar') : t('classic:calendar.showMap')}
        </button>
      )}
    </section>
  );
}
