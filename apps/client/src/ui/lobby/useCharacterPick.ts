// 选角光标与提交的 React 钩子（规则见 characterPick.ts）：程序化 LobbyView 与原版 ClassicLobby 各自持有光标，
// 开始 / 准备按钮先 useCommitPick 提交光标上的角色，成功后再开始 / 准备；已准备时移开光标先取消准备（unreadyOnMove）。
import type { CharacterId } from '@rich4/shared/engine';
import type { RoomView } from '@rich4/shared/net';
import { useEffect, useMemo, useState } from 'react';
import { useClient } from '../../app/services';
import { defaultCursor, myCharacter, pendingPick, unreadyOnMove } from './characterPick';
import { useRun } from './SeatGrid';

export interface MoveCursorOptions {
  /** 这次移动同时就提交这个角色（原版画面单击没被选走的头像）：不取消准备 */
  committing?: boolean;
}

export type MoveCursor = (c: CharacterId, o?: MoveCursorOptions) => void;

/**
 * 光标状态：没动过时跟随 defaultCursor；服务器确认的选择变了（本人或读档认领）时光标跟过去。
 * 移动光标时，已准备的非房主玩家移开已提交的角色就先取消准备（开局由房主发起，不会替他提交光标上的角色）。
 * 返回 [光标, 移动光标]
 */
export function usePickCursor(room: RoomView): [CharacterId, MoveCursor] {
  const client = useClient();
  const run = useRun();
  const mine = myCharacter(room);
  const [moved, setMoved] = useState<CharacterId | null>(mine);
  useEffect(() => {
    if (mine !== null) setMoved(mine);
  }, [mine]);
  const fallback = useMemo(() => defaultCursor(room), [room]);
  const move: MoveCursor = (c, o = {}) => {
    setMoved(c);
    if (!o.committing && unreadyOnMove(room, c)) void run(client.setReady(false));
  };
  return [moved ?? fallback, move];
}

/** 返回「需要时先提交光标上的角色」：没有要提交的直接 true；提交失败（例如刚被别人选走）时提示并返回 false */
export function useCommitPick(room: RoomView, cursor: CharacterId): () => Promise<boolean> {
  const client = useClient();
  const run = useRun();
  return async () => {
    const c = pendingPick(room, cursor);
    return c === null ? true : run(client.selectCharacter(c));
  };
}
