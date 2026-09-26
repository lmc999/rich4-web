// 棋盘桥（design/client.md §1.2、§5.3）：DOM 里的目标选择把候选同步给棋盘高亮，棋盘上的点选再回传给 DOM。
// 主循环用 BoardBridgeContext.Provider 接到 BoardView/TileMarkers；不提供时只有 DOM 候选列表（功能完整）。
import type { MapIndex } from '@rich4/shared/data';
import type { LotId, SeatIndex, TargetCandidates, TileId } from '@rich4/shared/engine';
import type { GameView } from '@rich4/shared/view';
import { createContext, useContext, useEffect } from 'react';

/** 需要在棋盘上高亮的候选 */
export interface TargetHighlight {
  tiles: TileId[];
  lots: LotId[];
  seats: SeatIndex[];
  /** 路面物件 id（RoadObject.id） */
  objects: number[];
  /** 当前选中的格或地块（脉动描边） */
  selected: { tile?: TileId; lot?: LotId; seat?: SeatIndex } | null;
}

/** 棋盘上的一次点选 */
export type BoardPick = { tile: TileId; lot: LotId | null };

export interface BoardBridge {
  /** null 表示清除 */
  highlight(h: TargetHighlight | null): void;
  /** 订阅棋盘点选；返回取消订阅 */
  onPick?(cb: (p: BoardPick) => void): () => void;
}

export const BoardBridgeContext = createContext<BoardBridge | null>(null);

export function useBoardBridge(): BoardBridge | null {
  return useContext(BoardBridgeContext);
}

export const EMPTY_HIGHLIGHT: TargetHighlight = Object.freeze({
  tiles: [],
  lots: [],
  seats: [],
  objects: [],
  selected: null,
}) as TargetHighlight;

/** 挂载期间把 h 同步到棋盘，卸载时清除 */
export function useBoardHighlight(h: TargetHighlight | null): void {
  const bridge = useBoardBridge();
  const key = h ? JSON.stringify(h) : '';
  // biome-ignore lint/correctness/useExhaustiveDependencies: key 概括了 h
  useEffect(() => {
    if (!bridge) return;
    bridge.highlight(h);
    return () => bridge.highlight(null);
  }, [bridge, key]);
}

/** 订阅棋盘点选 */
export function useBoardPick(cb: ((p: BoardPick) => void) | null): void {
  const bridge = useBoardBridge();
  useEffect(() => {
    if (!bridge?.onPick || !cb) return;
    return bridge.onPick(cb);
  }, [bridge, cb]);
}

/** 座位 → 棋子所在格（未落地或出局时为 null） */
export function seatTile(view: GameView, seat: SeatIndex): TileId | null {
  const p = view.players.find((x) => x.seat === seat);
  return p?.placed && p.alive ? p.node : null;
}

/** 地块的前沿格（棋盘高亮用） */
export function lotTiles(map: MapIndex, lot: LotId): TileId[] {
  try {
    return map.lot(lot).frontTiles.slice();
  } catch {
    return [];
  }
}

/** 候选 → 高亮集合（纯函数） */
export function highlightOf(c: TargetCandidates, view: GameView, map: MapIndex): TargetHighlight {
  const h: TargetHighlight = { tiles: [], lots: [], seats: [], objects: [], selected: null };
  const addSeat = (seat: SeatIndex): void => {
    h.seats.push(seat);
    const t = seatTile(view, seat);
    if (t !== null) h.tiles.push(t);
  };
  switch (c.t) {
    case 'seat':
      c.seats.forEach(addSeat);
      break;
    case 'actor':
      for (const a of c.actors) {
        if (a.t === 'seat') addSeat(a.seat);
        else {
          const v = view.villains.find((x) => x.kind === a.kind);
          if (v?.onBoard) h.tiles.push(v.node);
        }
      }
      break;
    case 'lot':
      h.lots.push(...c.lots);
      break;
    case 'underfoot':
      h.lots.push(c.lot);
      break;
    case 'lotPair':
      h.lots.push(c.from, ...c.to);
      break;
    case 'lotOrObject':
      h.lots.push(...c.lots);
      for (const id of c.objects) {
        h.objects.push(id);
        const o = view.objects.find((x) => x.id === id);
        if (o) h.tiles.push(o.node);
      }
      break;
    case 'node':
      h.tiles.push(...c.nodes);
      break;
    case 'anyNode':
      h.tiles.push(...map.def.tiles.map((t) => t.id));
      break;
    case 'rob':
      for (const v of c.victims) addSeat(v.seat);
      break;
    case 'teleport':
      h.tiles.push(...c.roads);
      h.lots.push(...c.lands);
      break;
    default:
      break;
  }
  return h;
}
