/**
 * RoomManager.restore 的各条路径（design/net.md §8.5）：journal 重放、引擎主版本不同只迁移快照、
 * 迁移失败或地图缺失转存档、引擎不可用保留快照、快照损坏丢弃。
 */
import type { EngineApi, GameState } from '@rich4/shared/engine';
import { canonicalJson, fnv1a64 } from '@rich4/shared/util';
import { describe, expect, it } from 'vitest';
import { fixtureCatalog } from '../../src/data/DataRegistry';
import { AiDriver } from '../../src/game/AiDriver';
import { DEFAULT_TIMING } from '../../src/game/Deadlines';
import { silentLogger } from '../../src/infra/logger';
import { gunzipJson, Signer } from '../../src/persistence/codec';
import { openPersistence, type Persistence } from '../../src/persistence/index';
import { RoomPersister } from '../../src/persistence/RoomPersister';
import { autoSaveId, SaveService } from '../../src/persistence/SaveService';
import { DEFAULT_ROOM_TTLS, sourceVerifiedOf } from '../../src/rooms/Room';
import { RoomBroadcaster } from '../../src/rooms/RoomBroadcaster';
import { RoomManager, rulesVersion } from '../../src/rooms/RoomManager';
import { RoomCodeAllocator } from '../../src/rooms/roomCode';
import { localPolicy } from '../helpers/localPolicy';
import { ManualScheduler } from '../helpers/manualScheduler';
import { createStubEngine } from '../helpers/stubEngine';

const hashOf = (s: GameState) => fnv1a64(canonicalJson(s));
const who = (t: string) => ({ tokenHash: t, nickname: `n${t}`, socketId: `sock-${t}` });

function boot(p: Persistence, engine: EngineApi | null = createStubEngine()) {
  const sched = new ManualScheduler();
  const catalog = fixtureCatalog();
  let ids = 0;
  const saves = new SaveService({
    repo: p.saves,
    signer: new Signer('s'.repeat(32)),
    engine,
    catalog,
    clock: sched,
    log: silentLogger,
    newId: () => `s${++ids}`,
  });
  const rooms = new RoomManager({
    clock: sched,
    scheduler: sched,
    log: silentLogger,
    out: new RoomBroadcaster({ emit: () => {} }),
    engine,
    maps: catalog,
    ai: new AiDriver({ policy: localPolicy, log: silentLogger, thinkMs: { normal: [0, 0], fast: [0, 0] } }),
    timing: DEFAULT_TIMING,
    publicUrl: 'http://rich4.test',
    testMode: true,
    ttl: DEFAULT_ROOM_TTLS,
    seedHex: () => '0123456789abcdef0123456789abcdef',
    randomInt: () => 0,
    newId: () => `x${++ids}`,
    codes: new RoomCodeAllocator({ clock: sched }),
    maxRooms: 10,
    onMemberRemoved: () => {},
    persist: new RoomPersister({ store: p.rooms, scheduler: sched, log: silentLogger }),
    saves,
  });
  const restore = () =>
    rooms.restore({
      store: p.rooms,
      maxAgeMs: 24 * 3600_000,
      openSave: (id) => saves.open(null, id),
      storeSave: (file, code, owners, verified) =>
        saves.store(file, { kind: 'auto', roomCode: code, owners, verified }),
    });
  return { rooms, saves, sched, restore };
}

/** 两名真人开局并打 n 个 debug action；返回房间号与最终状态 */
function playedRoom(p: Persistence, n: number) {
  const b = boot(p);
  const room = b.rooms.create(who('T0'), { timerPreset: 'off' });
  if (!room.ok) throw new Error('create');
  const r = room.data.room;
  expect(r.join(who('T1'), 'player').ok).toBe(true);
  r.setReady('T1', true);
  expect(r.start('T0').ok).toBe(true);
  for (let i = 1; i <= n; i++) expect(r.debug('T0', { op: 'setPoints', seat: 0, points: i }).ok).toBe(true);
  const state = r.runner!.state;
  b.rooms.suspendAll({ flush: false, autosave: false });
  return { code: r.code, state, epoch: r.epoch };
}

