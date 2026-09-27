/** 需要用户正版文件（original/）；文件不存在时整组 skip。只读原版文件，不写任何文件。 */
import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { countBit15 } from '../../src/gfx/rgb555';
import { hashHex } from '../../src/io/hash';
import { MkfArchive } from '../../src/mkf/container';
import { buildDistanceTables, emptyLzhufStats, initialTreeImage, lzhufDecompress } from '../../src/mkf/lzhuf';
import { offsetToVa, parsePe } from '../../src/pe/pe';
import { ORIGINAL_MKFS, originalAvailable, readOriginal, researchPath } from '../helpers/originalMkf';

function findAll(hay: Uint8Array, needle: Uint8Array): number[] {
  const h = Buffer.from(hay.buffer, hay.byteOffset, hay.byteLength);
  const n = Buffer.from(needle.buffer, needle.byteOffset, needle.byteLength);
  const out: number[] = [];
  for (let i = h.indexOf(n); i >= 0; i = h.indexOf(n, i + 1)) out.push(i);
  return out;
}

const EXES = [
  { rel: 'Game/rich4.exe', va: { dhi: 0x480710, dlen: 0x480810, tree: 0x480910 } },
  { rel: 'MultiverseJourney/rich4.exe', va: { dhi: 0x483430, dlen: 0x483530, tree: 0x483630 } },
] as const;

describe.skipIf(!originalAvailable([EXES[0].rel]))('LZHUF 表与用户自有 exe 逐字节核对', () => {
  const { dhi, dlen } = buildDistanceTables();
  const tree = initialTreeImage();
  for (const exe of EXES) {
    it.skipIf(!originalAvailable([exe.rel]))(`${exe.rel}：DHI/DLEN/初始树各只命中一处`, async () => {
      const bytes = await readOriginal(exe.rel);
      const pe = parsePe(bytes, exe.rel);
      const hits = {
        dhi: findAll(bytes, dhi).map((o) => offsetToVa(pe, o)),
        dlen: findAll(bytes, dlen).map((o) => offsetToVa(pe, o)),
        tree: findAll(bytes, tree).map((o) => offsetToVa(pe, o)),
      };
      expect(hits).toEqual({ dhi: [exe.va.dhi], dlen: [exe.va.dlen], tree: [exe.va.tree] });
    });
  }
});

/** radare2 ESIL 仿真 v2.06 原版解压函数（VA 0x4536a0）得到的结果（containers.md §verified，emu/results.txt） */
const EMU_SAMPLES = [
  { rel: 'Game/Panel.mkf', index: 13, raw: 5298, sha1: '081ff734c2b5fa395d7f52499824118d4597eeff' },
  { rel: 'Game/map.mkf', index: 14, raw: 39601, sha1: 'fbb4d6182c597187514d6acffc07fac9e948b46c' },
  { rel: 'Game/Panel.mkf', index: 90, raw: 2226, sha1: '7d9547d0e3c2492a1958b510c9cde742dde9a1df' },
  { rel: 'Game/Panel.mkf', index: 72, raw: 38696, sha1: '56cc66b36c92ad52d7331c375a456280096aa022' },
  { rel: 'Game/Data.mkf', index: 481, raw: 82412, sha1: 'b6237fdd258ca0d320b1633a571778239328167b' },
  { rel: 'Game/Data.mkf', index: 468, raw: 194776, sha1: '408147700a8c69105b54c2f9eddc2d78aca2384e' },
] as const;

