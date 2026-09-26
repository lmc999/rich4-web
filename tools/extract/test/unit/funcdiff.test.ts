import { describe, expect, it } from 'vitest';
import { CodeIndex } from '../../src/exe/code';
import {
  buildFuncSeeds,
  type FuncSeed,
  fullToken,
  funcDiff,
  summarizeFuncDiff,
  systemOf,
} from '../../src/exe/funcdiff';
import { stringMapping } from '../../src/exe/insnTransfer';
import { hexVa, PeFile } from '../../src/pe/scan';
import { buildVariant } from '../helpers/buildCodePair';

const ref = buildVariant('ref');
const dst = buildVariant('dst');
const rf = new PeFile(ref.bytes, 'ref');
const df = new PeFile(dst.bytes, 'dst');
const rc = CodeIndex.build(rf);
const dc = CodeIndex.build(df);
const m = stringMapping(rf, df);
const opts = { translate: m.translate, dstStrings: m.targets };
const H = ['H0', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'];

function seeds(): FuncSeed[] {
  return H.map((k) => ({ system: 'news', label: k, v311: ref.va[k]!, v206: dst.va[k]! }));
}

describe('函数级对比（合成的两版）', () => {
  const r = funcDiff(rc, dc, seeds(), { ...opts, depth: 0 });
  const by = Object.fromEntries(r.results.map((x) => [x.label, x]));

  it('栈帧大小、栈上位移不算差异；资源号差 0x29 归表现层；常量差列出', () => {
    expect(by.H0).toMatchObject({ class: 'const', diffs: [], presentation: 1, similarity: 1 });
    expect(by.H1!.class).toBe('const');
    expect(by.H1!.diffs).toEqual([`${hexVa(ref.va.H1_days!)} mov ecx, 0x5 → ${hexVa(dst.va.H1_days!)} mov ecx, 0x7`]);
    expect(by.H2).toMatchObject({ class: 'same', diffs: [], presentation: 0 });
    expect(by.H3!.class).toBe('struct');
    expect(by.H3!.similarity).toBeCloseTo(0.8, 5);
    expect(by.H5!.class).toBe('same');
    expect(r).toMatchObject({ seeds: 7, paired: 7, propagated: 0 });
  });

  it('完整记号：串地址按目标版本比较，其他映像地址记为 A，栈位移记为 D', () => {
    const a = rc.at(ref.va.H5!);
    const b = dc.at(dst.va.H5!);
    expect(fullToken(rc, a, 'ref', m.translate, m.targets)).toBe(fullToken(dc, b, 'dst', m.translate, m.targets));
    expect(fullToken(rc, rc.at(ref.va.H4_ref!), 'ref', m.translate, m.targets)).toBe('mov esi,4[+ebx*4+A]');
  });

  it('扩散：对齐位置上的 call 目标成为新配对（深度受限）', () => {
    const main = funcDiff(rc, dc, [{ system: 'x', label: 'MAIN', v311: ref.va.MAIN!, v206: dst.va.MAIN! }], {
      ...opts,
      depth: 1,
    });
    expect(main.propagated).toBe(7);
    expect(main.results.map((x) => x.label)).toContain(`MAIN → ${hexVa(ref.va.H1!)}`);
    const sum = summarizeFuncDiff(main);
    expect(sum.map((s) => s.system)).toEqual(['x', 'x·callee']);
    expect(sum[1]).toMatchObject({ functions: 7, same: 4, const: 2, struct: 1 });
  });

  it('种子：按表下标配对并互为 stopAt；常量所在函数取最近入口；系统名', () => {
    const ev = (va: Record<string, number>) => ({
      eventTables: {
        newsHandlers: H.slice(0, 3).map((k) => hexVa(va[k]!)),
        fateHandlers: [],
        magicEffectJump: [],
        magicCondJump: [],
        helpers: { print: hexVa(va.PRINT!) },
      },
    });
    const s = buildFuncSeeds(rc, dc, ev(ref.va), ev(dst.va), [
      { id: 'penguin.x', v311: hexVa(ref.va.H4_ref!), v206: hexVa(dst.va.H4_ref!) },
      { id: 'ai.y', v311: hexVa(ref.va.H0_days!), v206: hexVa(dst.va.H0_days!) },
    ]);
    expect(s.map((x) => `${x.system}:${x.label}`)).toEqual([
      'news:newsHandlers[0]',
      'news:newsHandlers[1]',
      'news:newsHandlers[2]',
      'helper:print',
      'minigame:penguin.x 所在函数',
    ]);
    expect(s[0]!.stop311?.has(ref.va.H1!)).toBe(true);
    expect(s[4]).toMatchObject({ v311: ref.va.H4, v206: dst.va.H4 });
    expect(['news.1', 'fate.2', 'magic.3', 'ai.magic.x', 'balloon.a', 'ai.bank', 'bomb.fuse'].map(systemOf)).toEqual([
      'news',
      'fate',
      'magic',
      'magic',
      'minigame',
      'ai',
      'rules',
    ]);
  });
});
