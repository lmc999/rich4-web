// 原版目标选择（original-skin.md §4.2「目标选择：在棋盘视窗内用原版光标点选，同时保留可访问的 DOM 候选列表」）：
// - 棋盘视窗：候选高亮到棋盘（BoardBridge，与程序化 TargetPicker 同一套高亮），棋盘点选回填草稿；鼠标光标换成原版光标
//   （Data#0：选人 / 选地为手形、放置道具为白准星、飞弹 / 核弹为红靶、无需目标为箭头）；
// - 右侧（资料栏与日历的位置）一个拉长的宝石消息框：卡片 / 道具名、说明、候选列表（DOM 按钮，可滚动），
//   YES（使用 X，候选不完整时禁用）→ onConfirm(target)、NO（返回）→ onCancel。
// 选择逻辑全部复用程序化 TargetPicker 的纯函数（buildTarget、draftFromPick、highlightOf），前端不重复实现规则；
// 候选以 options 给出的 TargetCandidates 为准。data-testid 与 TargetPicker 相同（target-picker、target-seat-N、
// target-node-N、target-object-N、target-confirm、target-cancel…），E2E 两种皮肤共用。
import type { MapIndex } from '@rich4/shared/data';
import {
  type ActorRef,
  FACILITY_TYPES,
  type FacilityType,
  type LotId,
  type SeatIndex,
  type TargetCandidates,
  type TeleportSource,
  type TileId,
  type UseTarget,
} from '@rich4/shared/engine';
import type { GameView } from '@rich4/shared/view';
import { type ReactNode, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatCents, formatPct10 } from '../../components/format';
import { type GameText, type LooseT, useGameText } from '../../components/names';
import { lotStatus } from '../../decisions/helpers';
import {
  buildTarget,
  draftFromPick,
  sameActor,
  sameSource,
  type TargetDraft,
  type TargetSource,
} from '../../decisions/TargetPicker';
import {
  type BoardPick,
  highlightOf,
  type TargetHighlight,
  useBoardHighlight,
  useBoardPick,
} from '../../decisions/targeting';
import { TEXT } from '../common/textStyles';
import { YesNoBox } from '../common/YesNoBox';
import { SIDE_BOX, sideTextHeight } from './ConstructionPick';
import d from './dialogs.module.css';
import { type CursorKind, useBoardCursor } from './parts';

export interface TargetPanelProps {
  candidates: TargetCandidates;
  view: GameView;
  map: MapIndex;
  me: SeatIndex;
  source: TargetSource;
  onConfirm(target: UseTarget): void;
  onCancel(): void;
  disabled?: boolean;
  /** 额外说明（例如时光机要回到的回合） */
  note?: ReactNode;
}

/** 棋盘视窗里的原版光标：无需目标为箭头、放置道具为准星、飞弹 / 核弹为红靶，其余（选人、选地）为手形 */
export function cursorFor(c: TargetCandidates, src: TargetSource): CursorKind {
  if (c.t === 'none' || c.t === 'auto' || c.t === 'dice' || c.t === 'stock') return 'arrow';
  if (src.kind === 'item' && (src.item === 7 || src.item === 13)) return 'target';
  if (c.t === 'node' || c.t === 'anyNode') return 'cross';
  return 'hand';
}

