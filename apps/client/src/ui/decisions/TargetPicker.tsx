// TargetPicker（design/client.md §5.3「目标选择流程」）：按引擎给出的 TargetCandidates 选卡片 / 道具的目标。
// 候选同时高亮到棋盘（BoardBridge），并提供 DOM 候选列表（无障碍、手机、E2E 都走这里）；棋盘点选也会回填。
// 支持全部候选形态：none / auto / seat / actor / lot(+设施类型) / underfoot / lotPair / lotOrObject / stock / node /
// anyNode / dice / rob / teleport。候选之外的目标一律不能确认，引擎仍会再校验一次。
import type { MapIndex } from '@rich4/shared/data';
import {
  type ActorRef,
  type CardId,
  cardDef,
  type DiceFace,
  FACILITY_TYPES,
  type FacilityType,
  type ItemId,
  type LotId,
  type SeatIndex,
  type TargetCandidates,
  type TeleportDest,
  type TeleportSource,
  type TileId,
  type UseTarget,
} from '@rich4/shared/engine';
import type { GameView } from '@rich4/shared/view';
import { type ReactNode, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Avatar, SeatMark } from '../components/Avatar';
import { Button } from '../components/Button';
import { CardTile, ItemTile, TileGrid } from '../components/CardTile';
import { formatCents, formatPct10 } from '../components/format';
import { type GameText, type LooseT, useGameText } from '../components/names';
import s from './decisions.module.css';
import { FACILITY_ICON, lotStatus, playerOf } from './helpers';
import { type BoardPick, highlightOf, type TargetHighlight, useBoardHighlight, useBoardPick } from './targeting';

export type TargetSource = { kind: 'card'; card: CardId; slot: number } | { kind: 'item'; item: ItemId };

/** 选择过程中的草稿（各候选形态只用到其中几项） */
export interface TargetDraft {
  seat?: SeatIndex;
  actor?: ActorRef;
  lot?: LotId;
  facility?: FacilityType;
  object?: number;
  stock?: number;
  node?: TileId;
  dice?: DiceFace;
  rob?: { seat: SeatIndex; take?: { k: 'card'; slot: number } | { k: 'item'; item: ItemId } };
  tpSource?: TeleportSource;
  tpDest?: TeleportDest;
}

export function sameActor(a: ActorRef, b: ActorRef): boolean {
  return a.t === 'seat' ? b.t === 'seat' && a.seat === b.seat : b.t === 'villain' && a.kind === b.kind;
}

export function sameSource(a: TeleportSource, b: TeleportSource): boolean {
  if (a.k !== b.k) return false;
  switch (a.k) {
    case 'actor':
      return sameActor(a.actor, (b as typeof a).actor);
    case 'god':
      return a.slot === (b as typeof a).slot;
    case 'object':
      return a.object === (b as typeof a).object;
    case 'house':
      return a.lot === (b as typeof a).lot;
  }
}

