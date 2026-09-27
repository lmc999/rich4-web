import { describe, expect, it } from 'vitest';
import {
  buildDistanceTables,
  buildInitialTree,
  emptyLzhufStats,
  initialTreeImage,
  LZHUF_NCHAR,
  LZHUF_ROOT,
  LZHUF_T,
  LZHUF_TREE_IMAGE_BYTES,
  LzhufError,
  lzhufDecompress,
} from '../../src/mkf/lzhuf';
import { encodeLzhufTokens, type LzToken, lzhufCompress, tokenize } from '../helpers/lzhufEncode';

/** 确定性伪随机字节（xorshift32） */
function noise(n: number, seed = 0x1234567): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(LzhufError);
    expect((e as LzhufError).lzhufCode).toBe(code);
    return;
  }
  throw new Error(`应抛 ${code}`);
}

describe('LZHUF 表（按规则生成）', () => {
  const { dlen, dhi } = buildDistanceTables();

  it('距离前缀是完备前缀码：64 个 HI 各一个码字，长度分布 1/3/8/12/24/16', () => {
    const codeOf = new Map<number, { code: number; len: number }>();
    for (let b = 0; b < 256; b++) {
      const len = dlen[b]!;
      expect(len).toBeGreaterThanOrEqual(3);
      expect(len).toBeLessThanOrEqual(8);
      const code = b & ((1 << len) - 1);
      const prev = codeOf.get(dhi[b]!);
      if (prev) expect(prev).toEqual({ code, len });
      else codeOf.set(dhi[b]!, { code, len });
    }
    expect([...codeOf.keys()].sort((a, b) => a - b)).toEqual([...Array(64).keys()]);
    const byLen: Record<number, number> = {};
    for (const { len } of codeOf.values()) byLen[len] = (byLen[len] ?? 0) + 1;
    expect(byLen).toEqual({ 3: 1, 4: 3, 5: 8, 6: 12, 7: 24, 8: 16 });
    // Kraft 等式
    expect([...codeOf.values()].reduce((s, { len }) => s + 2 ** -len, 0)).toBe(1);
    // 同一前缀（低 len 位）的 256 个窥视值都映射到同一 (len, hi)
    for (let b = 0; b < 256; b++) {
      const c = codeOf.get(dhi[b]!)!;
      expect(b & ((1 << c.len) - 1)).toBe(c.code);
    }
  });

  it('规则的几个固定点', () => {
    expect([dlen[0], dhi[0]]).toEqual([8, 63]);
    expect([dlen[0xf0], dhi[0xf0]]).toEqual([8, 48]);
    expect([dlen[7], dhi[7]]).toEqual([3, 0]);
    expect([dlen[3], dhi[3]]).toEqual([4, 3]);
    expect([dlen[13], dhi[13]]).toEqual([4, 1]);
    expect([dlen[1], dhi[1]]).toEqual([5, 11]);
    expect([dlen[0x1e], dhi[0x1e]]).toEqual([5, 4]);
    expect([dlen[2], dhi[2]]).toEqual([6, 23]);
    expect([dlen[4], dhi[4]]).toEqual([7, 47]);
  });

  it('初始树：频率有序、父子一致，序列化为 4492 字节', () => {
    const t = buildInitialTree();
    for (let i = 0; i < LZHUF_ROOT; i++) expect(t.freq[i]!).toBeLessThanOrEqual(t.freq[i + 1]!);
    expect(t.freq[LZHUF_ROOT]).toBe(LZHUF_NCHAR);
    expect(t.freq[LZHUF_T]).toBe(0xffff);
    for (let s = 0; s < LZHUF_NCHAR; s++) expect(t.son[t.prnt[LZHUF_T + s]!]).toBe(LZHUF_T + s);
    for (let j = LZHUF_NCHAR; j < LZHUF_T; j++) {
      const c = t.son[j]!;
      expect(t.freq[j]).toBe(t.freq[c]! + t.freq[c + 1]!);
      expect(t.prnt[c]).toBe(j);
      expect(t.prnt[c + 1]).toBe(j);
    }
    expect(t.prnt[LZHUF_ROOT]).toBe(0);
    const img = initialTreeImage();
    expect(img.length).toBe(LZHUF_TREE_IMAGE_BYTES);
    expect(LZHUF_TREE_IMAGE_BYTES).toBe(4492);
    const dv = new DataView(img.buffer);
    expect(dv.getUint16(0, true)).toBe(1);
    expect(dv.getUint16(LZHUF_T * 2, true)).toBe(0xffff);
    // son[0] = (0+641)·2
    expect(dv.getUint16((LZHUF_T + 1) * 2, true)).toBe(LZHUF_T * 2);
  });
});

