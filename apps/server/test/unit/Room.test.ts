/**
 * Room 回归：对局中无人在线的回收计时与暂停原因无关；房主不会落在离线 / 已离开的成员身上。
 */
import { defaultGameConfig } from '@rich4/shared/engine';
import { defaultRoomSettings, type RoomSettings } from '@rich4/shared/net';
import { describe, expect, it } from 'vitest';
import { fixtureCatalog } from '../../src/data/DataRegistry';
import { AiDriver } from '../../src/game/AiDriver';
import { DEFAULT_TIMING } from '../../src/game/Deadlines';
import { silentLogger } from '../../src/infra/logger';
import { DEFAULT_ROOM_TTLS, Room, type RoomTtls } from '../../src/rooms/Room';
import { RoomBroadcaster } from '../../src/rooms/RoomBroadcaster';
import { localPolicy } from '../helpers/localPolicy';
import { ManualScheduler } from '../helpers/manualScheduler';
import { createStubEngine } from '../helpers/stubEngine';

const ABANDON = 300;

function harness(o: { settings?: Partial<RoomSettings>; ttl?: Partial<RoomTtls> } = {}) {
  const sched = new ManualScheduler();
  const catalog = fixtureCatalog();
  let ids = 0;
  const closed: string[] = [];
  const room = new Room(
    '123456',
    {
      clock: sched,
      scheduler: sched,
      log: silentLogger,
      out: new RoomBroadcaster({ emit: () => {} }),
      engine: createStubEngine({ registry: catalog.registry }),
      maps: catalog,
      ai: new AiDriver({ policy: localPolicy, log: silentLogger, thinkMs: { normal: [0, 0], fast: [0, 0] } }),
      timing: DEFAULT_TIMING,
      publicUrl: 'http://rich4.test',
      testMode: true,
      ttl: { ...DEFAULT_ROOM_TTLS, abandonMs: ABANDON, ...o.ttl },
      seedHex: () => '0123456789abcdef0123456789abcdef',
      randomInt: () => 0,
      newId: () => `s${++ids}`,
      onMemberRemoved: () => {},
      onClosed: (_r, reason) => closed.push(reason),
    },
    { ...defaultRoomSettings(defaultGameConfig('test', 20260927)), reconnectGraceSec: 1, ...o.settings },
    { tokenHash: 'T0', nickname: 'A', socketId: 'sock-T0' },
  );
  const who = (t: string) => ({ tokenHash: t, nickname: `n${t}`, socketId: `sock-${t}` });
  /** A（房主）+ B 两名真人开局 */
  const startTwo = () => {
    expect(room.join(who('T1'), 'player').ok).toBe(true);
    room.setReady('T1', true);
    expect(room.start('T0')).toEqual({ ok: true });
    expect(room.phase).toBe('playing');
  };
  return { room, sched, closed, who, startTwo };
}

describe('Room：对局中无人在线的回收', () => {
  it('房主暂停后全员离线：abandonMs 后回收', () => {
    const h = harness();
    h.startTwo();
    expect(h.room.pause('T0', true).ok).toBe(true);
    expect(h.room.pausedInfo?.reason).toBe('host');
    h.room.socketDisconnected('T0', 'sock-T0');
    h.room.socketDisconnected('T1', 'sock-T1');
    expect(h.room.phase).toBe('paused');
    expect(h.room.pausedInfo?.reason).toBe('host');
    h.sched.advance(ABANDON - 1);
    expect(h.closed).toEqual([]);
    h.sched.advance(1);
    expect(h.closed).toHaveLength(1);
    expect(h.room.phase).toBe('closed');
  });

  it('pauseWhenAllAway=false：全员离线时继续由 AI 代打，但同样在 abandonMs 后回收', () => {
    const h = harness({ settings: { pauseWhenAllAway: false } });
    h.startTwo();
    h.room.socketDisconnected('T0', 'sock-T0');
    h.room.leave('T1');
    expect(h.room.phase).toBe('playing');
    h.sched.advance(ABANDON);
    expect(h.room.phase).toBe('closed');
  });

  it('有真人重连就取消回收计时（暂停原因为 host 时房间保持暂停）', () => {
    const h = harness();
    h.startTwo();
    h.room.pause('T0', true);
    h.room.socketDisconnected('T0', 'sock-T0');
    h.room.socketDisconnected('T1', 'sock-T1');
    h.sched.advance(ABANDON - 50);
    expect(h.room.resume(h.who('T1'), 0, 0).ok).toBe(true);
    h.sched.advance(10 * ABANDON);
    expect(h.closed).toEqual([]);
    expect(h.room.phase).toBe('paused');
  });

  it('all_away 暂停照旧：回收计时生效，有人回来自动恢复', () => {
    const h = harness();
    h.startTwo();
    h.room.socketDisconnected('T0', 'sock-T0');
    h.room.socketDisconnected('T1', 'sock-T1');
    expect(h.room.pausedInfo?.reason).toBe('all_away');
    h.room.resume(h.who('T0'), 0, 0);
    expect(h.room.phase).toBe('playing');
    h.sched.advance(ABANDON * 2);
    expect(h.closed).toEqual([]);
  });
});