/** 草稿 → 提交用的 UseTarget；不完整或不在候选里时返回 null（纯函数） */
export function buildTarget(c: TargetCandidates, d: TargetDraft): UseTarget | null {
  switch (c.t) {
    case 'none':
    case 'auto':
      return { t: 'none' };
    case 'seat':
      return d.seat !== undefined && c.seats.includes(d.seat) ? { t: 'seat', seat: d.seat } : null;
    case 'actor': {
      const a = d.actor;
      return a && c.actors.some((x) => sameActor(x, a)) ? { t: 'actor', actor: a } : null;
    }
    case 'lot': {
      if (!d.lot || !c.lots.includes(d.lot)) return null;
      if (!c.needType.includes(d.lot)) return { t: 'lot', lot: d.lot, facility: null };
      return d.facility ? { t: 'lot', lot: d.lot, facility: d.facility } : null;
    }
    case 'underfoot':
      if (c.types === null) return { t: 'underfoot', facility: null };
      return d.facility && c.types.includes(d.facility) ? { t: 'underfoot', facility: d.facility } : null;
    case 'lotPair':
      return d.lot && c.to.includes(d.lot) ? { t: 'lotPair', from: c.from, to: d.lot } : null;
    case 'lotOrObject':
      if (d.object !== undefined) return c.objects.includes(d.object) ? { t: 'object', object: d.object } : null;
      return d.lot && c.lots.includes(d.lot) ? { t: 'lot', lot: d.lot, facility: null } : null;
    case 'stock':
      return d.stock !== undefined && c.stocks.includes(d.stock) ? { t: 'stock', stock: d.stock } : null;
    case 'node':
      return d.node !== undefined && c.nodes.includes(d.node) ? { t: 'node', node: d.node } : null;
    case 'anyNode':
      return d.node !== undefined ? { t: 'node', node: d.node } : null;
    case 'dice':
      return d.dice !== undefined && c.values.includes(d.dice) ? { t: 'dice', value: d.dice } : null;
    case 'rob': {
      const r = d.rob;
      const v = r ? c.victims.find((x) => x.seat === r.seat) : undefined;
      const take = r?.take;
      if (!v || !take) return null;
      const ok =
        take.k === 'card'
          ? v.cards.some((x) => x.slot === take.slot)
          : v.items.some((x) => x.item === take.item && x.count > 0);
      return ok ? { t: 'rob', seat: v.seat, take } : null;
    }
    case 'teleport': {
      const src = d.tpSource;
      const dest = d.tpDest;
      if (!src || !dest || !c.sources.some((x) => sameSource(x, src))) return null;
      const destOk = dest.k === 'road' ? c.roads.includes(dest.node) : c.lands.includes(dest.lot);
      return destOk ? { t: 'teleport', source: src, dest } : null;
    }
  }
}

/** 棋盘点选 → 草稿更新（不在候选里的点选忽略，返回 null） */
export function draftFromPick(c: TargetCandidates, d: TargetDraft, p: BoardPick, view: GameView): TargetDraft | null {
  const seatAt = (seats: readonly SeatIndex[]): SeatIndex | undefined =>
    seats.find((seat) => {
      const pl = playerOf(view, seat);
      return pl?.placed && pl.alive && pl.node === p.tile;
    });
  switch (c.t) {
    case 'seat': {
      const seat = seatAt(c.seats);
      return seat === undefined ? null : { ...d, seat };
    }
    case 'actor': {
      for (const a of c.actors) {
        if (a.t === 'seat' && seatAt([a.seat]) !== undefined) return { ...d, actor: a };
        if (a.t === 'villain') {
          const v = view.villains.find((x) => x.kind === a.kind);
          if (v?.onBoard && v.node === p.tile) return { ...d, actor: a };
        }
      }
      return null;
    }
    case 'lot':
      return p.lot && c.lots.includes(p.lot) ? { ...d, lot: p.lot, facility: undefined } : null;
    case 'lotPair':
      return p.lot && c.to.includes(p.lot) ? { ...d, lot: p.lot } : null;
    case 'lotOrObject': {
      const o = view.objects.find((x) => x.node === p.tile && c.objects.includes(x.id));
      if (o) return { ...d, object: o.id, lot: undefined };
      return p.lot && c.lots.includes(p.lot) ? { ...d, lot: p.lot, object: undefined } : null;
    }
    case 'node':
      return c.nodes.includes(p.tile) ? { ...d, node: p.tile } : null;
    case 'anyNode':
      return { ...d, node: p.tile };
    case 'rob': {
      const seat = seatAt(c.victims.map((v) => v.seat));
      return seat === undefined ? null : { ...d, rob: { seat } };
    }
    case 'teleport': {
      if (!d.tpSource) {
        const src = c.sources.find((x) => sourceTile(x, view) === p.tile || (x.k === 'house' && x.lot === p.lot));
        return src ? { ...d, tpSource: src } : null;
      }
      if (p.lot && c.lands.includes(p.lot)) return { ...d, tpDest: { k: 'lot', lot: p.lot } };
      if (c.roads.includes(p.tile)) return { ...d, tpDest: { k: 'road', node: p.tile } };
      return null;
    }
    default:
      return null;
  }
}

