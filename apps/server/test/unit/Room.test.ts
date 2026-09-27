/**
 * Room 回归：对局中无人在线的回收计时与暂停原因无关；房主不会落在离线 / 已离开的成员身上；
 * 表情冷却；持久化挂钩（journal、phase 变化快照、防抖、关闭删除）与 DAY_END 自动存档。
 */
import { defaultGameConfig } from '@rich4/shared/engine';
import { defaultRoomSettings, EMOTE_COOLDOWN_MS, fail, ok, type RoomSettings } from '@rich4/shared/net';
import { describe, expect, it } from 'vitest';
import { fixtureCatalog } from '../../src/data/DataRegistry';
import { AiDriver } from '../../src/game/AiDriver';
import { DEFAULT_TIMING } from '../../src/game/Deadlines';
import type { JournalEntry } from '../../src/game/GameRunner';
import { silentLogger } from '../../src/infra/logger';
import type { PersistableRoom, RoomPersistence } from '../../src/persistence/RoomPersister';
import { buildSaveFile, type LoadedSave } from '../../src/persistence/SaveService';
import type { SaveKind, ServerSaveFile } from '../../src/persistence/types';
import { DEFAULT_ROOM_TTLS, Room, type RoomSaves, type RoomTtls } from '../../src/rooms/Room';
import { RoomBroadcaster } from '../../src/rooms/RoomBroadcaster';
import { localPolicy } from '../helpers/localPolicy';
import { ManualScheduler } from '../helpers/manualScheduler';
import { createStubEngine } from '../helpers/stubEngine';

const ABANDON = 300;

interface PersistLog {
  actions: number[];
  snapshots: string[];
  touches: number;
  closed: number;
}

function recordingPersist(): { persist: RoomPersistence; log: PersistLog } {
  const log: PersistLog = { actions: [], snapshots: [], touches: 0, closed: 0 };
  return {
    log,
    persist: {
      action: (_r: PersistableRoom, e: JournalEntry) => log.actions.push(e.seq),
      snapshot: (r: PersistableRoom) => log.snapshots.push(r.phase),
      touch: () => {
        log.touches++;
      },
      closed: () => {
        log.closed++;
      },
    },
  };
}

function recordingSaves(): {
  saves: RoomSaves;
  stored: { kind: SaveKind; file: ServerSaveFile; owners: readonly string[] }[];
} {
  const stored: { kind: SaveKind; file: ServerSaveFile; owners: readonly string[] }[] = [];
  return {
    stored,
    saves: {
      store: (file, o) => {
        stored.push({ kind: o.kind, file, owners: o.owners });
        return ok({ saveId: o.kind === 'auto' ? `auto:${o.roomCode}` : `s${stored.length}` });
      },
      open: () => fail('SAVE_NOT_FOUND'),
      addOwners: () => {},
    },
  };
}

function harness(
  o: { settings?: Partial<RoomSettings>; ttl?: Partial<RoomTtls>; persist?: RoomPersistence; saves?: RoomSaves } = {},
) {
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
      ...(o.persist ? { persist: o.persist } : {}),
      ...(o.saves ? { saves: o.saves } : {}),
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

  it('座位上的真人全部 room:leave：立即自动存档（owner 为全部真人）并关闭房间；有人只是断线则不关', () => {
    const { saves, stored } = recordingSaves();
    const { persist, log } = recordingPersist();
    const h = harness({ saves, persist });
    h.startTwo();
    // B 只是断线、A 离开：B 还可能回来，房间保留（暂停等人）
    h.room.socketDisconnected('T1', 'sock-T1');
    expect(h.room.leave('T0').ok).toBe(true);
    expect(h.room.phase).toBe('paused');
    expect(h.closed).toEqual([]);
    expect(stored).toEqual([]);
    // B 回来后也离开：全员离开 → 自动存档、关闭、删除快照
    expect(h.room.resume(h.who('T1'), 0, 0).ok).toBe(true);
    expect(h.room.phase).toBe('playing');
    expect(h.room.leave('T1').ok).toBe(true);
    expect(h.room.phase).toBe('closed');
    expect(h.closed).toEqual(['idle']);
    expect(stored.map((x) => [x.kind, [...x.owners].sort()])).toEqual([['auto', ['T0', 'T1']]]);
    expect(log.closed).toBe(1);
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

describe('Room：表情冷却', () => {
  it('同一人 1.5 秒内第二个表情 RATE_LIMITED；过了冷却可以再发；各人独立', () => {
    const h = harness();
    h.room.join(h.who('T1'), 'player');
    expect(h.room.emote('T0', 'laugh', undefined).ok).toBe(true);
    expect(h.room.emote('T0', 'cry', 1)).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } });
    expect(h.room.emote('T1', 'cry', 0).ok).toBe(true);
    h.sched.advance(EMOTE_COOLDOWN_MS - 1);
    expect(h.room.emote('T0', 'cry', 1).ok).toBe(false);
    h.sched.advance(1);
    expect(h.room.emote('T0', 'cry', 1).ok).toBe(true);
    expect(h.room.emote('T0', 'nope', undefined)).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
  });
});