describe('Room：房主迁移', () => {
  it('transferHost 不能转给离线的真人', () => {
    const h = harness();
    h.room.join(h.who('T1'), 'player');
    h.room.socketDisconnected('T1', 'sock-T1');
    expect(h.room.transferHost('T0', 1)).toMatchObject({
      ok: false,
      error: { code: 'BAD_REQUEST', details: { reason: 'targetOffline' } },
    });
    expect(h.room.hostToken).toBe('T0');
    h.room.resume(h.who('T1'), 0, 0);
    expect(h.room.transferHost('T0', 1).ok).toBe(true);
    expect(h.room.hostToken).toBe('T1');
  });

  it('对局中房主离开时没有在线真人：之后第一个上线的真人接任房主', () => {
    const h = harness();
    h.startTwo();
    h.room.socketDisconnected('T1', 'sock-T1');
    expect(h.room.leave('T0').ok).toBe(true);
    expect(h.room.hostToken).toBe('T0');
    expect(h.room.resume(h.who('T1'), 0, 0).ok).toBe(true);
    expect(h.room.hostToken).toBe('T1');
    expect(h.room.viewFor('T1').you).toMatchObject({ isHost: true });
    expect(h.room.pause('T1', true).ok).toBe(true);
  });

  it('房主断线宽限期内有人上线不抢房主；宽限过后无人在线，下一个上线的真人接任', () => {
    const h = harness();
    h.room.join(h.who('T1'), 'player');
    h.room.socketDisconnected('T0', 'sock-T0');
    h.room.socketDisconnected('T1', 'sock-T1');
    h.room.resume(h.who('T1'), 0, 0);
    expect(h.room.hostToken).toBe('T0');
    h.room.socketDisconnected('T1', 'sock-T1');
    h.sched.advance(1000);
    expect(h.room.hostToken).toBe('T0');
    h.room.resume(h.who('T1'), 0, 0);
    expect(h.room.hostToken).toBe('T1');
    // 已是房主：开局被拒的原因是 T0 未准备，而不是 NOT_HOST
    expect(h.room.start('T1')).toMatchObject({ ok: false, error: { code: 'NOT_ALL_READY' } });
  });

  it('canJoin 与 join 判定一致（满员、对局中、禁止观战）', () => {
    const h = harness({ settings: { allowSpectators: false } });
    expect(h.room.canJoin('T0', 'player').ok).toBe(true);
    for (const t of ['T1', 'T2', 'T3']) {
      expect(h.room.canJoin(t, 'player').ok).toBe(true);
      h.room.join(h.who(t), 'player');
    }
    expect(h.room.canJoin('T4', 'player')).toMatchObject({ ok: false, error: { code: 'ROOM_FULL' } });
    expect(h.room.join(h.who('T4'), 'player')).toMatchObject({ ok: false, error: { code: 'ROOM_FULL' } });
    expect(h.room.canJoin('T4', 'spectator')).toMatchObject({ ok: false, error: { code: 'SPECTATORS_DISABLED' } });
  });
});
