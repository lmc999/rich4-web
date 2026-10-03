/**
 * 经房间邀请授权进入的会话（访问 cookie kind g）的作用域（architecture §35）：只对授权的那个房间实例有效。
 * 握手时把 cookie 的绑定写进 socket.data.scope（net/io.ts），每个 C2S 事件在 guard.handle 里先过 checkScope：
 * - room:create（建房；单机与首页读档也是先建房）、room:loadSave（读档）、lobby:list（公开房间列表）一律拒绝；
 * - room:join / room:resume 只许进绑定的房间实例（同号的新房间不算）；房间不存在时交给处理函数回 ROOM_NOT_FOUND；
 * - 其余房间内事件（room:* / game:* / chat:* / debug:*）要求会话当前所在的房间就是绑定的实例——会话按玩家 token 跨连接保留
 *   roomCode，换成 g cookie 之后不能继续操作以前所在的别的房间；会话不在房间时交给处理函数回 NOT_IN_ROOM；
 * - room:leave、saves:list / saves:delete（只涉及本人的存档归属）、time:ping 不受限。
 * 拒绝一律 ACCESS_SCOPE（details.room = 绑定的房间号；不透露目标房间是否存在）。
 * HTTP 侧：POST /api/access/grant 拒绝 g（AccessControl.grant），POST /api/saves/import 拒绝 g（http/saves.ts）。
 */
import { type C2SEventName, fail, ok, type Result } from '@rich4/shared/net';

/** g 会话绑定的房间实例 */
export interface AccessScope {
  /** 6 位房间号 */
  room: string;
  /** roomInstanceOf 的值 */
  instance: string;
}

/**
 * 房间实例：创建时间（毫秒）的 base36。随房间快照持久化（重启恢复后不变）；同一个房间号释放后再分配给新房间时一定不同，
 * 所以旧链接、旧 g cookie 进不了日后同号的新房间。
 */
export function roomInstanceOf(room: { readonly createdAt: number }): string {
  return Math.max(0, Math.trunc(room.createdAt)).toString(36);
}

const DENIED: ReadonlySet<C2SEventName> = new Set<C2SEventName>(['room:create', 'room:loadSave', 'lobby:list']);
const ENTER: ReadonlySet<C2SEventName> = new Set<C2SEventName>(['room:join', 'room:resume']);
const FREE: ReadonlySet<C2SEventName> = new Set<C2SEventName>([
  'room:leave',
  'saves:list',
  'saves:delete',
  'time:ping',
]);

/** 只读的房间查找（RoomManager.get） */
export interface ScopeRooms {
  get(code: string): { readonly createdAt: number } | undefined;
}

/** 事件是否在 g 会话的作用域内；scope 为 null（口令 / 邀请码会话、门禁关闭）时一律放行 */
export function checkScope(
  scope: AccessScope | null,
  event: C2SEventName,
  payload: unknown,
  currentRoom: string | null,
  rooms: ScopeRooms,
): Result<void> {
  if (!scope) return ok(undefined);
  const denied = (): Result<never> => fail('ACCESS_SCOPE', { room: scope.room });
  if (DENIED.has(event)) return denied();
  if (FREE.has(event)) return ok(undefined);
  const inScope = (code: string): boolean => {
    if (code !== scope.room) return false;
    const r = rooms.get(code);
    return r === undefined || roomInstanceOf(r) === scope.instance;
  };
  if (ENTER.has(event)) {
    const code = (payload as { code?: unknown } | null)?.code;
    return typeof code === 'string' && inScope(code) ? ok(undefined) : denied();
  }
  if (currentRoom === null) return ok(undefined);
  return inScope(currentRoom) ? ok(undefined) : denied();
}
