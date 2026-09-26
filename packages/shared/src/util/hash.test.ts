import { describe, expect, it } from 'vitest';
import { canonicalJson } from './canonicalJson';
import { fmix32, fnv1a32, fnv1a32Hex, fnv1a64, mix32, splitmix32, splitmix32Mix } from './hash';
import { seedFromU32, xoshiroNext32 } from './rng/xoshiro';
import { sha256, sha256Hex } from './sha256';
import { utf8Encode } from './utf8';

// 只在测试里用 Node 做对拍；用动态导入 + 最小类型，避免把 @types/node 引入 shared 的类型检查
interface NodeHash {
  update(data: Uint8Array | string): NodeHash;
  digest(): Uint8Array;
  digest(encoding: 'hex'): string;
}
const { createHash } = (await import(/* @vite-ignore */ 'node:crypto' as string)) as {
  createHash(algorithm: 'sha256'): NodeHash;
};
const { Buffer } = (await import(/* @vite-ignore */ 'node:buffer' as string)) as {
  Buffer: { from(s: string, encoding: 'utf8'): Uint8Array };
};

function randomBytes(seed: number, len: number): Uint8Array {
  const s = seedFromU32(seed);
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = xoshiroNext32(s) >>> 24;
  return out;
}

describe('fnv1a', () => {
  it('32 位公开向量', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
    expect(fnv1a32Hex('a')).toBe('e40c292c');
  });
  it('64 位公开向量', () => {
    expect(fnv1a64('')).toBe('cbf29ce484222325');
    expect(fnv1a64('a')).toBe('af63dc4c8601ec8c');
    expect(fnv1a64('foobar')).toBe('85944171f73967e8');
  });
  it('字符串按 UTF-8 编码后计算', () => {
    expect(fnv1a32('大富翁')).toBe(fnv1a32(utf8Encode('大富翁')));
    expect(fnv1a64('大富翁')).toBe(fnv1a64(Uint8Array.from(Buffer.from('大富翁', 'utf8'))));
  });
});

describe('utf8Encode', () => {
  it('与 Node Buffer 一致（含代理对与孤立代理）', () => {
    const cases = ['', 'abc', '台灣', '測試地圖（全類型）', '😀x', 'a\ud800b', '\udc00', 'é€\u0000'];
    for (const s of cases) expect(Array.from(utf8Encode(s))).toEqual(Array.from(Buffer.from(s, 'utf8')));
  });
});

describe('sha256', () => {
  it('公开向量', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('与 node:crypto 对拍（0..300 字节逐个长度 + 大块）', () => {
    for (let len = 0; len <= 300; len++) {
      const buf = randomBytes(len + 1, len);
      expect(sha256Hex(buf)).toBe(createHash('sha256').update(buf).digest('hex'));
    }
    const big = randomBytes(99, 200_000);
    expect(sha256Hex(big)).toBe(createHash('sha256').update(big).digest('hex'));
    expect(Array.from(sha256(big))).toEqual(Array.from(createHash('sha256').update(big).digest()));
  });
  it('字符串输入按 UTF-8 与 node:crypto 一致', () => {
    const s = canonicalJson({ b: '測試', a: [1, 2.5, null], c: { z: true } });
    expect(sha256Hex(s)).toBe(createHash('sha256').update(s).digest('hex'));
  });
});

describe('mix32 / splitmix32', () => {
  it('fmix32 与 splitmix32Mix 在样本上无碰撞（双射）', () => {
    const a = new Set<number>();
    const b = new Set<number>();
    for (let i = 0; i < 20000; i++) {
      a.add(fmix32(i));
      b.add(splitmix32Mix(i * 7919));
    }
    expect(a.size).toBe(20000);
    expect(b.size).toBe(20000);
    expect(fmix32(0)).toBe(0);
  });
  it('mix32 确定、顺序敏感、单参数等于 fmix32', () => {
    expect(mix32(12345)).toBe(fmix32(12345));
    expect(mix32(1, 2, 3)).toBe(mix32(1, 2, 3));
    expect(mix32(1, 2, 3)).not.toBe(mix32(1, 3, 2));
    expect(mix32(1, 2)).not.toBe(mix32(2, 1));
    expect(mix32(7, -1)).toBe(mix32(7, 0xffffffff));
    const v = mix32(0xdeadbeef, 3, fnv1a32('d17'));
    expect(Number.isInteger(v) && v >= 0 && v <= 0xffffffff).toBe(true);
  });
  it('splitmix32 展开的 golden', () => {
    expect(splitmix32(0, 4)).toEqual([0x64625032, 0xd9c0799c, 0xaf362e10, 0x7fa88912]);
    // 独立参照：常见的闭包写法
    const ref = (a0: number) => {
      let a = a0 | 0;
      return () => {
        a = (a + 0x9e3779b9) | 0;
        let t = a ^ (a >>> 16);
        t = Math.imul(t, 0x21f0aaad);
        t ^= t >>> 15;
        t = Math.imul(t, 0x735a2d97);
        return (t ^ (t >>> 15)) >>> 0;
      };
    };
    const g = ref(42);
    expect(splitmix32(42, 5)).toEqual([g(), g(), g(), g(), g()]);
    expect(splitmix32(1, 2)[1]).toBe(splitmix32Mix((1 + 2 * 0x9e3779b9) >>> 0));
  });
});

describe('canonicalJson', () => {
  it('键排序、无空白、与 JSON 往返等价', () => {
    const x = { b: 1, a: { d: [3, { y: 1, x: 2 }], c: 'é' }, u: undefined };
    expect(canonicalJson(x)).toBe('{"a":{"c":"é","d":[3,{"x":2,"y":1}]},"b":1}');
    expect(canonicalJson(JSON.parse(JSON.stringify(x)))).toBe(canonicalJson(x));
    expect(canonicalJson([undefined, -0, 1e21, 0.1])).toBe('[null,0,1e+21,0.1]');
  });
  it('拒绝非 JSON 值', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson(new Map())).toThrow(TypeError);
    expect(() => canonicalJson({ a: 1n })).toThrow(TypeError);
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(() => canonicalJson(cyc)).toThrow(TypeError);
  });
  it('共享引用（非循环）允许', () => {
    const shared = { k: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"k":1},"b":{"k":1}}');
  });
});
