/**
 * game:* 处理器（design/net.md §6.2；architecture §5.8）。seat 只从 session 取。
 * 小游戏的 game:minigameInput / game:minigameSubmit 见 handlers/minigame.ts。game:save 见 Room.saveGame。
 */
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
}
