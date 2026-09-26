// 小地图（design/client.md §3.9）：Canvas2D 画地块主人色、玩家彩点、视口框；250ms 节流重绘；点击平移镜头。
// 另附一份对读屏友好的地产归属列表（visually-hidden，E2E 也用它比对四个页面的归属）。
import type { MapIndex } from '@rich4/shared/data';
import type { GameView } from '@rich4/shared/view';
import { type MouseEvent, type ReactNode, useEffect, useMemo, useRef } from 'react';
import type { Pt, Rotation } from '../../game/iso/projection';
import { MiniMapPainter, miniToWorld } from '../../game/minimap/MiniMapPainter';
import { useTx } from '../../i18n/tx';
import h from './hud.module.css';

export const MINI_W = 240;
export const MINI_H = 160;
export const MINI_REPAINT_MS = 250;

export interface MiniMapProps {
  view: GameView;
  map: MapIndex;
  rotation: Rotation;
  /** 镜头视口四角（world 坐标）；没有棋盘时为 null */
  viewport?: () => Pt[] | null;
  onPan?(world: Pt): void;
}

/** 地块 → 主人座位（住宅、设施看 owner，企业看对应股票的董事长） */
export function lotOwners(view: GameView): Record<string, number | null> {
  const owners: Record<string, number | null> = {};
  for (const l of view.lands) owners[l.id] = l.owner;
  for (const f of view.facilities) owners[f.id] = f.owner;
  for (const c of view.companies) owners[c.id] = view.stocks[c.stock]?.chairman ?? null;
  return owners;
}

export function MiniMap({ view, map, rotation, viewport, onPan }: MiniMapProps): ReactNode {
  const t = useTx();
  const ref = useRef<HTMLCanvasElement>(null);
  const painter = useRef<MiniMapPainter | null>(null);
  const latest = useRef(view);
  latest.current = view;

  useEffect(() => {
    const ctx = ref.current?.getContext('2d') ?? null;
    painter.current = ctx ? new MiniMapPainter(ctx, map.def, rotation, { w: MINI_W, h: MINI_H }) : null;
  }, [map, rotation]);

  useEffect(() => {
    const paint = (): void => {
      const p = painter.current;
      if (!p) return;
      const v = latest.current;
      p.paint({
        owners: lotOwners(v),
        players: v.players.filter((x) => x.placed && x.node > 0).map((x) => ({ seat: x.seat, tile: x.node })),
        ...(viewport?.() ? { viewport: viewport()! } : {}),
      });
    };
    paint();
    const id = setInterval(paint, MINI_REPAINT_MS);
    return () => clearInterval(id);
  }, [viewport]);

  const onClick = (e: MouseEvent<HTMLCanvasElement>): void => {
    const p = painter.current;
    if (!p || !onPan) return;
    const r = e.currentTarget.getBoundingClientRect();
    const sx = (e.clientX - r.left) * (MINI_W / Math.max(1, r.width));
    const sy = (e.clientY - r.top) * (MINI_H / Math.max(1, r.height));
    onPan(miniToWorld(p.layout, { x: sx, y: sy }));
  };

  const owned = useMemo(() => {
    const all = [
      ...view.lands.map((l) => ({ id: l.id, owner: l.owner, level: l.level })),
      ...view.facilities.map((f) => ({ id: f.id, owner: f.owner, level: f.level })),
    ];
    return all;
  }, [view.lands, view.facilities]);

  return (
    <section className={h.miniMap} aria-label={t('hud:mini.title')}>
      <canvas ref={ref} width={MINI_W} height={MINI_H} onClick={onClick} data-testid="minimap" />
      <ul className="visually-hidden" data-testid="hud-lots">
        {owned.map((l) => (
          <li key={l.id} data-lot={l.id} data-owner={l.owner ?? ''} data-level={l.level}>
            {l.id}: {l.owner === null ? t('hud:mini.unowned') : t('hud:mini.owner', { n: l.owner + 1 })} Lv{l.level}
          </li>
        ))}
      </ul>
    </section>
  );
}
