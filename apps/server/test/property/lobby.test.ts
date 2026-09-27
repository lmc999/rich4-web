/**
 * 大厅模型测试（design/net.md §11.3 property/lobby，fast-check）：随机执行 join、leave、takeSeat、toSpectator、
 * selectCharacter、setReady、setSeatAi、kick、transferHost、start、rematch、断线与恢复，
 * 每一步后检查不变量：座位 ≤ 4、角色不重复、房主为空或是座位上的真人、同一 token 只出现在一个位置、
 * 对局中必有 GameRunner 且参与者 ≥ 2、所有操作都不抛异常。
 */
import { defaultGameConfig, type SeatIndex } from '@rich4/shared/engine';
import { defaultRoomSettings, type Result } from '@rich4/shared/net';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fixtureCatalog } from '../../src/data/DataRegistry';
import { AiDriver } from '../../src/game/AiDriver';
import { DEFAULT_TIMING } from '../../src/game/Deadlines';
import { silentLogger } from '../../src/infra/logger';
import { DEFAULT_ROOM_TTLS, Room } from '../../src/rooms/Room';
import { RoomBroadcaster } from '../../src/rooms/RoomBroadcaster';
import { localPolicy } from '../helpers/localPolicy';
import { ManualScheduler } from '../helpers/manualScheduler';
import { createStubEngine } from '../helpers/stubEngine';

const TOKENS = ['T0', 'T1', 'T2', 'T3', 'T4', 'T5'] as const;
type Tok = (typeof TOKENS)[number];

type Cmd =
  | { k: 'join'; t: Tok; role: 'player' | 'spectator' }
  | { k: 'leave'; t: Tok }
  | { k: 'takeSeat'; t: Tok; seat: SeatIndex }
  | { k: 'toSpectator'; t: Tok }
  | { k: 'selectCharacter'; t: Tok; c: 0 | 1 | 2 | 3 }
  | { k: 'setReady'; t: Tok; ready: boolean }
  | { k: 'setSeatAi'; t: Tok; seat: SeatIndex; on: boolean }
  | { k: 'kick'; t: Tok; seat: SeatIndex }
  | { k: 'transferHost'; t: Tok; seat: SeatIndex }
  | { k: 'start'; t: Tok }
  | { k: 'rematch'; t: Tok }
  | { k: 'disconnect'; t: Tok }
  | { k: 'resume'; t: Tok }
  | { k: 'advance'; ms: number }
  /** 宏：座位上的真人全部准备（让开局路径更容易被覆盖） */
  | { k: 'readyAll' }
  /** 宏：当前房主开局 */
  | { k: 'hostStart' }
  /** 宏：当前房主给空座位补电脑 */
  | { k: 'hostAddAi'; seat: SeatIndex };

const tok = fc.constantFrom(...TOKENS);
const seat = fc.constantFrom<SeatIndex>(0, 1, 2, 3);
const cmd: fc.Arbitrary<Cmd> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      k: fc.constant('join' as const),
      t: tok,
      role: fc.constantFrom('player' as const, 'player' as const, 'spectator' as const),
    }),
  },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('leave' as const), t: tok }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('takeSeat' as const), t: tok, seat }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('toSpectator' as const), t: tok }) },
  {
    weight: 3,
    arbitrary: fc.record({
      k: fc.constant('selectCharacter' as const),
      t: tok,
      c: fc.constantFrom(0 as const, 1 as const, 2 as const, 3 as const),
    }),
  },
  { weight: 3, arbitrary: fc.record({ k: fc.constant('setReady' as const), t: tok, ready: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('setSeatAi' as const), t: tok, seat, on: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('kick' as const), t: tok, seat }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('transferHost' as const), t: tok, seat }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('start' as const), t: tok }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('rematch' as const), t: tok }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('disconnect' as const), t: tok }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('resume' as const), t: tok }) },
  {
    weight: 1,
    arbitrary: fc.record({ k: fc.constant('advance' as const), ms: fc.constantFrom(1000, 20_000, 70_000) }),
  },
  { weight: 2, arbitrary: fc.constant({ k: 'readyAll' as const }) },
  { weight: 2, arbitrary: fc.constant({ k: 'hostStart' as const }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('hostAddAi' as const), seat }) },
);

function harness() {
  const sched = new ManualScheduler();
  const catalog = fixtureCatalog();
  const out = new RoomBroadcaster({ emit: () => {} });
  let ids = 0;
  let closed = false;
  const room = new Room(
    '123456',
    {
      clock: sched,
      scheduler: sched,
      log: silentLogger,
      out,
      engine: createStubEngine({ registry: catalog.registry }),
      maps: catalog,
      ai: new AiDriver({ policy: localPolicy, log: silentLogger, thinkMs: { normal: [0, 0], fast: [0, 0] } }),
      timing: DEFAULT_TIMING,
      publicUrl: 'http://rich4.test',
      testMode: true,
      ttl: DEFAULT_ROOM_TTLS,
      seedHex: () => '0123456789abcdef0123456789abcdef',
      randomInt: (n) => (n > 1 ? 1 : 0),
      newId: () => `s${++ids}`,
      onMemberRemoved: () => {},
      onClosed: () => {
        closed = true;
      },
    },
    { ...defaultRoomSettings(defaultGameConfig('test', 20260927)), maxSpectators: 3 },
    { tokenHash: 'T0', nickname: 'n0', socketId: 'sock-T0' },
  );
  return { room, sched, isClosed: () => closed };
}

