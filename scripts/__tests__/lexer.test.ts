import { describe, expect, it } from 'vitest';
import { lineLocator, maskSource } from '../lib/lexer';

describe('maskSource', () => {
  it('遮蔽行注释与块注释，保持长度和换行', () => {
    const src = 'a = 1; // Math.random()\n/* Date.now()\n */ b = 2;';
    const out = maskSource(src);
    expect(out).toHaveLength(src.length);
    expect(out).not.toContain('Math');
    expect(out).not.toContain('Date');
    expect(out.split('\n')).toHaveLength(3);
    expect(out).toContain('b = 2;');
  });

  it('默认遮蔽字符串内容，keepStrings 时保留', () => {
    const src = `const s = 'Math.random'; const t = "for (k in o)";`;
    expect(maskSource(src)).not.toMatch(/Math|for \(k/);
    expect(maskSource(src, { keepStrings: true })).toBe(src);
  });

  it('字符串里的注释符号不影响后续代码', () => {
    const src = `const u = 'http://x'; Math.random();`;
    expect(maskSource(src)).toContain('Math.random()');
  });

  it('模板字面量：文本遮蔽，插值表达式保留为代码（含嵌套）', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 被测源码本身含模板插值
    const src = 'const s = `Date ${Math.random()} and ${`in ${Date.now()}`} tail`; x();';
    const out = maskSource(src);
    expect(out).toContain('Math.random()');
    expect(out).toContain('Date.now()');
    expect(out.match(/Date/g)).toHaveLength(1);
    expect(out).toContain('x();');
  });

  it('模板表达式中的对象字面量花括号正确配对', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 被测源码本身含模板插值
    const src = 'const s = `${f({ a: 1 })} Date`; Math.random();';
    const out = maskSource(src);
    expect(out).not.toMatch(/\bDate\b/);
    expect(out).toContain('Math.random();');
  });

  it('正则字面量内容被遮蔽，除法不被误判为正则', () => {
    const src = 'const re = /Math.random\\/[/]/g; const q = a / b / c; Date;';
    const out = maskSource(src);
    expect(out).not.toContain('Math');
    expect(out).toContain('a / b / c');
    expect(out).toContain('Date;');
  });

  it('return 之后的 / 视为正则', () => {
    const out = maskSource("function f() { return /'/.test(x); } Date;");
    expect(out).toContain('Date;');
  });
});

describe('lineLocator', () => {
  it('把偏移换算为 1 基行列号', () => {
    const src = 'ab\ncd\n\nef';
    const at = lineLocator(src);
    expect(at(0)).toEqual({ line: 1, col: 1 });
    expect(at(4)).toEqual({ line: 2, col: 2 });
    expect(at(src.indexOf('e'))).toEqual({ line: 4, col: 1 });
  });
});
