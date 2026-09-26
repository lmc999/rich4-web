import { afterEach, describe, expect, it } from 'vitest';
import { checkSource, isScannedFile, scan } from '../check-determinism';
import { makeTempRepo, runScript } from './helpers';

const rulesOf = (src: string): string[] => checkSource('x.ts', src).map((f) => f.rule);

describe('checkSource', () => {
  it('拦截 Math.random 并报告行列号', () => {
    const f = checkSource('packages/shared/src/engine/a.ts', 'const a = 1;\nconst b = Math.random();\n');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ rule: 'math-random', line: 2, col: 11 });
  });

  it('注释、字符串、正则里的 Math.random 不误报', () => {
    const src = [
      '// Math.random() 禁用',
      '/* new Date() 与 Math.round */',
      "const msg = 'Math.random and Date.now()';",
      'const re = /Math\\.random/;',
      '/** for (const k in obj) */',
    ].join('\n');
    expect(checkSource('x.ts', src)).toEqual([]);
  });

  it('模板字面量的插值表达式照常检查', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 被测源码本身含模板插值
    expect(rulesOf('const s = `seed ${Math.random()}`;')).toEqual(['math-random']);
    expect(rulesOf('const s = `Math.random Date`;')).toEqual([]);
  });

  it('拦截 Date 的各种用法，但不误伤 DateNum、startDate、obj.Date', () => {
    expect(rulesOf('const d = new Date();')).toEqual(['date']);
    expect(rulesOf('const t = Date.now();')).toEqual(['date']);
    expect(rulesOf('function f(d: Date) {}')).toEqual(['date']);
    expect(rulesOf('type X = DateNum; const startDate = 1; o.Date = 2; o?.Date;')).toEqual([]);
  });

  it('拦截超越函数与 Math.round，放行 Math.imul/trunc/sqrt/abs', () => {
    for (const fn of ['sin', 'cos', 'tan', 'pow', 'exp', 'log', 'hypot', 'round', 'atan2', 'log2', 'cbrt']) {
      expect(rulesOf(`x = Math.${fn}(1);`), fn).toEqual(['math-transcendental']);
    }
    expect(rulesOf('x = Math.imul(a, b) + Math.trunc(c) + Math.sqrt(d) + Math.abs(e) + Math.min(1, 2);')).toEqual([]);
  });

  it('拦截绕过写法：Math 别名、动态成员、globalThis', () => {
    expect(rulesOf('const M = Math;')).toEqual(['math-indirect']);
    expect(rulesOf("Math['random']();")).toEqual(['math-indirect']);
    expect(rulesOf('const { random } = Math;')).toEqual(['math-indirect']);
    expect(rulesOf('globalThis.Date.now();')).toEqual(['global-escape']);
  });

  it('拦截 performance、Intl、区域方法、crypto', () => {
    expect(rulesOf('performance.now();')).toEqual(['performance']);
    expect(rulesOf('new Intl.NumberFormat();')).toEqual(['intl']);
    expect(rulesOf('a.localeCompare(b);')).toEqual(['locale']);
    expect(rulesOf('crypto.getRandomValues(buf);')).toEqual(['crypto']);
    expect(rulesOf('const performance = 1; ctx.crypto = 2;')).toEqual([]);
  });

  it('拦截 for…in，放行 for…of 与普通 for', () => {
    expect(rulesOf('for (const k in obj) {}')).toEqual(['for-in']);
    expect(rulesOf('for (k in obj) {}')).toEqual(['for-in']);
    expect(rulesOf("for (const k of Object.keys(obj)) {}\nfor (let i = 0; 'a' in o && i < 3; i++) {}")).toEqual([]);
  });
});

describe('isScannedFile', () => {
  it('只扫描六个确定性目录，排除测试与 testing/', () => {
    expect(isScannedFile('packages/shared/src/engine/core/flow.ts')).toBe(true);
    expect(isScannedFile('packages/shared/src/util/hash.ts')).toBe(true);
    expect(isScannedFile('packages/shared/src/engine/core/flow.test.ts')).toBe(false);
    expect(isScannedFile('packages/shared/src/engine/testing/builders.ts')).toBe(false);
    expect(isScannedFile('packages/shared/src/ai/testing/selfplay.ts')).toBe(false);
    expect(isScannedFile('packages/shared/src/net/protocol.ts')).toBe(false);
    expect(isScannedFile('packages/shared/src/view/project.ts')).toBe(false);
    expect(isScannedFile('packages/shared/src/engine/types/state.d.ts')).toBe(false);
    expect(isScannedFile('apps/server/src/game/GameRunner.ts')).toBe(false);
  });
});

describe('scan（临时仓库）', () => {
  let cleanup = (): void => {};
  afterEach(() => cleanup());

  it('往 engine 目录植入 Math.random 被拦，测试文件与缺失目录不影响', () => {
    const repo = makeTempRepo('det');
    cleanup = repo.cleanup;
    repo.write('packages/shared/src/engine/core/rng.ts', 'export const r = () => Math.random();\n');
    repo.write('packages/shared/src/engine/core/rng.test.ts', 'Math.random();\n');
    repo.write('packages/shared/src/engine/testing/debug.ts', 'Date.now();\n');
    repo.write('packages/shared/src/util/ok.ts', '// Math.random 只出现在注释里\nexport const x = 1;\n');
    repo.write('packages/shared/src/net/clock.ts', 'Date.now();\n');
    const { files, findings } = scan(repo.root);
    expect(files).toEqual(['packages/shared/src/engine/core/rng.ts', 'packages/shared/src/util/ok.ts']);
    expect(findings.map((f) => `${f.file}:${f.line}:${f.rule}`)).toEqual([
      'packages/shared/src/engine/core/rng.ts:1:math-random',
    ]);
  });

  it('CLI：违规退出 1，干净退出 0', () => {
    const repo = makeTempRepo('det-cli');
    cleanup = repo.cleanup;
    repo.write('packages/shared/src/minigames/sim.ts', 'export const a = 1;\n');
    expect(runScript('check-determinism.ts', repo.root).code).toBe(0);
    repo.write('packages/shared/src/minigames/sim.ts', 'export const a = Math.round(1.5);\n');
    const bad = runScript('check-determinism.ts', repo.root);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('packages/shared/src/minigames/sim.ts:1:');
  });
});
