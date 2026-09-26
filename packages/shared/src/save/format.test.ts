import { describe, expect, expectTypeOf, it } from 'vitest';
import type { GameState } from '../engine/types/state';
import { isSaveFileV1, SAVE_EXPORT_PREFIX, SAVE_FORMAT, SAVE_SCHEMA_VERSION, type SaveFileV1 } from './format';

describe('存档格式', () => {
  it('常量与识别', () => {
    expect(SAVE_FORMAT).toBe('rich4-save');
    expect(SAVE_SCHEMA_VERSION).toBe(1);
    expect(SAVE_EXPORT_PREFIX).toBe('R4S1');
    expect(isSaveFileV1({ format: 'rich4-save', schemaVersion: 1, game: {} })).toBe(true);
    expect(isSaveFileV1({ format: 'rich4-save', schemaVersion: 2, game: {} })).toBe(false);
    expect(isSaveFileV1(null)).toBe(false);
  });

  it('RoomSettings 与 ChatMessage 以泛型注入', () => {
    type S = SaveFileV1<{ timerPreset: 'off' }, { id: string }>;
    expectTypeOf<S['roomSettings']>().toEqualTypeOf<{ timerPreset: 'off' }>();
    expectTypeOf<S['chatTail']>().toEqualTypeOf<{ id: string }[] | undefined>();
    expectTypeOf<S['game']>().toEqualTypeOf<GameState>();
    expectTypeOf<S['mapRef']>().toEqualTypeOf<{ id: string; mapHash: string }>();
  });
});
