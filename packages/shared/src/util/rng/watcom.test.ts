import { describe, expect, it } from 'vitest';
import {
  createWatcomState,
  WATCOM_DEFAULT_SEED,
  WatcomRng,
  type WatcomState,
  watcomInt,
  watcomRand,
  watcomScale,
  watcomSrand,
} from './watcom';

/** 按公式用 BigInt 手算：next = next·1103515245 + 12345 (mod 2^32)，取 (next >> 16) & 0x7fff */
function refSeq(seed: number, n: number): number[] {
  let next = BigInt(seed);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    next = (next * 0x41c64e6dn + 0x3039n) % 0x100000000n;
    out.push(Number((next >> 16n) & 0x7fffn));
  }
  return out;
}

describe('Watcom rand', () => {
  it('种子 1 的 golden 序列', () => {
    const s = createWatcomState();
    expect(s.next).toBe(WATCOM_DEFAULT_SEED);
    const got = Array.from({ length: 12 }, () => watcomRand(s));
    // 首项手算：1·1103515245 + 12345 = 1103527590 = 0x41C67EA6，>>16 = 0x41C6 = 16838
    expect(got[0]).toBe(16838);
    expect(got).toEqual([16838, 5758, 10113, 17515, 31051, 5627, 23010, 7419, 16212, 4086, 2749, 12767]);
    expect(got).toEqual(refSeq(1, 12));
  });

  it('任意种子与公式一致', () => {
    for (const seed of [0, 2, 12345, 0x7fffffff, 0xffffffff]) {
      const s = createWatcomState(seed);
      expect(Array.from({ length: 50 }, () => watcomRand(s))).toEqual(refSeq(seed, 50));
    }
  });

  it('srand、int、scale', () => {
    const s = createWatcomState(99);
    watcomSrand(s, 1);
    expect(watcomRand(s)).toBe(16838);
    const a = createWatcomState(5);
    const b = createWatcomState(5);
    for (let i = 0; i < 200; i++) {
      const r = watcomRand(a);
      expect(watcomInt(b, 20)).toBe(r % 20);
    }
    const c = createWatcomState(5);
    const d = createWatcomState(5);
    expect(watcomScale(c, 1000)).toBe((watcomRand(d) * 1000) >> 15);
    expect(() => watcomInt(a, 0)).toThrow(RangeError);
  });

  it('状态经 JSON 往返后序列不变', () => {
    const rng = WatcomRng.fromSeed(424242);
    for (let i = 0; i < 17; i++) rng.rand15();
    const saved = JSON.parse(JSON.stringify(rng.state)) as WatcomState;
    const copy = new WatcomRng(saved);
    for (let i = 0; i < 100; i++) expect(copy.rand15()).toBe(rng.rand15());
    expect(copy.snapshot()).toEqual(rng.state);
    expect(new WatcomRng().rand15()).toBe(16838);
  });
});