function run(room: Room, sched: ManualScheduler, c: Cmd): Result<unknown> | null {
  const who = (t: Tok) => ({ tokenHash: t, nickname: `n${t}`, socketId: `sock-${t}` });
  switch (c.k) {
    case 'join':
      return room.join(who(c.t), c.role);
    case 'leave':
      return room.leave(c.t);
    case 'takeSeat':
      return room.takeSeat(c.t, c.seat);
    case 'toSpectator':
      return room.toSpectator(c.t);
    case 'selectCharacter':
      return room.selectCharacter(c.t, c.c);
    case 'setReady':
      return room.setReady(c.t, c.ready);
    case 'setSeatAi':
      return room.setSeatAi(c.t, c.seat, c.on ? { preset: 'normal' } : null);
    case 'kick':
      return room.kick(c.t, { seat: c.seat });
    case 'transferHost':
      return room.transferHost(c.t, c.seat);
    case 'start':
      return room.start(c.t);
    case 'rematch':
      return room.rematch(c.t);
    case 'disconnect':
      room.socketDisconnected(c.t, `sock-${c.t}`);
      return null;
    case 'resume':
      return room.resume(who(c.t), 0, 0);
    case 'advance':
      sched.advance(c.ms);
      return null;
    case 'readyAll':
      for (const s of room.seats) if (s.occupant?.kind === 'human') room.setReady(s.occupant.tokenHash, true);
      return null;
    case 'hostStart':
      return room.start(room.hostToken ?? 'T0');
    case 'hostAddAi':
      return room.setSeatAi(room.hostToken ?? 'T0', c.seat, { preset: 'gentle' });
  }
}

function checkInvariants(room: Room): void {
  expect(room.seats).toHaveLength(4);
  const positions = new Map<string, number>();
  for (const s of room.seats) {
    if (s.occupant?.kind === 'human')
      positions.set(s.occupant.tokenHash, (positions.get(s.occupant.tokenHash) ?? 0) + 1);
  }
  for (const sp of room.spectators.values()) positions.set(sp.tokenHash, (positions.get(sp.tokenHash) ?? 0) + 1);
  for (const [t, n] of positions) expect(n, `token ${t} appears ${n} times`).toBe(1);
  const chars = room.seats.map((s) => s.characterId).filter((c) => c !== null);
  expect(new Set(chars).size).toBe(chars.length);
  if (room.hostToken !== null) {
    expect(room.seats.some((s) => s.occupant?.kind === 'human' && s.occupant.tokenHash === room.hostToken)).toBe(true);
  }
  expect(room.spectators.size).toBeLessThanOrEqual(room.settings.maxSpectators);
  if (room.phase === 'playing' || room.phase === 'paused' || room.phase === 'ended') {
    expect(room.runner).not.toBeNull();
    expect(room.runner!.seats().length).toBeGreaterThanOrEqual(2);
    for (const s of room.runner!.seats()) expect(room.seats[s]!.occupant).not.toBeNull();
  }
  if (room.phase === 'lobby') expect(room.runner).toBeNull();
  // 房间视图对每个成员都能生成且 you 与角色一致
  for (const t of positions.keys()) {
    const v = room.viewFor(t);
    const role = room.roleOf(t)!;
    if (role.kind === 'seat') expect(v.you).toMatchObject({ role: 'player', seat: role.seat });
    else expect(v.you).toMatchObject({ role: 'spectator', id: role.id });
  }
}

describe('property/lobby', () => {
  it('随机操作序列下大厅不变量始终成立', () => {
    let started = 0;
    fc.assert(
      fc.property(fc.array(cmd, { minLength: 1, maxLength: 60 }), (cmds) => {
        const { room, sched, isClosed } = harness();
        checkInvariants(room);
        for (const c of cmds) {
          if (isClosed()) break;
          const r = run(room, sched, c);
          if (r && (c.k === 'start' || c.k === 'hostStart') && r.ok) {
            started++;
            // 座位上的真人全部离线时开局会立即因 all_away 暂停
            const allAway = room.seats.every((x) => x.occupant?.kind !== 'human' || x.occupant.socketId === null);
            expect(room.phase).toBe(
              allAway && room.seats.some((x) => x.occupant?.kind === 'human') ? 'paused' : 'playing',
            );
            expect(room.seats.filter((s) => s.occupant !== null).length).toBeGreaterThanOrEqual(2);
          }
          if (isClosed()) break;
          checkInvariants(room);
        }
      }),
      { numRuns: 500 },
    );
    // 生成器必须能覆盖开局之后的路径
    expect(started).toBeGreaterThanOrEqual(5);
    // 500 组随机序列单跑约 2.5 秒；与其他 project 并行时会超过默认的 5 秒
  }, 30_000);

  it('开局失败的原因互斥且可解释', () => {
    const { room } = harness();
    expect(room.start('T1')).toMatchObject({ ok: false, error: { code: 'NOT_IN_ROOM' } });
    expect(room.start('T0')).toMatchObject({ ok: false, error: { code: 'NOT_ENOUGH_PLAYERS' } });
    room.join({ tokenHash: 'T1', nickname: 'a', socketId: 's1' }, 'player');
    expect(room.start('T1')).toMatchObject({ ok: false, error: { code: 'NOT_HOST' } });
    expect(room.start('T0')).toMatchObject({ ok: false, error: { code: 'NOT_ALL_READY' } });
    room.setReady('T1', true);
    room.updateSettings('T0', { game: { mapId: 'test-allkinds' } });
    expect(room.seats[1]!.occupant).toMatchObject({ ready: false });
    room.setReady('T1', true);
    expect(room.start('T0')).toEqual({ ok: true });
    expect(room.seats.map((s) => s.characterId).filter((c) => c !== null)).toHaveLength(2);
  });
});
