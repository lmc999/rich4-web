/**
 * chat:* 处理器（design/net.md §9）。限流（每 10 秒 5 条、表情冷却 1.5 秒）在 guard 完成。
 */
import { type AppSocket, type HandlerCtx, handle } from '../guard';
import { currentRoom } from './room';

export function registerChatHandlers(ctx: HandlerCtx, socket: AppSocket): void {
  handle(ctx, socket, 'chat:send', (p, s) => {
    const r = currentRoom(ctx, s);
    return r.ok ? r.data.chatSend(s.tokenHash, p.text) : r;
  });
  handle(ctx, socket, 'chat:emote', (p, s) => {
    const r = currentRoom(ctx, s);
    return r.ok ? r.data.emote(s.tokenHash, p.emoteId, p.targetSeat) : r;
  });
}
