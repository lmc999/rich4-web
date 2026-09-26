// 房间状态（design/client.md §10.1）：服务器每次推送全量 RoomView；这里只保存最新一份并提供派生查询。

import type { SeatIndex } from '@rich4/shared/engine';
import type { AppError, RoomClosedReason, RoomView, SeatView } from '@rich4/shared/net';
import { create } from 'zustand';

export interface RoomState {
  room: RoomView | null;
  /** 房间被关闭（解散、被踢、闲置回收、服务器停机）；UI 据此回到首页并提示 */
  closed: { code: string; reason: RoomClosedReason } | null;
  /** 最近一次房间操作失败 */
  error: AppError | null;
  setRoom(room: RoomView): void;
  setClosed(code: string, reason: RoomClosedReason): void;
  setError(e: AppError | null): void;
  clear(): void;
}

export const useRoomStore = create<RoomState>()((set) => ({
  room: null,
  closed: null,
  error: null,
  setRoom: (room) => set({ room, closed: null }),
  setClosed: (code, reason) => set({ room: null, closed: { code, reason } }),
  setError: (error) => set({ error }),
  clear: () => set({ room: null, closed: null, error: null }),
}));

/** 本人座位（观战者为 null） */
export function mySeat(room: RoomView | null): SeatIndex | null {
  return room?.you.role === 'player' ? room.you.seat : null;
}

export function isHost(room: RoomView | null): boolean {
  return room?.you.isHost === true;
}

export function isSpectator(room: RoomView | null): boolean {
  return room?.you.role === 'spectator';
}

export function mySeatView(room: RoomView | null): SeatView | null {
  const s = mySeat(room);
  return s === null || !room ? null : (room.seats[s] ?? null);
}

/** 座位显示名：真人昵称 / 电脑名 */
export function seatDisplayName(room: RoomView | null, seat: SeatIndex): string | null {
  const o = room?.seats[seat]?.occupant;
  if (!o) return null;
  return o.kind === 'human' ? o.nickname : o.name;
}

/** 开局按钮可用：房主、大厅、参与者 ≥ 2、除房主外的真人都已准备 */
export function canStart(room: RoomView | null): boolean {
  if (room?.phase !== 'lobby' || !room.you.isHost) return false;
  const parts = room.seats.filter((s) => s.occupant !== null);
  if (parts.length < 2) return false;
  return parts.every((s) => s.occupant?.kind !== 'human' || s.occupant.ready || s.isHost);
}
