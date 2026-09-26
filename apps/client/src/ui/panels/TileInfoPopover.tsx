// TileInfoPopover：点棋盘格弹出的小气泡（radix Popover，锚在屏幕坐标上）。
// 显示格子名与种类；地产格加上归属、等级、地价 / 标价、对观察者的过路费、标记；以及格上的玩家、路面物件、神明、乞丐。
import type { MapIndex } from '@rich4/shared/data';
import { buyPrice, calcToll, type SeatIndex, type TileId } from '@rich4/shared/engine';
import type { GameView } from '@rich4/shared/view';
import { Popover } from 'radix-ui';
import { type ReactNode, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { PlayerChip, SeatMark } from '../components/Avatar';
import { Money } from '../components/Money';
import { type LooseT, useGameText } from '../components/names';
import { KeyValues } from '../components/Panel';
import s from './panels.module.css';

export interface TileInfoPopoverProps {
  view: GameView;
  map: MapIndex;
  /** null 时关闭 */
  tile: TileId | null;
  /** 锚点（视口坐标，px） */
  at: { x: number; y: number } | null;
  viewer: SeatIndex | null;
  onClose(): void;
}

export function TileInfoContent({
  view,
  map,
  tile,
  viewer,
}: Pick<TileInfoPopoverProps, 'view' | 'map' | 'viewer'> & { tile: TileId }): ReactNode {
  const { t } = useTranslation();
  const lt = t as unknown as LooseT;
  const text = useGameText(view, map);
  let def: ReturnType<MapIndex['tile']> | null = null;
  try {
    def = map.tile(tile);
  } catch {
    def = null;
  }
  if (!def) return <p className={s.muted}>#{tile}</p>;
  const lot = def.ref?.lot ?? null;
  const land = lot ? view.lands.find((l) => l.id === lot) : undefined;
  const fac = lot ? view.facilities.find((f) => f.id === lot) : undefined;
  const owned = land ?? fac;
  const rows: [ReactNode, ReactNode][] = [];
  if (lot && owned) {
    rows.push([
      t('pnl.property.owner'),
      owned.owner === null ? (
        t('pnl.property.unowned')
      ) : (
        <span key="o">
          <SeatMark seat={owned.owner} /> {text.player(owned.owner)}
        </span>
      ),
    ]);
    rows.push([t('pnl.property.level'), String(owned.level)]);
    if (fac && fac.level > 0) rows.push([t('pnl.tile.facility'), text.facility(fac.type)]);
    rows.push([t('pnl.property.landPrice'), <Money key="lp" value={owned.landPrice} />]);
    if (owned.owner === null) {
      const price = buyPrice(view, map, lot);
      if (price !== null) rows.push([t('pnl.tile.price'), <Money key="bp" value={price} testId="tile-buy-price" />]);
    } else if (viewer !== null && owned.owner !== viewer && land) {
      rows.push([
        t('pnl.property.toll'),
        <Money key="tl" value={calcToll(view, map, lot, viewer)} testId="tile-toll" />,
      ]);
    }
    if (owned.mark)
      rows.push([t('pnl.property.mark'), lt(`pnl.property.mark${owned.mark.kind === 'raise' ? 'Raise' : 'Seal'}`)]);
  }
  const players = view.players.filter((p) => p.alive && p.placed && p.node === tile);
  const objects = view.objects.filter((o) => o.node === tile);
  const gods = view.gods.filter((g) => g.where.t === 'road' && g.where.node === tile);
  const beggars = view.beggars.filter((b) => b.node === tile);

  return (
    <div className={s.panel} data-testid="tile-info">
      <header className={s.head}>
        <h3>{lot ? text.lot(lot) : text.tile(tile)}</h3>
      </header>
      <p className={s.muted}>
        {text.tileKind(def.kind)} · #{tile}
      </p>
      {rows.length > 0 && <KeyValues rows={rows} />}
      {players.length > 0 && (
        <div className={s.badges}>
          {players.map((p) => (
            <PlayerChip key={p.seat} view={view} seat={p.seat} name={text.player(p.seat)} size={22} />
          ))}
        </div>
      )}
      {(objects.length > 0 || gods.length > 0 || beggars.length > 0) && (
        <p className={s.muted} data-testid="tile-things">
          {[
            ...objects.map((o) => lt(`game:object.${o.kind}`)),
            ...gods.map((g) => text.god(g.kind)),
            ...beggars.map((b) => t('pnl.tile.beggar', { name: text.player(b.seat) })),
          ].join('、')}
        </p>
      )}
    </div>
  );
}

export function TileInfoPopover({ view, map, tile, at, viewer, onClose }: TileInfoPopoverProps): ReactNode {
  const { t } = useTranslation();
  const open = tile !== null && at !== null;
  const anchor = useMemo(
    () => ({
      current: {
        getBoundingClientRect: (): DOMRect => {
          const x = at?.x ?? 0;
          const y = at?.y ?? 0;
          return { x, y, left: x, top: y, right: x, bottom: y, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
        },
      },
    }),
    [at?.x, at?.y],
  );
  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <Popover.Anchor virtualRef={anchor} />
      <Popover.Portal>
        <Popover.Content
          className={s.popover}
          side="top"
          sideOffset={10}
          collisionPadding={12}
          aria-label={t('pnl.tile.title')}
        >
          {tile !== null && <TileInfoContent view={view} map={map} tile={tile} viewer={viewer} />}
          <Popover.Arrow className={s.popoverArrow} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
