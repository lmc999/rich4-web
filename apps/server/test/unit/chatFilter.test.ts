import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitizeChatText } from '@rich4/shared/net';
import { describe, expect, it } from 'vitest';
import {
  createBadWordFilter,
  escapeRe,
  identityFilter,
  loadBadWordFilter,
  parseBadWords,
} from '../../src/rooms/chatFilter';

describe('敏感词过滤', () => {
  it('解析词表：去空行、注释、重复', () => {
    expect(parseBadWords('# 注释\n坏蛋\n\n  笨蛋 \r\n坏蛋\nFoo\n')).toEqual(['坏蛋', '笨蛋', 'Foo']);
  });

  it('按字替换为 *；英文不区分大小写；长词优先；正则元字符按字面匹配', () => {
    const f = createBadWordFilter(['坏蛋', '大坏蛋', 'foo', 'a.b', '𠮷']);
    expect(f('你这个大坏蛋！')).toBe('你这个***！');
    expect(f('坏蛋坏蛋')).toBe('****');
    expect(f('FOO and Foo')).toBe('*** and ***');
    expect(f('axb a.b')).toBe('axb ***');
    expect(f('𠮷野家')).toBe('*野家');
    expect(f('干净的话')).toBe('干净的话');
  });

  it('先清洗再过滤：零宽字符拆开的词也能命中', () => {
    const f = createBadWordFilter(['坏蛋']);
    expect(f(sanitizeChatText('坏​蛋'))).toBe('**');
  });

  it("含 '-' 等字符的词可用（u 模式下 '\\-' 是非法转义，曾让服务器无法启动）", () => {
    const f = createBadWordFilter(parseBadWords('foo\nf-word\nx-rated\na/b\n[x]\n'));
    expect(f('the f-word, X-Rated, a/b and [x] foo')).toBe('the ******, *******, *** and *** ***');
    expect(escapeRe('a-b/c')).toBe('a-b\\/c');
    for (const w of ['f-word', 'a/b', '(x)', '^$', 'a|b', 'a{2}', 'a\\b']) {
      expect(() => new RegExp(escapeRe(w), 'giu')).not.toThrow();
    }
    const d = mkdtempSync(join(tmpdir(), 'rich4-bw-'));
    try {
      writeFileSync(join(d, 'badwords.txt'), 'f-word\n坏蛋\n');
      const { filter, count, skipped } = loadBadWordFilter(join(d, 'badwords.txt'));
      expect({ count, skipped }).toEqual({ count: 2, skipped: [] });
      expect(filter('f-word 坏蛋')).toBe('****** **');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('不可见格式字符插在词中间也能命中（软连字符、CGJ、变体选择符、tag 字符、Hangul 填充符）', () => {
    const f = createBadWordFilter(['badword', '坏话']);
    const cases = [
      'bad\u00ADword',
      'bad\u034Fword',
      'bad\uFE0Fword',
      '坏\u00AD话',
      'bad\u{E0020}word',
      'bad\u3164word',
      'bad\u115Fword',
      'bad\u180Eword',
    ];
    for (const raw of cases)
      expect(f(sanitizeChatText(raw)), JSON.stringify(raw)).toBe(raw.startsWith('坏') ? '**' : '*******');
    // 词外的不可见字符原样保留（emoji 的变体选择符）
    expect(f(sanitizeChatText('好\u2764\uFE0F badword'))).toBe('好\u2764\uFE0F *******');
    expect(f('clean\uFE0F text')).toBe('clean\uFE0F text');
  });

  it('空词表与缺失文件为恒等过滤', () => {
    expect(createBadWordFilter([])).toBe(identityFilter);
    expect(loadBadWordFilter('/nonexistent/badwords.txt')).toEqual({ filter: identityFilter, count: 0, skipped: [] });
    const d = mkdtempSync(join(tmpdir(), 'rich4-bw-'));
    try {
      writeFileSync(join(d, 'badwords.txt'), '笨蛋\n');
      const { filter, count } = loadBadWordFilter(join(d, 'badwords.txt'));
      expect(count).toBe(1);
      expect(filter('笨蛋你好')).toBe('**你好');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
