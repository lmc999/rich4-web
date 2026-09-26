/**
 * lobby:list 与 saves:*（存档列表在 M5 接入持久化后才有内容）。
 */
import { fail, ok } from '@rich4/shared/net';
import { type AppSocket, type HandlerCtx, handle } from '../guard';

export function registerLobbyHandlers(ctx: HandlerCtx, socket: AppSocket): void {
  handle(ctx, socket, 'lobby:list', () => ok({ rooms: ctx.rooms.listPublic() }));
  handle(ctx, socket, 'saves:list', () => ok({ saves: [] }));
  handle(ctx, socket, 'saves:delete', () => fail('SAVE_NOT_FOUND'));
}