describe('Room：持久化挂钩与自动存档', () => {
  it('开局、暂停、恢复、结束写快照；每个 action 追加 journal；大厅变化只 touch；解散时自动存档并删除', () => {
    const p = recordingPersist();
    const sv = recordingSaves();
    const h = harness({ persist: p.persist, saves: sv.saves });
    h.room.join(h.who('T1'), 'player');
    expect(p.log.touches).toBeGreaterThan(0);
    expect(p.log.snapshots).toEqual([]);
    h.room.setReady('T1', true);
    expect(h.room.start('T0')).toEqual({ ok: true, data: undefined });
    expect(p.log.snapshots).toEqual(['playing']);
    expect(h.room.debug('T0', { op: 'setPoints', seat: 0, points: 3 }).ok).toBe(true);
    expect(p.log.actions).toEqual([1]);
    h.room.pause('T0', true);
    h.room.pause('T0', false);
    expect(p.log.snapshots).toEqual(['playing', 'paused', 'playing']);
    expect(h.room.saveGame('T1', 'x')).toMatchObject({ ok: false, error: { code: 'NOT_HOST' } });
    expect(h.room.saveGame('T0', '  我的\u200b存档 ')).toEqual({ ok: true, data: { saveId: 's1' } });
    expect(sv.stored[0]).toMatchObject({ kind: 'manual', owners: ['T0', 'T1'], file: { name: '我的存档' } });
    expect(sv.stored[0]!.file.seats.map((x) => [x.index, x.kind, x.ownerTokenHash])).toEqual([
      [0, 'human', 'T0'],
      [1, 'human', 'T1'],
    ]);
    expect(h.room.dissolve('T0').ok).toBe(true);
    expect(sv.stored.map((x) => x.kind)).toEqual(['manual', 'auto']);
    expect(p.log.closed).toBe(1);
  });

  it('DAY_END 触发自动存档（覆盖 auto:<code>）', () => {
    const sv = recordingSaves();
    const h = harness({ saves: sv.saves, settings: { timerPreset: 'off' } });
    h.startTwo();
    const runner = h.room.runner!;
    for (let i = 0; i < 400 && sv.stored.length === 0; i++) {
      const d = runner.pendingDecisions()[0]!;
      const token = d.seat === 0 ? 'T0' : 'T1';
      expect(h.room.act(token, d.id, d.defaultIntent, `c${i}`).ok).toBe(true);
    }
    expect(sv.stored.length).toBeGreaterThan(0);
    expect(sv.stored[0]).toMatchObject({ kind: 'auto', owners: ['T0', 'T1'] });
    expect(sv.stored[0]!.file.meta.gameDay).toBe(runner.state.clock.elapsedDays);
  });

  it('suspend：刷快照、自动存档、停止计时器，不删除持久化数据', () => {
    const p = recordingPersist();
    const sv = recordingSaves();
    const h = harness({ persist: p.persist, saves: sv.saves });
    h.startTwo();
    h.room.suspend({ flush: true, autosave: true });
    expect(h.room.phase).toBe('closed');
    expect(sv.stored.map((x) => x.kind)).toEqual(['auto']);
    expect(p.log.snapshots.at(-1)).toBe('playing');
    expect(p.log.closed).toBe(0);
    expect(h.sched.pendingCount()).toBe(0);
    expect(h.closed).toEqual([]);
  });
});

