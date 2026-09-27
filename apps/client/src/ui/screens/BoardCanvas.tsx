// 棋盘挂载点（design/client.md §1.1）：GameRenderer 只创建一次（共用客户端的动画时钟），加载 MapDef、
// 建 BoardController 并注入 GameClient（EventPlayer 的演出端口），之后永不因 React 重渲染而重建。
// 同时提供对话框代理的 BoardBridge（目标高亮与点选）和测试钩子 board.tileScreenPos。
import type { MapDef, MapIndex } from '@rich4/shared/data';
import { CHARACTER_KEYS, type LotId, type TileId } from '@rich4/shared/engine';
import i18next from 'i18next';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useClient } from '../../app/services';
import { exposeBoard } from '../../dev/testHooks';
import { BoardController } from '../../game/BoardController';
import type { Insets } from '../../game/camera/Camera';
import { GameRenderer } from '../../game/GameRenderer';
import { tx } from '../../i18n/tx';
import { mySeat, useRoomStore } from '../../store/roomStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useUiStore } from '../../store/uiStore';
import type { BoardBridge, BoardPick, TargetHighlight } from '../decisions/targeting';
import h from '../hud/hud.module.css';
import { onHeadBubble } from '../social/socialStore';

/** 开局后的镜头缩放（1 = 等角格原始大小） */
export const START_ZOOM = 0.85;

function boardLabel(key: string): string | undefined {
  if (!i18next.isInitialized || !i18next.exists(key)) return undefined;
  return tx(key);
}

/** 目标高亮 → 棋盘格：候选格 + 候选地块的前沿格 */
export function highlightTiles(hl: TargetHighlight, map: MapIndex): { tiles: TileId[]; selected: TileId | null } {
  const tiles = new Set<TileId>(hl.tiles);
  const front = (lot: LotId): TileId[] => {
    try {
      return map.lot(lot).frontTiles;
    } catch {
      return [];
    }
  };
  for (const l of hl.lots) for (const t of front(l)) tiles.add(t);
  let selected: TileId | null = hl.selected?.tile ?? null;
  if (selected === null && hl.selected?.lot) selected = front(hl.selected.lot)[0] ?? null;
  return { tiles: [...tiles], selected };
}

export interface BoardCanvasProps {
  def: MapDef;
  map: MapIndex;
  insets: Insets;
  onReady(ctrl: BoardController | null, bridge: BoardBridge | null): void;
}

export function BoardCanvas({ def, map, insets, onReady }: BoardCanvasProps): ReactNode {
  const client = useClient();
  const hostRef = useRef<HTMLDivElement>(null);
  const ctrlRef = useRef<BoardController | null>(null);
  const [lost, setLost] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const insetsRef = useRef(insets);
  insetsRef.current = insets;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let renderer: GameRenderer | null = null;
    const picks = new Set<(p: BoardPick) => void>();
    const offs: (() => void)[] = [];
    const quality = useSettingsStore.getState().quality;
    GameRenderer.create({
      host,
      clock: client.anim,
      quality: quality === 'auto' ? 'high' : quality,
      labels: { label: boardLabel },
      onTap: (pick) => {
        if (!pick) return;
        if (pick.tile !== null) for (const cb of [...picks]) cb({ tile: pick.tile, lot: pick.lot });
      },
      onDoubleTap: () => {
        const seat = ctrlRef.current?.followed ?? null;
        if (seat !== null) ctrlRef.current?.follow(seat);
      },
      onContextLost: setLost,
    })
      .then(async (r) => {
        if (cancelled) {
          r.destroy();
          return;
        }
        renderer = r;
        r.camera.setInsets(insetsRef.current);
        await r.loadMap(def);
        if (cancelled) return;
        const ctrl = new BoardController(r, {
          nameOf: (seat, view) => {
            const p = view.players.find((x) => x.seat === seat);
            return p ? tx(`characters:${CHARACTER_KEYS[p.character]}.name`) : `${seat + 1}P`;
          },
          autoFollow: () => useSettingsStore.getState().autoFollow && useUiStore.getState().followSeat === null,
          pinned: () => useUiStore.getState().followSeat,
        });
        ctrlRef.current = ctrl;
        const bridge: BoardBridge = {
          highlight: (hl) => {
            if (!hl) ctrl.highlight([], null);
            else {
              const x = highlightTiles(hl, map);
              ctrl.highlight(x.tiles, x.selected);
            }
          },
          onPick: (cb) => {
            picks.add(cb);
            return () => {
              picks.delete(cb);
            };
          },
        };
        client.attachBoard(ctrl);
        exposeBoard((id) => ctrl.tileCanvasPos(id), r);
        // 头顶气泡（聊天、表情；已过滤屏蔽）→ 角色头顶；观战栏的「跟随」→ 镜头锁定
        offs.push(
          onHeadBubble((b) =>
            b.kind === 'emote'
              ? ctrl.say(b.seat, b.glyph ?? '', b.durationMs, true)
              : ctrl.say(b.seat, b.text ?? '', b.durationMs),
          ),
          useUiStore.subscribe((st, prev) => {
            if (st.followSeat !== prev.followSeat) ctrl.refollow();
          }),
        );
        onReadyRef.current(ctrl, bridge);
        // 开局俯瞰后飞向当前玩家
        // 开局先俯瞰全图（loadMap 已 fitAll），再拉近到正常比例跟随当前玩家
        if (r.camera.zoom < START_ZOOM) void r.camera.zoomTo(START_ZOOM, 600);
        const cur = client.player.displayView?.clock.cursor;
        ctrl.follow(cur?.t === 'seat' ? cur.seat : mySeat(useRoomStore.getState().room));
      })
      .catch((e: unknown) => {
        console.error('[board]', e);
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
      for (const off of offs.splice(0)) off();
      client.attachBoard(null);
      exposeBoard(null, null);
      onReadyRef.current(null, null);
      ctrlRef.current?.clearFx();
      ctrlRef.current = null;
      renderer?.destroy();
    };
    // 棋盘只随地图重建
  }, [client, def, map]);

  useEffect(() => {
    ctrlRef.current?.renderer.camera.setInsets(insets);
  }, [insets]);

  return (
    <div className={h.board} ref={hostRef} data-testid="board-host">
      {lost && <div className={h.boardNote}>{tx('hud:board.contextLost')}</div>}
      {error && (
        <div className={h.boardNote} role="alert">
          {tx('hud:board.error', { reason: error })}
        </div>
      )}
    </div>
  );
}
