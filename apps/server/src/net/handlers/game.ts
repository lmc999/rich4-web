/**
 * game:* 处理器（design/net.md §6.2；architecture §5.8）。seat 只从 session 取。
 * 小游戏裁判（M8）尚未实现：对应事件返回明确的错误码，不让请求挂起。game:save 见 Room.saveGame。
 */
import { fail } from '@rich4/shared/net';
import { type AppSocket, type HandlerCtx, handle } from '../guard';
import { currentRoom } from './room';

export function registerGameHandlers(ctx: HandlerCtx, socket: AppSocket): void {
  handle(ctx, socket, 'game:act', (p, s) => {
    const r = currentRoom(ctx, s);
    return r.ok ? r.data.act(s.tokenHash, p.decisionId, p.intent, p.clientActionId) : r;
  });
  handle(ctx, socket, 'game:autopilot', (p, s) => {
    const r = currentRoom(ctx, s);
    return r.ok ? r.data.autopilot(s.tokenHash, p.on, p.settings) : r;
  });
  handle(ctx, socket, 'game:pause', (p, s) => {
    const r = currentRoom(ctx, s);
    return r.ok ? r.data.pause(s.tokenHash, p.paused) : r;
  });
  handle(ctx, socket, 'game:resync', (_p, s, sock) => {
    const r = currentRoom(ctx, s);
    return r.ok ? r.data.resync(s.tokenHash, sock.id) : r;
  });
  handle(ctx, socket, 'game:save', (p, s) => {
    const r = currentRoom(ctx, s);
    return r.ok ? r.data.saveGame(s.tokenHash, p.name) : r;
  });
  handle(ctx, socket, 'game:minigameInput', (_p, s) => {
    const r = currentRoom(ctx, s);
    return r.ok ? fail('MINIGAME_INVALID', { reason: 'refereeUnavailable' }) : r;
  });
  handle(ctx, socket, 'game:minigameSubmit', (_p, s) => {
    const r = currentRoom(ctx, s);
    return r.ok ? fail('MINIGAME_INVALID', { reason: 'refereeUnavailable' }) : r;
  });
}
