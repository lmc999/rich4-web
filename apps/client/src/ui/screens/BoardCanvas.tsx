// 棋盘挂载点（design/client.md §1.1）：按皮肤判定经 skin/boards 创建棋盘表面（BoardSurface）与控制器（共用客户端的
// 动画时钟），加载 MapDef 后把控制器注入 GameClient（EventPlayer 的演出端口），之后只随地图或棋盘皮肤变化重建。
// 同时提供对话框代理的 BoardBridge（目标高亮与点选）和测试钩子（board.tileScreenPos、renderer = BoardSurface）。
// 原版皮肤 A5（original-skin.md §3 修正 7）：这里只经由 BoardSurface / BoardControllerLike 访问棋盘；
// 原版棋盘（A6）未注册或创建失败时回退程序化，并把原因报给 skinStore。
import type { MapDef, MapIndex } from '@rich4/shared/data';
import { CHARACTER_KEYS, type LotId, type TileId } from '@rich4/shared/engine';
import i18next from 'i18next';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useClient } from '../../app/services';
import { exposeBoard } from '../../dev/testHooks';
import type { Insets } from '../../game/camera/Camera';
import { tx } from '../../i18n/tx';
import type { BoardControllerLike, BoardSurface } from '../../skin/BoardSurface';
import { createBoard } from '../../skin/boards';
import { useSkinStore } from '../../skin/skinStore';
import type { SkinKind } from '../../skin/types';
import { mySeat, useRoomStore } from '../../store/roomStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useUiStore } from '../../store/uiStore';
import type { BoardBridge, BoardPick, TargetHighlight } from '../decisions/targeting';
import h from '../hud/hud.module.css';
import { onHeadBubble } from '../social/socialStore';

/** 开局后的镜头缩放（1 = 等角格原始大小；原版棋盘按自己的缩放范围夹紧） */
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
  /** 想用的棋盘（皮肤判定的 board）；缺省程序化 */
  skin?: SkinKind;
  onReady(ctrl: BoardControllerLike | null, bridge: BoardBridge | null, surface: BoardSurface | null): void;
}

export function BoardCanvas({ def, map, insets, skin = 'procedural', onReady }: BoardCanvasProps): ReactNode {
  const client = useClient();
  const hostRef = useRef<HTMLDivElement>(null);
  const ctrlRef = useRef<BoardControllerLike | null>(null);
  const surfaceRef = useRef<BoardSurface | null>(null);
  const [lost, setLost] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const insetsRef = useRef(insets);
  insetsRef.current = insets;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ac = new AbortController();
    let surface: BoardSurface | null = null;
    const picks = new Set<(p: BoardPick) => void>();
    const offs: (() => void)[] = [];
    const quality = useSettingsStore.getState().quality;
    createBoard(skin, {
      host,
      clock: client.anim,
      quality: quality === 'auto' ? 'high' : quality,
      def,
      insets: insetsRef.current,
      label: boardLabel,
      onTap: (pick) => {
        if (!pick) return;
        if (pick.tile !== null) for (const cb of [...picks]) cb({ tile: pick.tile, lot: pick.lot });
      },
      onDoubleTap: () => {
        const seat = ctrlRef.current?.followed ?? null;
        if (seat !== null) ctrlRef.current?.follow(seat);
      },
      onContextLost: setLost,
      controller: {
        nameOf: (seat, view) => {
          const p = view.players.find((x) => x.seat === seat);
          return p ? tx(`characters:${CHARACTER_KEYS[p.character]}.name`) : `${seat + 1}P`;
        },
        autoFollow: () => useSettingsStore.getState().autoFollow && useUiStore.getState().followSeat === null,
        pinned: () => useUiStore.getState().followSeat,
      },
      signal: ac.signal,
    })
      .then((created) => {
        if (ac.signal.aborted) {
          created.surface.destroy();
          return;
        }
        surface = created.surface;
        surfaceRef.current = surface;
        const ctrl = created.controller;
        ctrlRef.current = ctrl;
        useSkinStore.getState().reportBoard(created.kind, created.fallback === 'renderer-failed' ? true : undefined);
        // 窗口在创建途中变化过：以最新的 insets 为准
        surface.camera.setInsets(insetsRef.current);
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
        exposeBoard((id) => ctrl.tileCanvasPos(id), surface);
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
        onReadyRef.current(ctrl, bridge, surface);
        // 开局先俯瞰全图（loadMap 已 fitAll），再拉近到正常比例跟随当前玩家
        const cam = surface.camera;
        if (cam.zoom < START_ZOOM) void cam.zoomTo(START_ZOOM, 600);
        const cur = client.player.displayView?.clock.cursor;
        ctrl.follow(cur?.t === 'seat' ? cur.seat : mySeat(useRoomStore.getState().room));
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        console.error('[board]', e);
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      ac.abort();
      for (const off of offs.splice(0)) off();
      client.attachBoard(null);
      exposeBoard(null, null);
      onReadyRef.current(null, null, null);
      ctrlRef.current?.clearFx();
      ctrlRef.current = null;
      surfaceRef.current = null;
      useSkinStore.getState().reportBoard(null);
      surface?.destroy();
    };
    // 棋盘只随地图（与棋盘皮肤）重建
  }, [client, def, map, skin]);

  useEffect(() => {
    surfaceRef.current?.camera.setInsets(insets);
  }, [insets]);

  return (
    <div className={h.board} ref={hostRef} data-testid="board-host" data-skin={skin}>
      {lost && <div className={h.boardNote}>{tx('hud:board.contextLost')}</div>}
      {error && (
        <div className={h.boardNote} role="alert">
          {tx('hud:board.error', { reason: error })}
        </div>
      )}
    </div>
  );
}
