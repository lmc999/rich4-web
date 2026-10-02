import { describe, expect, it } from 'vitest';
import { DEFAULT_ROOM_SETTINGS, effectiveHandVisibility, PRIVATE_HAND_MIN_HUMAN_SEATS } from './room';

describe('effectiveHandVisibility（开局锁定的手牌可见性）', () => {
  it('默认公开（原版同屏）；≥ 2 名真人的联机对局一律私密；只会从公开改为私密', () => {
    expect(DEFAULT_ROOM_SETTINGS.handVisibility).toBe('public');
    expect(PRIVATE_HAND_MIN_HUMAN_SEATS).toBe(2);
    expect(effectiveHandVisibility('public', 0)).toBe('public');
    expect(effectiveHandVisibility('public', 1)).toBe('public');
    expect(effectiveHandVisibility('public', 2)).toBe('private');
    expect(effectiveHandVisibility('public', 4)).toBe('private');
    expect(effectiveHandVisibility('private', 1)).toBe('private');
  });
});