describe.skipIf(!originalAvailable(ORIGINAL_MKFS.map((m) => m.rel)))('9 个 MKF 全量解析与严格解压（本机）', () => {
  const files = new Map<string, Uint8Array>();
  const archives = new Map<string, MkfArchive>();
  let openMs = 0;

  beforeAll(async () => {
    for (const m of ORIGINAL_MKFS) files.set(m.rel, await readOriginal(m.rel));
    const t0 = performance.now();
    for (const m of ORIGINAL_MKFS) archives.set(m.rel, MkfArchive.open(files.get(m.rel)!, m.rel));
    openMs = performance.now() - t0;
  }, 60_000);

  it('共 2782 个资源；每个文件的资源数、压缩数、kind 计数与 containers.md 一致；无哨兵、无空隙', () => {
    let total = 0;
    let compressed = 0;
    for (const m of ORIGINAL_MKFS) {
      const a = archives.get(m.rel)!;
      const kinds: Record<string, number> = {};
      for (const e of a.entries()) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
      expect({ rel: m.rel, count: a.count, compressed: a.entries().filter((e) => e.compressed).length, kinds }).toEqual(
        {
          rel: m.rel,
          count: m.count,
          compressed: m.compressed,
          kinds: m.kinds,
        },
      );
      expect(a.hasSentinel).toBe(false);
      expect(a.warnings).toEqual([]);
      total += a.count;
      compressed += m.compressed;
    }
    expect(total).toBe(2782);
    expect(compressed).toBe(440);
  });

  it('440 个压缩资源全部严格解压：写满后是结束标记、ceil(bits/8)==stored；像素区 bit15 全为 0；解析+解压 < 5 秒', () => {
    const t0 = performance.now();
    let n = 0;
    let rescales = 0;
    let literals = 0;
    let matches = 0;
    let words = 0;
    let bit15 = 0;
    for (const m of ORIGINAL_MKFS) {
      const a = archives.get(m.rel)!;
      for (const e of a.entries()) {
        const data = a.read(e.index);
        expect(data.length).toBe(e.rawSize);
        if (e.imageSize > 0) {
          words += e.imageSize >> 1;
          bit15 += countBit15(data, e.imageOffset, e.imageSize >> 1);
        }
        if (!e.compressed) continue;
        n++;
        const stats = emptyLzhufStats();
        lzhufDecompress(a.readStored(e.index), e.rawSize, { stats });
        expect(Math.ceil(stats.bitsWithEnd! / 8), `${m.rel}#${e.index}`).toBe(e.storedSize);
        rescales += stats.rescales;
        literals += stats.literals;
        matches += stats.matches;
      }
    }
    const ms = performance.now() - t0;
    expect(n).toBe(440);
    // containers.md §2：共 14,760,934 个字面量、8,245,848 次回溯、902 次频率减半
    expect({ literals, matches, rescales }).toEqual({ literals: 14_760_934, matches: 8_245_848, rescales: 902 });
    expect(words).toBeGreaterThan(30_000_000);
    expect(bit15).toBe(0);
    // 解析 + 全部压缩资源解压（上面每个压缩资源解了两次，这里只按一次计）
    const once = openMs + ms / 2;
    expect(once, `open ${openMs.toFixed(0)}ms + 解压 ${(ms / 2).toFixed(0)}ms`).toBeLessThan(5000);
  }, 120_000);

  it('抽检：6 个资源的输出 sha1 与 radare2 ESIL 仿真原版解压函数的结果一致', () => {
    for (const s of EMU_SAMPLES) {
      const a = archives.get(s.rel)!;
      const e = a.entry(s.index);
      expect(e.compressed).toBe(true);
      expect(e.rawSize).toBe(s.raw);
      expect(hashHex(a.read(s.index), 'sha1'), `${s.rel}#${s.index}`).toBe(s.sha1);
    }
  });

  it.skipIf(!existsSync(researchPath('emu', 'results.txt')))('emu/results.txt 的 IDENTICAL 行全部复现', () => {
    const lines = readFileSync(researchPath('emu', 'results.txt'), 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('IDENTICAL '));
    expect(lines.length).toBeGreaterThanOrEqual(6);
    for (const l of lines) {
      const m = /^IDENTICAL (Game|MultiverseJourney)_(.+)_(mkf|MKF)_(\d+) raw=(\d+) sha1=([0-9a-f]{40})/.exec(l);
      expect(m, l).not.toBeNull();
      const rel = `${m![1]}/${m![2]}.${m![3]}`;
      const a = archives.get(rel)!;
      const data = a.read(Number(m![4]));
      expect(data.length).toBe(Number(m![5]));
      expect(hashHex(data, 'sha1'), l).toBe(m![6]);
    }
  });
});
