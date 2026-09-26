/**
 * debug:act：只在 RICH4_TEST_MODE=1 时注册（io.ts 判断）；服务器以系统 action SYS_DEBUG 提交，
 * 引擎另外要求 config.debug=true（测试模式开局时由房间打开）。
 */
import { type AppSocket, type HandlerCtx, handle } from '../guard';
import { currentRoom } from './room';

export function registerDebugHandlers(ctx: HandlerCtx, socket: AppSocket): void {
  handle(ctx, socket, 'debug:act', (p, s) => {
    const r = currentRoom(ctx, s);
    return r.ok ? r.data.debug(s.tokenHash, p.op) : r;
  });
}
