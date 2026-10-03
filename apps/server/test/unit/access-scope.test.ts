// g 会话的房间作用域（net/accessScope.ts）：哪些事件拒绝、哪些只许进绑定的房间实例、哪些不受限
import { C2S_EVENTS } from '@rich4/shared/net';
import { describe, expect, it } from 'vitest';
import { checkScope, roomInstanceOf } from '../../src/net/accessScope';

const CREATED = 1_800_000_000_123;
const SCOPE = { room: '482913', instance: roomInstanceOf({ createdAt: CREATED }) };

function roomsOf(entries: Record<string, number>) {
  return { get: (code: string) => (code in entries ? { createdAt: entries[code]! } : undefined) };
}

describe('net/accessScope', () => {
  it('房间实例 = 创建时间的 base36（同号的新房间不同）', () => {
    expect(roomInstanceOf({ createdAt: CREATED })).toBe(CREATED.toString(36));
    expect(roomInstanceOf({ createdAt: CREATED + 1 })).not.toBe(SCOPE.instance);
    expect(SCOPE.instance).toMatch(/^[0-9a-z]{1,12}$/);
  });

  it('没有作用域（口令 / 邀请码会话、门禁关闭）一律放行', () => {
    const rooms = roomsOf({});
    for (const e of C2S_EVENTS) expect(checkScope(null, e, { code: '111111' }, '111111', rooms).ok, e).toBe(true);
  });

  it('建房、读档、公开房间列表一律拒绝；离开、存档列表与删除、时间校准不受限', () => {
    const rooms = roomsOf({ '482913': CREATED });
    for (const e of ['room:create', 'room:loadSave', 'lobby:list'] as const) {
      expect(checkScope(SCOPE, e, {}, '482913', rooms), e).toMatchObject({
        ok: false,
        error: { code: 'ACCESS_SCOPE', details: { room: '482913' } },
      });
    }
    for (const e of ['room:leave', 'saves:list', 'saves:delete', 'time:ping'] as const) {
      expect(checkScope(SCOPE, e, {}, '111111', rooms).ok, e).toBe(true);
    }
  });

  it('加入 / 续连只许绑定的房间实例：别的房间号、同号的新实例都拒绝；房间不存在交给处理函数', () => {
    const same = roomsOf({ '482913': CREATED, '111111': 1 });
    for (const e of ['room:join', 'room:resume'] as const) {
      expect(checkScope(SCOPE, e, { code: '482913' }, null, same).ok, e).toBe(true);
      expect(checkScope(SCOPE, e, { code: '111111' }, null, same).ok, e).toBe(false);
      expect(checkScope(SCOPE, e, { code: '999999' }, null, same).ok, e).toBe(false);
      expect(checkScope(SCOPE, e, { code: '482913' }, null, roomsOf({ '482913': CREATED + 5 })).ok, e).toBe(false);
      expect(checkScope(SCOPE, e, { code: '482913' }, null, roomsOf({})).ok, e).toBe(true);
    }
  });

  it('房间内事件：会话所在房间必须是绑定的实例；不在房间时交给处理函数（NOT_IN_ROOM）', () => {
    const rooms = roomsOf({ '482913': CREATED, '111111': 1 });
    const inRoom = [
      'room:setReady',
      'room:selectCharacter',
      'room:takeSeat',
      'room:start',
      'room:rematch',
      'room:claimSeat',
      'game:act',
      'game:save',
      'game:minigameSubmit',
      'chat:send',
      'chat:emote',
      'debug:act',
    ] as const;
    for (const e of inRoom) {
      expect(checkScope(SCOPE, e, {}, '482913', rooms).ok, e).toBe(true);
      expect(checkScope(SCOPE, e, {}, '111111', rooms).ok, e).toBe(false);
      expect(checkScope(SCOPE, e, {}, null, rooms).ok, e).toBe(true);
      expect(checkScope(SCOPE, e, {}, '482913', roomsOf({ '482913': CREATED + 5 })).ok, e).toBe(false);
    }
  });
});