/** 传送机被传送物所在格（第一步只高亮它们） */
function sourceTile(src: TeleportSource, view: GameView): TileId | null {
  switch (src.k) {
    case 'actor': {
      const a = src.actor;
      if (a.t === 'seat') {
        const pl = view.players.find((p) => p.seat === a.seat);
        return pl?.placed ? pl.node : null;
      }
      const v = view.villains.find((x) => x.kind === a.kind);
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

/** 草稿 → 棋盘高亮（与程序化 TargetPicker 相同：传送机第一步只高亮被传送物） */
export function draftHighlight(c: TargetCandidates, dr: TargetDraft, view: GameView, map: MapIndex): TargetHighlight {
  const hl = highlightOf(c, view, map);
  if (c.t === 'teleport' && dr.tpSource === undefined) {
    hl.lots = c.sources.flatMap((x) => (x.k === 'house' ? [x.lot] : []));
    hl.tiles = c.sources.map((x) => sourceTile(x, view)).filter((x): x is TileId => x !== null);
  }
  hl.selected =
    dr.node !== undefined
      ? { tile: dr.node }
      : dr.lot
        ? { lot: dr.lot }
        : dr.seat !== undefined
          ? { seat: dr.seat }
          : dr.rob
            ? { seat: dr.rob.seat }
            : null;
  return hl;
}

function Row({
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
        className={d.listRow}
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

export function TargetPanel({
  candidates: c,
  view,
  map,
  me,
  source,
  note,
  onConfirm,
  onCancel,
  disabled = false,
}: TargetPanelProps): ReactNode {
  const { t } = useTranslation();
  const lt = t as unknown as LooseT;
  const text = useGameText(view, map);
  const [dr, setD] = useState<TargetDraft>({});
  const target = buildTarget(c, dr);

  useBoardHighlight(disabled ? null : draftHighlight(c, dr, view, map));
  const onPick = useCallback(
    (p: BoardPick) => {
      setD((cur) => draftFromPick(c, cur, p, view) ?? cur);
    },
    [c, view],
  );
  useBoardPick(disabled ? null : onPick);
  useBoardCursor(disabled ? null : cursorFor(c, source));

  const seatRow = (seat: SeatIndex, pressed: boolean, onClick: () => void, testId: string): ReactNode => {
    const pl = view.players.find((p) => p.seat === seat);
    return (
      <Row key={`s${seat}`} pressed={pressed} onClick={onClick} testId={testId}>
        <span>
          {text.player(seat)}
          {seat === me ? ` ${t('dlg.target.self')}` : ''}
        </span>
        {pl?.placed && <span>{text.tile(pl.node)}</span>}
      </Row>
    );
  };
  const lotRow = (lot: LotId, pressed: boolean, onClick: () => void, testId: string): ReactNode => {
    const st = lotStatus(view, lot);
    return (
      <Row key={lot} pressed={pressed} onClick={onClick} testId={testId}>
        <span>{text.lot(lot)}</span>
        <span>
          {st === null || st.owner === null ? t('dlg.common.unowned') : text.player(st.owner)}
          {st ? ` ${t('dlg.common.levelN', { n: st.level })}` : ''}
        </span>
      </Row>
    );
  };
  const typeRows = (types: readonly FacilityType[]): ReactNode => (
    <>
      <p>{t('dlg.target.facilityType')}</p>
      <ul className={d.msgList}>
        {types.map((ft) => (
          <Row
            key={ft}
            pressed={dr.facility === ft}
            onClick={() => setD((cur) => ({ ...cur, facility: ft }))}
            testId={`target-type-${ft}`}
          >
            <span>{text.facility(ft)}</span>
          </Row>
        ))}
      </ul>
    </>
  );
  const empty = <p>{t('dlg.target.noCandidates')}</p>;
  const actorPressed = (a: ActorRef): boolean => dr.actor !== undefined && sameActor(dr.actor, a);

  let body: ReactNode;
  switch (c.t) {
    case 'none':
      body = <p>{t('dlg.target.none')}</p>;
      break;
    case 'auto':
      body = <p>{t('dlg.target.auto')}</p>;
      break;
    case 'seat':
      body =
        c.seats.length === 0 ? (
          empty
        ) : (
          <ul className={d.msgList}>
            {c.seats.map((seat) => seatRow(seat, dr.seat === seat, () => setD({ seat }), `target-seat-${seat}`))}
          </ul>
        );
      break;
    case 'actor':
      body =
        c.actors.length === 0 ? (
          empty
        ) : (
          <ul className={d.msgList}>
            {c.actors.map((a) =>
              a.t === 'seat' ? (
                seatRow(a.seat, actorPressed(a), () => setD({ actor: a }), `target-actor-seat-${a.seat}`)
              ) : (
                <Row
                  key={a.kind}
                  pressed={actorPressed(a)}
                  onClick={() => setD({ actor: a })}
                  testId={`target-actor-${a.kind}`}
                >
                  <span>{text.villain(a.kind)}</span>
                </Row>
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
            <ul className={d.msgList}>
              {c.lots.map((lot) => lotRow(lot, dr.lot === lot, () => setD({ lot }), `target-lot-${lot}`))}
            </ul>
            {dr.lot && c.needType.includes(dr.lot) && typeRows(FACILITY_TYPES)}
          </>
        );
      break;
    case 'underfoot':
      body = (
        <>
          <p>{t('dlg.target.underfoot', { name: text.lot(c.lot) })}</p>
          {c.types !== null && typeRows(c.types)}
        </>
      );
      break;
    case 'lotPair':
      body = (
        <>
          <p>{t('dlg.target.pairFrom', { name: text.lot(c.from) })}</p>
          {c.to.length === 0 ? (
            empty
          ) : (
            <ul className={d.msgList}>
              {c.to.map((lot) => lotRow(lot, dr.lot === lot, () => setD({ lot }), `target-pair-${lot}`))}
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
          <ul className={d.msgList}>
            {c.lots.map((lot) => lotRow(lot, dr.lot === lot, () => setD({ lot }), `target-lot-${lot}`))}
            {c.objects.map((id) => {
              const o = view.objects.find((x) => x.id === id);
              return (
                <Row
                  key={`o${id}`}
                  pressed={dr.object === id}
                  onClick={() => setD({ object: id })}
                  testId={`target-object-${id}`}
                >
                  <span>{o ? lt(`game:object.${o.kind}`) : `#${id}`}</span>
                  {o && <span>{text.tile(o.node)}</span>}
                </Row>
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
          <ul className={d.msgList}>
            {c.stocks.map((idx) => {
              const st = view.stocks.find((x) => x.idx === idx);
              const ch =
                st && st.prevCents > 0 ? Math.trunc(((st.priceCents - st.prevCents) * 1000) / st.prevCents) : 0;
              return (
                <Row
                  key={idx}
                  pressed={dr.stock === idx}
                  onClick={() => setD({ stock: idx })}
                  testId={`target-stock-${idx}`}
                >
                  <span>{text.stock(idx)}</span>
                  {st && (
                    <span>
                      {formatCents(st.priceCents)} {formatPct10(ch)}
                    </span>
                  )}
                </Row>
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
          <ul className={d.msgList}>
            {c.nodes.map((node) => (
              <Row key={node} pressed={dr.node === node} onClick={() => setD({ node })} testId={`target-node-${node}`}>
                <span>{text.tile(node)}</span>
              </Row>
            ))}
          </ul>
        );
      break;
    case 'anyNode':
      body = (
        <label>
          {t('dlg.target.anyNode')}{' '}
          <select
            value={dr.node ?? ''}
            onChange={(e) => setD(e.target.value === '' ? {} : { node: Number(e.target.value) })}
            data-testid="target-any-node"
            style={{ ...TEXT.bodyDark, maxWidth: 150 }}
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
        <ul className={d.msgList} aria-label={t('dlg.target.dice')}>
          {([1, 2, 3, 4, 5, 6] as const).map((v) => (
            <Row
              key={v}
              pressed={dr.dice === v}
              onClick={() => setD({ dice: v })}
              disabled={!c.values.includes(v)}
              testId={`target-dice-${v}`}
            >
              <span>{lt('events:popup.diceValue', { n: v })}</span>
            </Row>
          ))}
        </ul>
      );
      break;
    case 'rob': {
      const victim = dr.rob ? c.victims.find((v) => v.seat === dr.rob?.seat) : undefined;
      body =
        c.victims.length === 0 ? (
          empty
        ) : (
          <>
            <ul className={d.msgList}>
              {c.victims.map((v) =>
                seatRow(v.seat, dr.rob?.seat === v.seat, () => setD({ rob: { seat: v.seat } }), `target-rob-${v.seat}`),
              )}
            </ul>
            {victim && (
              <>
                <p>{t('dlg.target.robWhat')}</p>
                <ul className={d.msgList}>
                  {victim.cards.map((x) => (
                    <Row
                      key={`c${x.slot}`}
                      pressed={dr.rob?.take?.k === 'card' && dr.rob.take.slot === x.slot}
                      onClick={() => setD({ rob: { seat: victim.seat, take: { k: 'card', slot: x.slot } } })}
                      testId={`target-rob-card-${x.slot}`}
                    >
                      <span>{text.card(x.card)}</span>
                    </Row>
                  ))}
                  {victim.items.map((x) => (
                    <Row
                      key={`i${x.item}`}
                      pressed={dr.rob?.take?.k === 'item' && dr.rob.take.item === x.item}
                      onClick={() => setD({ rob: { seat: victim.seat, take: { k: 'item', item: x.item } } })}
                      testId={`target-rob-item-${x.item}`}
                    >
                      <span>{text.item(x.item)}</span>
                      <span>×{x.count}</span>
                    </Row>
                  ))}
                </ul>
                {victim.cards.length + victim.items.length === 0 && empty}
              </>
            )}
          </>
        );
      break;
    }
    case 'teleport':
      body = (
        <>
          <p>{t('dlg.target.tpSource')}</p>
          <ul className={d.msgList}>
            {c.sources.map((src, i) => (
              <Row
                // biome-ignore lint/suspicious/noArrayIndexKey: 候选顺序固定
                key={i}
                pressed={dr.tpSource !== undefined && sameSource(dr.tpSource, src)}
                onClick={() => setD({ tpSource: src })}
                testId={`target-tp-src-${i}`}
              >
                <span>{sourceLabel(src, view, text, lt)}</span>
              </Row>
            ))}
          </ul>
          {dr.tpSource && (
            <>
              <p>{t('dlg.target.tpDest')}</p>
              <ul className={d.msgList}>
                {c.roads.map((node) => (
                  <Row
                    key={`r${node}`}
                    pressed={dr.tpDest?.k === 'road' && dr.tpDest.node === node}
                    onClick={() => setD((cur) => ({ ...cur, tpDest: { k: 'road', node } }))}
                    testId={`target-tp-road-${node}`}
                  >
                    <span>{text.tile(node)}</span>
                  </Row>
                ))}
                {c.lands.map((lot) =>
                  lotRow(
                    lot,
                    dr.tpDest?.k === 'lot' && dr.tpDest.lot === lot,
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
  const desc = source.kind === 'card' ? text.cardDesc(source.card) : text.itemDesc(source.item);
  const lines = SIDE_BOX.maxLines;
  return (
    <YesNoBox
      x={SIDE_BOX.x}
      y={SIDE_BOX.y}
      lines={lines}
      onYes={() => target && onConfirm(target)}
      onNo={onCancel}
      yesDisabled={target === null || disabled}
      noDisabled={disabled}
      yesLabel={t('dlg.target.use', { name })}
      noLabel={t('dlg.common.back')}
      yesTestId="target-confirm"
      noTestId="target-cancel"
      testId="classic-target-box"
    >
      <div
        style={{ display: 'flex', flexDirection: 'column', height: sideTextHeight(lines) }}
        data-testid="target-picker"
        data-target-kind={c.t}
        data-complete={target ? 'true' : 'false'}
      >
        <p style={TEXT.title}>{t('dlg.target.title', { name })}</p>
        <p>{desc}</p>
        {c.t !== 'none' && c.t !== 'auto' && <p>{t('dlg.target.boardHint')}</p>}
        {note && (
          <p style={TEXT.warn} data-testid="target-note">
            {note}
          </p>
        )}
        <div className={d.list} style={{ position: 'relative', flex: 1, minHeight: 0 }} data-interactive="true">
          {body}
        </div>
      </div>
    </YesNoBox>
  );
}