describe('LZHUF 解压：合成流往返', () => {
  const cases: [string, Uint8Array][] = [
    ['空', new Uint8Array(0)],
    ['单字节', Uint8Array.of(0x41)],
    ['短文本', text('大富翁4 富甲天下 abcabcabcabc abcabcabc!')],
    ['长游程（重叠回溯 dist=0）', new Uint8Array(1000).fill(7)],
    ['随机不可压', noise(3000)],
    ['结构化', Uint8Array.from({ length: 20000 }, (_, i) => (i * 7) ^ (i >> 5))],
  ];
  for (const [name, data] of cases) {
    it(name, () => {
      const enc = lzhufCompress(data);
      const stats = emptyLzhufStats();
      const out = lzhufDecompress(enc.bytes, data.length, { stats });
      expect(Buffer.from(out).equals(Buffer.from(data))).toBe(true);
      expect(stats.bitsWithEnd).toBe(enc.bits);
      expect(Math.ceil(enc.bits / 8)).toBe(enc.bytes.length);
      expect(stats.literals + stats.matches).toBe(tokenize(data).length);
    });
  }

  it('超过 32768 个符号触发频率减半', () => {
    const data = noise(40000, 99);
    const enc = lzhufCompress(data);
    const stats = emptyLzhufStats();
    const out = lzhufDecompress(enc.bytes, data.length, { stats });
    expect(Buffer.from(out).equals(Buffer.from(data))).toBe(true);
    expect(stats.rescales).toBeGreaterThanOrEqual(1);
  });

  it('最长回溯 67、最远距离 4094；距离码按 DLEN 消耗（短码与长码混合）', () => {
    const base = noise(4200, 5);
    const tokens: LzToken[] = [...base].map((v) => ({ t: 'lit', v }));
    tokens.push({ t: 'match', len: 67, dist: 4094 });
    for (const dist of [0, 1, 63, 64, 255, 256, 767, 768, 1535, 1536, 3071, 3072, 4094]) {
      tokens.push({ t: 'match', len: 3, dist });
    }
    const expected: number[] = [...base];
    for (const t of tokens.slice(base.length)) {
      if (t.t !== 'match') continue;
      let p = expected.length - 1 - t.dist;
      for (let k = 0; k < t.len; k++) expected.push(expected[p++]!);
    }
    const enc = encodeLzhufTokens([...tokens, { t: 'end' }]);
    const out = lzhufDecompress(enc.bytes, expected.length);
    expect([...out]).toEqual(expected);
  });

  it('结束标记可用任意匹配符号', () => {
    const enc = encodeLzhufTokens([
      { t: 'lit', v: 1 },
      { t: 'lit', v: 2 },
      { t: 'end', sym: 320 },
    ]);
    expect([...lzhufDecompress(enc.bytes, 2)]).toEqual([1, 2]);
  });

  it('limit：只解出前缀，不校验结束标记', () => {
    const data = text('SPR\0 then the rest of a long resource body ...');
    const enc = encodeLzhufTokens(tokenize(data)); // 故意不写结束标记
    expect([...lzhufDecompress(enc.bytes, data.length, { limit: 4 })]).toEqual([...data.subarray(0, 4)]);
    expectCode(() => lzhufDecompress(enc.bytes, data.length), 'E_LZHUF_NO_END');
  });

  it('确定性：同输入同输出', () => {
    const data = noise(5000, 3);
    const enc = lzhufCompress(data);
    expect(Buffer.from(lzhufDecompress(enc.bytes, 5000)).equals(Buffer.from(lzhufDecompress(enc.bytes, 5000)))).toBe(
      true,
    );
  });
});