function sourceTile(src: TeleportSource, view: GameView): TileId | null {
  switch (src.k) {
    case 'actor': {
      if (src.actor.t === 'seat') {
        const pl = playerOf(view, src.actor.seat);
        return pl?.placed ? pl.node : null;
      }
      const kind = src.actor.kind;
      const v = view.villains.find((x) => x.kind === kind);
      return v?.onBoard ? v.node : null;
    }
    case 'god': {
      const g = view.gods.find((x) => x.slot === src.slot);
      return g && g.where.t === 'road' ? g.where.node : null;
    }
    case 'object':
      return view.objects.find((x) => x.id === src.object)?.node ?? null;
    case 'house':
      return null;
  }
}

function sourceLabel(src: TeleportSource, view: GameView, text: GameText, lt: LooseT): string {
  switch (src.k) {
    case 'actor':
      return text.actor(src.actor);
    case 'god': {
      const g = view.gods.find((x) => x.slot === src.slot);
      return g ? text.god(g.kind) : `#${src.slot}`;
    }
    case 'object': {
      const o = view.objects.find((x) => x.id === src.object);
      return o ? `${lt(`game:object.${o.kind}`)} · ${text.tile(o.node)}` : `#${src.object}`;
    }
    case 'house':
      return lt('dlg.target.house', { name: text.lot(src.lot) });
  }
}

export interface TargetPickerProps {
  candidates: TargetCandidates;
  view: GameView;
  map: MapIndex;
  me: SeatIndex;
  source: TargetSource;
  onConfirm(target: UseTarget): void;
  onCancel(): void;
  disabled?: boolean;
  /** 额外说明（例如时光机要回到的回合），显示在目标区上方 */
  note?: ReactNode;
}

/** 通用候选按钮 */
function Choice({
  pressed,
  onClick,
  children,
  testId,
  disabled,
}: {
  pressed: boolean;
  onClick(): void;
  children: ReactNode;
  testId?: string;
  disabled?: boolean;
}): ReactNode {
  return (
    <li>
      <button
        type="button"
        className={s.choice}
        aria-pressed={pressed}
        onClick={onClick}
        data-testid={testId}
        disabled={disabled}
      >
        {children}
      </button>
    </li>
  );
}