describe('RoomManager.restore', () => {
  it('journal 重放：状态一致、epoch+1、暂停；恢复后写新快照', () => {
    const p = openPersistence({ kind: 'sqlite', location: ':memory:' });
    const g = playedRoom(p, 7);
    const b = boot(p);
    expect(b.restore()).toEqual([
      { code: g.code, phase: 'playing', mode: 'journal', replayed: 7, epoch: g.epoch + 1, seq: 7 },
    ]);
    const room = b.rooms.get(g.code)!;
    expect(hashOf(room.runner!.state)).toBe(hashOf(g.state));
    expect(room.phase).toBe('paused');
    expect(p.rooms.listActive(0)[0]).toMatchObject({ epoch: g.epoch + 1, seq: 7 });
    expect(p.rooms.readJournal(g.code, g.epoch, 0)).toEqual([]);
    p.close();
  });

  it('引擎主版本不同：只迁移快照，不重放 journal', () => {
    const p = openPersistence({ kind: 'sqlite', location: ':memory:' });
    const g = playedRoom(p, 3);
    const [rec] = p.rooms.listActive(0);
    p.rooms.writeSnapshot({ ...rec!, engineVersion: '9.0.0', seq: 0 });
    for (let i = 1; i <= 3; i++) {
      p.rooms.appendJournal(g.code, g.epoch, {
        seq: i,
        ts: 0,
        actor: 'system',
        action: { type: 'SYS_DEBUG', op: { op: 'setPoints', seat: 0, points: 50 } },
      });
    }
    const b = boot(p);
    const [rep] = b.restore();
    expect(rep).toMatchObject({ mode: 'migrated', replayed: 0, seq: 0 });
    expect(hashOf(b.rooms.get(g.code)!.runner!.state)).toBe(hashOf(rec!.state!));
    p.close();
  });

  it('次版本不同（规则或数据变化）也不重放 journal；只差修订号照常重放', () => {
    expect(rulesVersion('0.2.0')).toBe('0.2');
    expect(rulesVersion('0.2.7')).toBe(rulesVersion('0.2.0'));
    expect(rulesVersion('0.3.0')).not.toBe(rulesVersion('0.2.0'));
    expect(rulesVersion('0.0.0-stub')).toBe('0.0');
    const journal = (p: Persistence, code: string, epoch: number) => {
      for (let i = 1; i <= 3; i++) {
        p.rooms.appendJournal(code, epoch, {
          seq: i,
          ts: 0,
          actor: 'system',
          action: { type: 'SYS_DEBUG', op: { op: 'setPoints', seat: 0, points: 50 } },
        });
      }
    };
    // 存根引擎 ENGINE_VERSION = 0.0.0-stub：快照写于 0.1.x → 次版本不同
    const p = openPersistence({ kind: 'sqlite', location: ':memory:' });
    const g = playedRoom(p, 3);
    const [rec] = p.rooms.listActive(0);
    p.rooms.writeSnapshot({ ...rec!, engineVersion: '0.1.4', seq: 0 });
    journal(p, g.code, g.epoch);
    expect(boot(p).restore()[0]).toMatchObject({ mode: 'migrated', replayed: 0, seq: 0 });
    p.close();
    // 0.0.9 → 只差修订号：重放
    const q = openPersistence({ kind: 'sqlite', location: ':memory:' });
    const h = playedRoom(q, 3);
    const [rec2] = q.rooms.listActive(0);
    q.rooms.writeSnapshot({ ...rec2!, engineVersion: '0.0.9', seq: 0 });
    journal(q, h.code, h.epoch);
    expect(boot(q).restore()[0]).toMatchObject({ mode: 'journal', replayed: 3, seq: 3 });
    q.close();
  });

  it('迁移失败：转为存档 auto:<code>（owner 为座位上的真人），删除房间快照', () => {
    const p = openPersistence({ kind: 'sqlite', location: ':memory:' });
    const g = playedRoom(p, 2);
    const [rec] = p.rooms.listActive(0);
    p.rooms.writeSnapshot({ ...rec!, stateVersion: 0 });
    const b = boot(p);
    const [rep] = b.restore();
    expect(rep).toMatchObject({ code: g.code, mode: 'converted' });
    expect(b.rooms.get(g.code)).toBeUndefined();
    expect(p.rooms.listActive(0)).toEqual([]);
    const list = b.saves.list('T1');
    expect(list.map((x) => [x.saveId, x.kind])).toEqual([[autoSaveId(g.code), 'auto']]);
    expect(list[0]!.name).toContain('服务器升级');
    expect(list[0]!.verified).toBe(true);
    p.close();
  });

  it('转存档时沿用对局来源的可信度：由非官方存档读档而来的对局转成的存档不签名；观战私聊不进存档', () => {
    const p = openPersistence({ kind: 'sqlite', location: ':memory:' });
    const g = playedRoom(p, 2);
    const [rec] = p.rooms.listActive(0);
    const spec = {
      id: 'c1',
      ts: 0,
      from: { kind: 'spectator', nickname: 'w' },
      text: '悄悄话',
      audience: 'spectators',
    };
    p.rooms.writeSnapshot({
      ...rec!,
      stateVersion: 0,
      meta: { ...rec!.meta, sourceSaveId: 's-src', sourceVerified: false, chat: [...rec!.meta.chat, spec as never] },
    });
    const b = boot(p);
    expect(b.restore()[0]).toMatchObject({ mode: 'converted' });
    const [sv] = b.saves.list('T1');
    expect(sv).toMatchObject({ saveId: autoSaveId(g.code), verified: false });
    const blob = p.saves.get(sv!.saveId)!.blob;
    const chatTail = (gunzipJson(blob) as { chatTail: { audience: string }[] }).chatTail;
    expect(chatTail.length).toBeGreaterThan(0);
    expect(chatTail.some((m) => m.audience === 'spectators')).toBe(false);
    // 旧快照没有 sourceVerified：读档来的按不可信处理，新开的对局可信
    expect(sourceVerifiedOf({ sourceSaveId: null })).toBe(true);
    expect(sourceVerifiedOf({ sourceSaveId: 's1' })).toBe(false);
    expect(sourceVerifiedOf({ sourceSaveId: 's1', sourceVerified: true })).toBe(true);
    p.close();
  });

  it('地图缺失：转存档；引擎不可用：保留快照（skipped）；快照损坏：丢弃（failed）', () => {
    const p = openPersistence({ kind: 'sqlite', location: ':memory:' });
    const g = playedRoom(p, 1);
    const [rec] = p.rooms.listActive(0);

    const none = boot(p, null);
    expect(none.restore()).toEqual([
      {
        code: g.code,
        phase: 'playing',
        mode: 'skipped',
        replayed: 0,
        epoch: g.epoch,
        seq: rec!.seq,
        error: 'engineUnavailable',
      },
    ]);
    expect(p.rooms.listActive(0)).toHaveLength(1);

    const st = rec!.state!;
    p.rooms.writeSnapshot({ ...rec!, state: { ...st, dataRef: { ...st.dataRef, mapHash: 'gone' } } });
    expect(boot(p).restore()[0]).toMatchObject({ mode: 'converted', error: 'map test unavailable' });

    p.rooms.writeSnapshot({ ...rec!, code: '222222' });
    p.db!.prepare("UPDATE room_snapshots SET state_blob = x'00' WHERE code = '222222'").run();
    expect(boot(p).restore()).toMatchObject([{ code: '222222', mode: 'failed' }]);
    expect(p.rooms.listActive(0)).toEqual([]);
    p.close();
  });

  it('有效计时档位按恢复出的座位控制方式判定：对局中离开的座位不算真人，离开的人回来后恢复计时', () => {
    const p = openPersistence({ kind: 'sqlite', location: ':memory:' });
    const b1 = boot(p);
    const created = b1.rooms.create(who('T0'), { timerPreset: 'normal' });
    if (!created.ok) throw new Error('create');
    const r = created.data.room;
    expect(r.join(who('T1'), 'player').ok).toBe(true);
    r.setReady('T1', true);
    expect(r.start('T0').ok).toBe(true);
    expect(r.viewFor('T0').effectiveTimerPreset).toBe('normal');
    expect(r.leave('T1').ok).toBe(true);
    expect(r.viewFor('T0').effectiveTimerPreset).toBe('off');
    b1.rooms.suspendAll({ flush: false, autosave: false });

    const b2 = boot(p);
    expect(b2.restore()).toMatchObject([{ code: r.code, mode: 'journal' }]);
    const room = b2.rooms.get(r.code)!;
    expect(room.controlOf(1)).toBe('autopilot:left');
    expect(room.viewFor('T0').effectiveTimerPreset).toBe('off');
    // 房主回来：自动继续，仍不限时
    expect(room.resume(who('T0'), 0, 0).ok).toBe(true);
    expect(room.phase).toBe('playing');
    const d = room.runner!.pendingDecisions().find((x) => x.seat === 0)!;
    expect(room.runner!.deadlineOf(d.id)).toBeNull();
    // 离开的人回来：两名真人，按档位计时
    expect(room.resume(who('T1'), 0, 0).ok).toBe(true);
    expect(room.viewFor('T0').effectiveTimerPreset).toBe('normal');
    expect(room.runner!.deadlineOf(d.id)).toBe(b2.sched.now() + 30_000);
    p.close();
  });
});
