/**
 * lobby:list（public 房间列表，方便直接围观）。存档列表与删除见 handlers/saves.ts。
 */
import { ok } from '@rich4/shared/net';
import { type AppSocket, type HandlerCtx, handle } from '../guard';

export function registerLobbyHandlers(ctx: HandlerCtx, socket: AppSocket): void {
  handle(ctx, socket, 'lobby:list', () => ok({ rooms: ctx.rooms.listPublic() }));
}
