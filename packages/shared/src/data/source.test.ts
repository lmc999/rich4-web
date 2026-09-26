import { describe, expect, it } from 'vitest';
import { findUnsourced, hasPrimarySource, isVerifySrc, type Sourced } from './source';

describe('Sourced 约定', () => {
  it('至少 1 个非 verify 来源才算合格', () => {
    const good: Sourced = {
      src: [{ exe: '3.11', va: '0x47fdf2' }, { verify: 'extract:cards[0].price' }],
      confidence: 'high',
    };
    const onlyVerify: Sourced = { src: [{ verify: 'extract:cards[1].price' }], confidence: 'low' };
    const empty: Sourced = { src: [], confidence: 'low' };
    const research: Sourced = { src: [{ research: 'docs/research/g_map.md §2.6' }], confidence: 'medium' };
    expect(hasPrimarySource(good)).toBe(true);
    expect(hasPrimarySource(research)).toBe(true);
    expect(hasPrimarySource(onlyVerify)).toBe(false);
    expect(hasPrimarySource(empty)).toBe(false);
    expect(isVerifySrc({ verify: 'x' })).toBe(true);
    expect(isVerifySrc({ manual: 12 })).toBe(false);
    expect(findUnsourced([good, onlyVerify, research, empty])).toEqual([1, 3]);
  });
});
