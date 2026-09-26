// 轻量 JS/TS 词法遮罩：把注释（以及可选的字符串内容）替换成空格，保持长度与换行不变，便于正则扫描后按偏移回报行号。
// 不是完整解析器：正则字面量按「前一个有效记号」启发式判定，JSX 文本中的孤立引号最多影响到行尾。

export interface MaskOptions {
  /** true 时保留字符串与模板字面量的原文（check-deps 需要读取模块说明符）；默认 false 全部遮成空格 */
  keepStrings?: boolean;
}

const REGEX_PREFIX_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

const isIdentStart = (c: string): boolean => /[A-Za-z_$\u0080-￿]/.test(c);
const isIdentPart = (c: string): boolean => /[\w$\u0080-￿]/.test(c);

type Prev = { kind: 'none' } | { kind: 'ident'; text: string } | { kind: 'value' } | { kind: 'punct'; ch: string };

export function maskSource(src: string, opts: MaskOptions = {}): string {
  const keep = opts.keepStrings === true;
  const out: string[] = new Array(src.length);
  const n = src.length;
  let i = 0;
  let prev: Prev = { kind: 'none' };
  let braceDepth = 0;
  // 每个元素是进入模板 `${` 时的花括号深度
  const templateStack: number[] = [];

  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) out[k] = src[k] === '\n' || src[k] === '\r' ? src[k]! : ' ';
  };
  const copy = (from: number, to: number): void => {
    for (let k = from; k < to; k++) out[k] = src[k]!;
  };
  const body = keep ? copy : blank;

  // 从模板文本位置 start（反引号之后或 `}` 之后）扫描到下一个 `${` 或结束反引号
  const scanTemplateText = (start: number): number => {
    let k = start;
    while (k < n) {
      const c = src[k]!;
      if (c === '\\') {
        body(k, Math.min(k + 2, n));
        k += 2;
        continue;
      }
      if (c === '`') {
        out[k] = '`';
        prev = { kind: 'value' };
        return k + 1;
      }
      if (c === '$' && src[k + 1] === '{') {
        out[k] = '$';
        out[k + 1] = '{';
        templateStack.push(braceDepth);
        braceDepth++;
        prev = { kind: 'punct', ch: '{' };
        return k + 2;
      }
      body(k, k + 1);
      k++;
    }
    return n;
  };

  const regexAllowed = (): boolean => {
    switch (prev.kind) {
      case 'none':
        return true;
      case 'value':
        return false;
      case 'ident':
        return REGEX_PREFIX_KEYWORDS.has(prev.text);
      case 'punct':
        return prev.ch !== ')' && prev.ch !== ']';
    }
  };

  // 文件头的 shebang
  if (src.startsWith('#!')) {
    const end = src.indexOf('\n');
    blank(0, end === -1 ? n : end);
    i = end === -1 ? n : end;
  }

  while (i < n) {
    const c = src[i]!;
    const d = src[i + 1];

    if (c === '/' && d === '/') {
      let end = src.indexOf('\n', i);
      if (end === -1) end = n;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === '/' && d === '*') {
      let end = src.indexOf('*/', i + 2);
      end = end === -1 ? n : end + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      out[i] = c;
      let k = i + 1;
      while (k < n && src[k] !== c && src[k] !== '\n') {
        if (src[k] === '\\' && k + 1 < n) {
          body(k, k + 2);
          k += 2;
          continue;
        }
        body(k, k + 1);
        k++;
      }
      if (k < n && src[k] === c) {
        out[k] = c;
        k++;
      }
      i = k;
      prev = { kind: 'value' };
      continue;
    }
    if (c === '`') {
      out[i] = '`';
      i = scanTemplateText(i + 1);
      continue;
    }
    if (c === '/' && regexAllowed()) {
      // 正则字面量：内容一律遮蔽，保留分隔符与 flags
      out[i] = '/';
      let k = i + 1;
      let inClass = false;
      while (k < n && src[k] !== '\n') {
        const r = src[k]!;
        if (r === '\\' && k + 1 < n) {
          blank(k, k + 2);
          k += 2;
          continue;
        }
        if (r === '[') inClass = true;
        else if (r === ']') inClass = false;
        else if (r === '/' && !inClass) break;
        blank(k, k + 1);
        k++;
      }
      if (k < n && src[k] === '/') {
        out[k] = '/';
        k++;
        while (k < n && isIdentPart(src[k]!)) {
          out[k] = src[k]!;
          k++;
        }
      }
      i = k;
      prev = { kind: 'value' };
      continue;
    }
    if (isIdentStart(c)) {
      let k = i + 1;
      while (k < n && isIdentPart(src[k]!)) k++;
      copy(i, k);
      prev = { kind: 'ident', text: src.slice(i, k) };
      i = k;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && d !== undefined && /[0-9]/.test(d))) {
      let k = i + 1;
      while (k < n && /[\w.]/.test(src[k]!)) k++;
      copy(i, k);
      prev = { kind: 'value' };
      i = k;
      continue;
    }
    if (c === '{') {
      braceDepth++;
    } else if (c === '}') {
      if (templateStack.length > 0 && templateStack[templateStack.length - 1] === braceDepth - 1) {
        templateStack.pop();
        braceDepth--;
        out[i] = '}';
        i = scanTemplateText(i + 1);
        continue;
      }
      if (braceDepth > 0) braceDepth--;
    }
    out[i] = c;
    if (!/\s/.test(c)) prev = { kind: 'punct', ch: c };
    i++;
  }
  return out.join('');
}

/** 预计算行首偏移，返回把偏移转换为 1 基行列号的函数 */
export function lineLocator(src: string): (offset: number) => { line: number; col: number } {
  const starts: number[] = [0];
  for (let k = 0; k < src.length; k++) if (src[k] === '\n') starts.push(k + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: offset - starts[lo]! + 1 };
  };
}

/** 取某一行的原文（去首尾空白，过长时截断），用于报告 */
export function lineText(src: string, line: number, max = 120): string {
  const text = (src.split('\n')[line - 1] ?? '').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