describe('Room：读档后的大厅', () => {
  /** 存档：座位 0、1 为真人（owner T0、T1），座位 2 为电脑 */
  function loadedSave(): LoadedSave {
    const engine = createStubEngine();
    const state = engine.createGame(
      { ...defaultGameConfig('test', 20260927), debug: true },
      [
        { seat: 0, character: 4, controller: 'human' },
        { seat: 1, character: 5, controller: 'human' },
        { seat: 2, character: 6, controller: 'ai', ai: { preset: 'gentle' } },
      ],
      '0123456789abcdef0123456789abcdef',
    );
    const file = buildSaveFile({
      name: 'S',
      savedAt: 0,
      engine,
      settings: { ...defaultRoomSettings(state.config), reconnectGraceSec: 1 },
      seats: [
        { index: 0, characterId: 4, nickname: 'A', kind: 'human', ownerTokenHash: 'T0' },
        { index: 1, characterId: 5, nickname: 'B', kind: 'human', ownerTokenHash: 'T1' },
        { index: 2, characterId: 6, nickname: 'C', kind: 'ai', ai: { preset: 'gentle' } },
      ],
      state,
      chat: [],
    });
    return { saveId: 'S1', name: 'S', verified: true, file, warnings: [] };
  }

  function loadedHarness() {
    const ls = loadedSave();
    const added: string[][] = [];
    const saves: RoomSaves = {
      store: () => ok({ saveId: 'x' }),
      open: (_t, id) => (id === 'S1' ? ok(ls) : fail('SAVE_NOT_FOUND')),
      addOwners: (_id, owners) => added.push([...owners]),
    };
    const h = harness({ saves });
    return { ...h, ls, added };
  }

  it('占座者让给 owner；电脑座位被房主清空后可由任何人认领，开局时引擎 controller 改回 human', () => {
    const h = loadedHarness();
    // T9（非 owner）先进来坐下，T0 读档：T9 坐进未认领的真人座位 1
    expect(h.room.join(h.who('T9'), 'player').ok).toBe(true);
    expect(h.room.loadSave('T0', 'S1')).toEqual({ ok: true, data: undefined });
    expect(
      h.room.seats.map((x) => (x.occupant?.kind === 'human' ? x.occupant.tokenHash : (x.occupant?.kind ?? null))),
    ).toEqual(['T0', 'T9', 'ai', null]);
    expect(h.room.seats.map((x) => x.characterId)).toEqual([4, 5, 6, null]);
    const occ = h.room.seats[0]!.occupant!;
    expect(Object.keys(occ).sort()).toEqual(['kind', 'nickname', 'ready', 'socketId', 'tokenHash']);
    // owner T1 加入：直接回到座位 1，T9 让到观战
    expect(h.room.join(h.who('T1'), 'player').ok).toBe(true);
    expect(h.room.roleOf('T1')).toEqual({ kind: 'seat', seat: 1 });
    expect(h.room.roleOf('T9')?.kind).toBe('spectator');
    expect(h.room.viewFor('T9').seats[1]!.savedSeat).toMatchObject({ nickname: 'B', claimableByYou: false });
    // 电脑座位：不能直接认领；房主清空后可认领
    expect(h.room.claimSeat('T9', 2)).toMatchObject({ ok: false, error: { code: 'SEAT_TAKEN' } });
    expect(h.room.setSeatAi('T0', 2, null).ok).toBe(true);
    expect(h.room.viewFor('T9').seats[2]!.savedSeat).toMatchObject({ wasHuman: false, claimableByYou: true });
    expect(h.room.claimSeat('T9', 2).ok).toBe(true);
    expect(h.room.seats[2]!.characterId).toBe(6);
    // 起身：座位空出但角色仍锁定
    expect(h.room.toSpectator('T9').ok).toBe(true);
    expect(h.room.seats[2]!.characterId).toBe(6);
    expect(h.room.takeSeat('T9', 2).ok).toBe(true);
    h.room.setReady('T1', true);
    expect(h.room.start('T0')).toMatchObject({ ok: false, error: { code: 'NOT_ALL_READY' } });
    h.room.setReady('T9', true);
    expect(h.room.start('T0')).toEqual({ ok: true, data: undefined });
    expect(h.room.sourceSaveId).toBe('S1');
    expect(h.added).toEqual([['T0', 'T1', 'T9']]);
    const p2 = h.room.runner!.state.players.find((p) => p.seat === 2)!;
    expect(p2.controller).toBe('human');
    expect(h.room.runner!.seq).toBe(1);
    expect(h.room.controlOf(2)).toBe('human');
  });

  it('读档后不能选角色、不能改对局配置；存档外的座位不能补电脑', () => {
    const h = loadedHarness();
    expect(h.room.loadSave('T0', 'S1').ok).toBe(true);
    expect(h.room.selectCharacter('T0', 0)).toMatchObject({ ok: false, error: { details: { reason: 'saveLoaded' } } });
    expect(h.room.updateSettings('T0', { game: { initialFund: 300000 } })).toMatchObject({
      ok: false,
      error: { details: { reason: 'saveLoaded' } },
    });
    expect(h.room.updateSettings('T0', { spectatorChat: 'off' }).ok).toBe(true);
    expect(h.room.setSeatAi('T0', 3, { preset: 'normal' })).toMatchObject({
      ok: false,
      error: { details: { reason: 'notInSave' } },
    });
    expect(h.room.loadSave('T0', 'nope')).toMatchObject({ ok: false, error: { code: 'SAVE_NOT_FOUND' } });
  });
});