describe('LZHUF 严格校验', () => {
  const data = text('hello hello hello world');

  it('结束标记提前出现 → E_LZHUF_EARLY_END', () => {
    const enc = lzhufCompress(data);
    expectCode(() => lzhufDecompress(enc.bytes, data.length + 5), 'E_LZHUF_EARLY_END');
  });

  it('写满后没有结束标记 → E_LZHUF_NO_END（非严格模式放行）', () => {
    const noEnd = encodeLzhufTokens(tokenize(data));
    expectCode(() => lzhufDecompress(noEnd.bytes, data.length), 'E_LZHUF_NO_END');
    const moreLits = encodeLzhufTokens([...tokenize(data), { t: 'lit', v: 1 }, { t: 'end' }]);
    expectCode(() => lzhufDecompress(moreLits.bytes, data.length), 'E_LZHUF_NO_END');
    const moreMatch = encodeLzhufTokens([...tokenize(data), { t: 'match', len: 3, dist: 0 }, { t: 'end' }]);
    expectCode(() => lzhufDecompress(moreMatch.bytes, data.length), 'E_LZHUF_NO_END');
    expect(Buffer.from(lzhufDecompress(noEnd.bytes, data.length, { strict: false })).equals(Buffer.from(data))).toBe(
      true,
    );
  });

  it('源数据多出字节 → E_LZHUF_STORED_MISMATCH', () => {
    const enc = lzhufCompress(data);
    const padded = new Uint8Array(enc.bytes.length + 1);
    padded.set(enc.bytes);
    expectCode(() => lzhufDecompress(padded, data.length), 'E_LZHUF_STORED_MISMATCH');
    expect(Buffer.from(lzhufDecompress(padded, data.length, { strict: false })).equals(Buffer.from(data))).toBe(true);
  });

  it('回溯越过输出起点 → E_LZHUF_BACKREF', () => {
    const enc = encodeLzhufTokens([{ t: 'lit', v: 1 }, { t: 'match', len: 3, dist: 1 }, { t: 'end' }]);
    expectCode(() => lzhufDecompress(enc.bytes, 4), 'E_LZHUF_BACKREF');
  });

  it('回溯越过输出末尾 → E_LZHUF_OUTPUT_OVERRUN（非严格模式截断）', () => {
    const enc = encodeLzhufTokens([{ t: 'lit', v: 9 }, { t: 'match', len: 5, dist: 0 }, { t: 'end' }]);
    expectCode(() => lzhufDecompress(enc.bytes, 4), 'E_LZHUF_OUTPUT_OVERRUN');
    expect([...lzhufDecompress(enc.bytes, 4, { strict: false })]).toEqual([9, 9, 9, 9]);
  });

  it('源数据截断 → E_LZHUF_SRC_OVERRUN', () => {
    const big = noise(500, 11);
    const enc = lzhufCompress(big);
    expectCode(() => lzhufDecompress(enc.bytes.subarray(0, enc.bytes.length >> 1), big.length), 'E_LZHUF_SRC_OVERRUN');
    // 距离码读到一半截断：符号完整，DLEN+6 位不完整
    const m = encodeLzhufTokens([
      { t: 'lit', v: 1 },
      { t: 'lit', v: 2 },
      { t: 'match', len: 3, dist: 1 },
    ]);
    const cut = m.bytes.subarray(0, Math.floor((m.bits - 1) / 8));
    expect(() => lzhufDecompress(cut, 5)).toThrow(new RegExp(`E_LZHUF_SRC_OVERRUN: .*需要比特 ${m.bits} `));
  });

  it('参数非法 → E_LZHUF_ARGS', () => {
    expectCode(() => lzhufDecompress(new Uint8Array(1), -1), 'E_LZHUF_ARGS');
    expectCode(() => lzhufDecompress(new Uint8Array(1), 1.5), 'E_LZHUF_ARGS');
  });

  it('错误是 ExtractError：message 以 code 开头', () => {
    try {
      lzhufDecompress(new Uint8Array(0), 10);
    } catch (e) {
      expect((e as Error).message).toMatch(/^E_LZHUF_SRC_OVERRUN: /);
      return;
    }
    throw new Error('应抛错');
  });
});