export function TargetPicker({
  candidates: c,
  view,
  map,
  me,
  source,
  note,
  onConfirm,
  onCancel,
  disabled = false,
}: TargetPickerProps): ReactNode {
  const { t } = useTranslation();
  const lt = t as unknown as LooseT;
  const text = useGameText(view, map);
  const [d, setD] = useState<TargetDraft>({});
  const target = buildTarget(c, d);

  // 棋盘高亮：候选 + 当前选中
  const hl: TargetHighlight = highlightOf(c, view, map);
  if (c.t === 'teleport' && d.tpSource === undefined) {
    // 第一步只高亮被传送物所在格
    hl.lots = c.sources.flatMap((x) => (x.k === 'house' ? [x.lot] : []));
    hl.tiles = c.sources.map((x) => sourceTile(x, view)).filter((x): x is TileId => x !== null);
  }
  hl.selected =
    d.node !== undefined
      ? { tile: d.node }
      : d.lot
        ? { lot: d.lot }
        : d.seat !== undefined
          ? { seat: d.seat }
          : d.rob
            ? { seat: d.rob.seat }
            : null;
  useBoardHighlight(disabled ? null : hl);
  const onPick = useCallback(
    (p: BoardPick) => {
      setD((cur) => draftFromPick(c, cur, p, view) ?? cur);
    },
    [c, view],
  );
  useBoardPick(disabled ? null : onPick);

  const seatButton = (seat: SeatIndex, pressed: boolean, onClick: () => void, testId: string): ReactNode => {
    const pl = playerOf(view, seat);
    return (
      <Choice key={`s${seat}`} pressed={pressed} onClick={onClick} testId={testId}>
        {pl && <Avatar character={pl.character} seat={seat} size={32} />}
        <span className={s.choiceMain}>
          <strong>
            {text.player(seat)}
            {seat === me ? ` ${t('dlg.target.self')}` : ''}
          </strong>
          {pl?.placed && <small>{text.tile(pl.node)}</small>}
        </span>
      </Choice>
    );
  };

  const lotButton = (lot: LotId, pressed: boolean, onClick: () => void, testId: string): ReactNode => {
    const st = lotStatus(view, lot);
    return (
      <Choice key={lot} pressed={pressed} onClick={onClick} testId={testId}>
        <SeatMark seat={st?.owner ?? null} />
        <span className={s.choiceMain}>
          <strong>{text.lot(lot)}</strong>
          <small>
            {st?.owner === null || st === null ? t('dlg.common.unowned') : text.player(st.owner)}
            {st ? ` · ${t('dlg.common.levelN', { n: st.level })}` : ''}
          </small>
        </span>
      </Choice>
    );
  };

  const typeChooser = (types: readonly FacilityType[]): ReactNode => (
    <div>
      <h4 className={s.muted} style={{ margin: '8px 0 4px' }}>
        {t('dlg.target.facilityType')}
      </h4>
      <ul className={s.choices}>
        {types.map((ft) => (
          <Choice
            key={ft}
            pressed={d.facility === ft}
            onClick={() => setD((cur) => ({ ...cur, facility: ft }))}
            testId={`target-type-${ft}`}
          >
            <span aria-hidden="true">{FACILITY_ICON[ft]}</span>
            <span className={s.choiceMain}>{text.facility(ft)}</span>
          </Choice>
        ))}
      </ul>
    </div>
  );

  const empty = <p className={s.muted}>{t('dlg.target.noCandidates')}</p>;

  let body: ReactNode;
  switch (c.t) {
    case 'none':
      body = (
        <>
          {note && (
            <p className={s.warn} data-testid="target-note">
              {note}
            </p>
          )}
          <p className={s.note}>{t('dlg.target.none')}</p>
        </>
      );
      break;
    case 'auto':
      body = <p className={s.note}>{t('dlg.target.auto')}</p>;
      break;
    case 'seat':
      body =
        c.seats.length === 0 ? (
          empty
        ) : (
          <ul className={s.choices}>
            {c.seats.map((seat) => seatButton(seat, d.seat === seat, () => setD({ seat }), `target-seat-${seat}`))}
          </ul>
        );
      break;
    case 'actor':
      body =
        c.actors.length === 0 ? (
          empty
        ) : (
          <ul className={s.choices}>
            {c.actors.map((a) =>
              a.t === 'seat' ? (
                seatButton(
                  a.seat,
                  d.actor !== undefined && sameActor(d.actor, a),
                  () => setD({ actor: a }),
                  `target-actor-seat-${a.seat}`,
                )
              ) : (
                <Choice
                  key={a.kind}
                  pressed={d.actor !== undefined && sameActor(d.actor, a)}
                  onClick={() => setD({ actor: a })}
                  testId={`target-actor-${a.kind}`}
                >
                  <span className={s.choiceMain}>
                    <strong>{text.villain(a.kind)}</strong>
                  </span>
                </Choice>
              ),
            )}
          </ul>
        );
      break;
    case 'lot':
      body =
        c.lots.length === 0 ? (
          empty
        ) : (
          <>
            <ul className={s.choices}>
              {c.lots.map((lot) => lotButton(lot, d.lot === lot, () => setD({ lot }), `target-lot-${lot}`))}
            </ul>
            {d.lot && c.needType.includes(d.lot) && typeChooser(FACILITY_TYPES)}
          </>
        );
      break;
    case 'underfoot':
      body = (
        <>
          <p className={s.note}>{t('dlg.target.underfoot', { name: text.lot(c.lot) })}</p>
          {c.types !== null && typeChooser(c.types)}
        </>
      );
      break;
    case 'lotPair':
      body = (
        <>
          <p className={s.note}>{t('dlg.target.pairFrom', { name: text.lot(c.from) })}</p>
          {c.to.length === 0 ? (
            empty
          ) : (
            <ul className={s.choices}>
              {c.to.map((lot) => lotButton(lot, d.lot === lot, () => setD({ lot }), `target-pair-${lot}`))}
            </ul>
          )}
        </>
      );
      break;
    case 'lotOrObject':
      body =
        c.lots.length + c.objects.length === 0 ? (
          empty
        ) : (
          <ul className={s.choices}>
            {c.lots.map((lot) => lotButton(lot, d.lot === lot, () => setD({ lot }), `target-lot-${lot}`))}
            {c.objects.map((id) => {
              const o = view.objects.find((x) => x.id === id);
              return (
                <Choice
                  key={`o${id}`}
                  pressed={d.object === id}
                  onClick={() => setD({ object: id })}
                  testId={`target-object-${id}`}
                >
                  <span className={s.choiceMain}>
                    <strong>{o ? lt(`game:object.${o.kind}`) : `#${id}`}</strong>
                    {o && <small>{text.tile(o.node)}</small>}
                  </span>
                </Choice>
              );
            })}
          </ul>
        );
      break;
    case 'stock':
      body =
        c.stocks.length === 0 ? (
          empty
        ) : (
          <ul className={s.choices}>
            {c.stocks.map((idx) => {
              const st = view.stocks.find((x) => x.idx === idx);
              const ch =
                st && st.prevCents > 0 ? Math.trunc(((st.priceCents - st.prevCents) * 1000) / st.prevCents) : 0;
              return (
                <Choice
                  key={idx}
                  pressed={d.stock === idx}
                  onClick={() => setD({ stock: idx })}
                  testId={`target-stock-${idx}`}
                >
                  <span className={s.choiceMain}>
                    <strong>{text.stock(idx)}</strong>
                    {st && (
                      <small>
                        {formatCents(st.priceCents)} · {formatPct10(ch)}
                      </small>
                    )}
                  </span>
                </Choice>
              );
            })}
          </ul>
        );
      break;
    case 'node':
      body =
        c.nodes.length === 0 ? (
          empty
        ) : (
          <ul className={s.choices}>
            {c.nodes.map((node) => (
              <Choice
                key={node}
                pressed={d.node === node}
                onClick={() => setD({ node })}
                testId={`target-node-${node}`}
              >
                <span className={s.choiceMain}>{text.tile(node)}</span>
              </Choice>
            ))}
          </ul>
        );
      break;
    case 'anyNode':
      body = (
        <label className={s.row}>
          {t('dlg.target.anyNode')}
          <select
            className="select"
            value={d.node ?? ''}
            onChange={(e) => setD(e.target.value === '' ? {} : { node: Number(e.target.value) })}
            data-testid="target-any-node"
          >
            <option value="">—</option>
            {map.def.tiles.map((tile) => (
              <option key={tile.id} value={tile.id}>
                {text.tile(tile.id)}
              </option>
            ))}
          </select>
        </label>
      );
      break;
    case 'dice':
      body = (
        <fieldset className={s.diceToggle}>
          <legend className="visually-hidden">{t('dlg.target.dice')}</legend>
          {([1, 2, 3, 4, 5, 6] as const).map((v) => (
            <button
              key={v}
              type="button"
              className={s.diceItem}
              data-state={d.dice === v ? 'on' : 'off'}
              aria-pressed={d.dice === v}
              disabled={!c.values.includes(v)}
              onClick={() => setD({ dice: v })}
              data-testid={`target-dice-${v}`}
            >
              {v}
            </button>
          ))}
        </fieldset>
      );
      break;
    case 'rob': {
      const victim = d.rob ? c.victims.find((v) => v.seat === d.rob?.seat) : undefined;
      body =
        c.victims.length === 0 ? (
          empty
        ) : (
          <>
            <ul className={s.choices}>
              {c.victims.map((v) =>
                seatButton(
                  v.seat,
                  d.rob?.seat === v.seat,
                  () => setD({ rob: { seat: v.seat } }),
                  `target-rob-${v.seat}`,
                ),
              )}
            </ul>
            {victim && (
              <div>
                <h4 className={s.muted} style={{ margin: '8px 0 4px' }}>
                  {t('dlg.target.robWhat')}
                </h4>
                <TileGrid label={t('dlg.target.robWhat')}>
                  {victim.cards.map((x) => (
                    <CardTile
                      key={`c${x.slot}`}
                      card={x.card}
                      name={text.card(x.card)}
                      price={cardDef(x.card).price}
                      width={80}
                      selected={d.rob?.take?.k === 'card' && d.rob.take.slot === x.slot}
                      onClick={() => setD({ rob: { seat: victim.seat, take: { k: 'card', slot: x.slot } } })}
                      testId={`target-rob-card-${x.slot}`}
                    />
                  ))}
                  {victim.items.map((x) => (
                    <ItemTile
                      key={`i${x.item}`}
                      item={x.item}
                      name={text.item(x.item)}
                      count={x.count}
                      width={80}
                      selected={d.rob?.take?.k === 'item' && d.rob.take.item === x.item}
                      onClick={() => setD({ rob: { seat: victim.seat, take: { k: 'item', item: x.item } } })}
                      testId={`target-rob-item-${x.item}`}
                    />
                  ))}
                </TileGrid>
                {victim.cards.length + victim.items.length === 0 && empty}
              </div>
            )}
          </>
        );
      break;
    }
    case 'teleport':
      body = (
        <>
          <h4 className={s.muted} style={{ margin: '0 0 4px' }}>
            {t('dlg.target.tpSource')}
          </h4>
          <ul className={s.choices}>
            {c.sources.map((src, i) => (
              <Choice
                // biome-ignore lint/suspicious/noArrayIndexKey: 候选顺序固定
                key={i}
                pressed={d.tpSource !== undefined && sameSource(d.tpSource, src)}
                onClick={() => setD({ tpSource: src })}
                testId={`target-tp-src-${i}`}
              >
                <span className={s.choiceMain}>{sourceLabel(src, view, text, lt)}</span>
              </Choice>
            ))}
          </ul>
          {d.tpSource && (
            <>
              <h4 className={s.muted} style={{ margin: '8px 0 4px' }}>
                {t('dlg.target.tpDest')}
              </h4>
              <ul className={s.choices}>
                {c.roads.map((node) => (
                  <Choice
                    key={`r${node}`}
                    pressed={d.tpDest?.k === 'road' && d.tpDest.node === node}
                    onClick={() => setD((cur) => ({ ...cur, tpDest: { k: 'road', node } }))}
                    testId={`target-tp-road-${node}`}
                  >
                    <span className={s.choiceMain}>{text.tile(node)}</span>
                  </Choice>
                ))}
                {c.lands.map((lot) =>
                  lotButton(
                    lot,
                    d.tpDest?.k === 'lot' && d.tpDest.lot === lot,
                    () => setD((cur) => ({ ...cur, tpDest: { k: 'lot', lot } })),
                    `target-tp-lot-${lot}`,
                  ),
                )}
              </ul>
            </>
          )}
        </>
      );
      break;
  }

  const name = source.kind === 'card' ? text.card(source.card) : text.item(source.item);
  return (
    <fieldset className={s.fieldset} disabled={disabled} data-testid="target-picker" data-target-kind={c.t}>
      <div className={s.stack}>
        <div className={s.row} style={{ alignItems: 'flex-start' }}>
          {source.kind === 'card' ? (
            <CardTile card={source.card} name={name} price={cardDef(source.card).price} width={84} />
          ) : (
            <ItemTile item={source.item} name={name} width={84} />
          )}
          <div className={s.stack} style={{ flex: 1, gap: 4 }}>
            <strong>{t('dlg.target.title', { name })}</strong>
            <span className={s.muted}>
              {source.kind === 'card' ? text.cardDesc(source.card) : text.itemDesc(source.item)}
            </span>
            {c.t !== 'none' && c.t !== 'auto' && <span className={s.muted}>{t('dlg.target.boardHint')}</span>}
          </div>
        </div>
        {body}
        <div className={s.between}>
          <Button variant="cream" onClick={onCancel} data-testid="target-cancel">
            {t('dlg.common.back')}
          </Button>
          <Button
            variant="green"
            disabled={target === null}
            onClick={() => target && onConfirm(target)}
            data-testid="target-confirm"
          >
            {t('dlg.target.use', { name })}
          </Button>
        </div>
      </div>
    </fieldset>
  );
}
