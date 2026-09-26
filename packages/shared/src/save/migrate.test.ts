import { describe, expect, it } from 'vitest';
import { SAVE_SCHEMA_VERSION, type SaveFile } from './format';
import { checkSaveCompat, migrateSave, SAVE_MIGRATIONS, SaveFormatError } from './migrate';

const HASH = 'a'.repeat(64);

function sample(): Record<string, unknown> {
  return {
    format: 'rich4-save',
    schemaVersion: 1,
    engineVersion: '0.1.0',
    stateVersion: 1,
    mapRef: { id: 'test', mapHash: 'm1' },
    tablesHash: 't1',
    savedAt: 1_700_000_000_000,
    name: '存档',
    meta: {
      mapId: 'test',
      gameDay: 3,
      date: 19980104,
      seats: [
        { characterId: 0, nickname: 'A', kind: 'human' },
        { characterId: 1, nickname: 'AI2', kind: 'ai' },
      ],
    },
    roomSettings: { anything: true },
    seats: [
      { index: 0, characterId: 0, nickname: 'A', kind: 'human', ownerTokenHash: HASH },
      { index: 1, characterId: 1, nickname: 'AI2', kind: 'ai', ai: { preset: 'normal' } },
    ],
    game: { v: 1 },
    chatTail: [],
  };
}

function reason(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof SaveFormatError) return e.reason;
    throw e;
  }
  return 'ok';
}

describe('migrateSave', () => {
  it('v1 原样通过校验', () => {
    const s = migrateSave(sample());
    expect(s.schemaVersion).toBe(SAVE_SCHEMA_VERSION);
    expect(s.seats[1]!.ai).toEqual({ preset: 'normal' });
    expect(Object.keys(SAVE_MIGRATIONS)).toEqual([]);
  });

  it('格式错误、未来版本、座位与角色重复、字段越界都拒绝', () => {
    expect(reason(() => migrateSave(null))).toBe('badFormat');
    expect(reason(() => migrateSave({ ...sample(), format: 'x' }))).toBe('badFormat');
    expect(reason(() => migrateSave({ ...sample(), schemaVersion: 0 }))).toBe('badFormat');
    expect(reason(() => migrateSave({ ...sample(), schemaVersion: 2 }))).toBe('newerFormat');
    expect(reason(() => migrateSave({ ...sample(), extra: 1 }))).toBe('badFormat');
    const dupSeat = sample();
    (dupSeat.seats as { index: number }[])[1]!.index = 0;
    expect(reason(() => migrateSave(dupSeat))).toBe('badFormat');
    const dupChar = sample();
    (dupChar.seats as { characterId: number }[])[1]!.characterId = 0;
    expect(reason(() => migrateSave(dupChar))).toBe('badFormat');
    const badOwner = sample();
    (badOwner.seats as { ownerTokenHash?: string }[])[0]!.ownerTokenHash = 'nothex';
    expect(reason(() => migrateSave(badOwner))).toBe('badFormat');
    expect(reason(() => migrateSave({ ...sample(), game: [] }))).toBe('badFormat');
    expect(reason(() => migrateSave({ ...sample(), mapRef: { id: 'other', mapHash: 'm1' } }))).toBe('badFormat');
  });
});

describe('checkSaveCompat', () => {
  const save = migrateSave(sample()) as SaveFile;
  const env = { stateVersion: 1, hasMap: (id: string, h: string) => id === 'test' && h === 'm1', tablesHash: 't1' };

  it('完全一致且已签名：无警告', () => {
    expect(checkSaveCompat(save, { ...env, verified: true })).toEqual({ ok: true, warnings: [] });
  });

  it('tablesHash 不符、未签名、需要迁移只告警', () => {
    expect(checkSaveCompat(save, { ...env, stateVersion: 2, tablesHash: 't2', verified: false })).toEqual({
      ok: true,
      warnings: ['needsMigration', 'tablesHashMismatch', 'unsigned'],
    });
  });

  it('mapHash 不符、state 更新：不兼容', () => {
    expect(checkSaveCompat(save, { ...env, hasMap: () => false, verified: true })).toEqual({
      ok: false,
      reason: 'mapHashMismatch',
    });
    expect(checkSaveCompat({ ...save, stateVersion: 9 }, { ...env, verified: true })).toEqual({
      ok: false,
      reason: 'newerState',
    });
  });
});
