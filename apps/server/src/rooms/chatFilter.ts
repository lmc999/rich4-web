/**
 * 聊天敏感词过滤（design/net.md §9）：可配置词表 DATA_DIR/badwords.txt（每行一个词，# 开头为注释），
 * 命中的部分按字替换为 *。匹配前双方都做 NFC；英文不区分大小写（正则 iu）。文本清洗（NFC、去控制与零宽字符、
 * 截断）在 shared/net 的 sanitizeChatText，先清洗后过滤。
 *
 * 清洗只去掉「从不需要」的不可见字符；变体选择符（emoji 需要）、tag 字符（旗帜子区域）等保留在显示文本里，
 * 过滤时另生成一份去掉全部默认可忽略码点（Default_Ignorable_Code_Point）的比对串，命中范围映射回原文：
 * 可见字替换为 *，夹在中间的不可见字符一并删掉。这样「bad<U+00AD>word」「坏<U+FE0F>话」也能命中。
 */
import { readFileSync } from 'node:fs';

export type ChatFilter = (text: string) => string;

export const identityFilter: ChatFilter = (t) => t;

/** 默认可忽略码点：显示时不可见，比对时跳过 */
const IGNORABLE_RE = /\p{Default_Ignorable_Code_Point}/u;
const IGNORABLE_ALL_RE = /\p{Default_Ignorable_Code_Point}/gu;

/** 词表文本 → 词（去空行、注释与重复；NFC） */
export function parseBadWords(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const w = line.trim().normalize('NFC');
    if (w === '' || w.startsWith('#')) continue;
    out.add(w);
  }
  return [...out];
}

/**
 * 正则元字符按字面匹配。u 模式下只有语法字符与 '/' 允许转义（'\-' 是非法转义，会让 new RegExp 抛错），
 * '-' 在字符类之外本来就是普通字符，所以不转义。
 */
export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** 由词表构造过滤器；空词表返回恒等函数。个别词构造正则失败时跳过该词（onSkip 回调），不影响其他词 */
export function createBadWordFilter(
  words: readonly string[],
  onSkip?: (word: string, err: unknown) => void,
): ChatFilter {
  const norm = words.map((w) => w.normalize('NFC').replace(IGNORABLE_ALL_RE, '')).filter((w) => w.length > 0);
  const list = [...new Set(norm)].filter((w) => {
    try {
      new RegExp(escapeRe(w), 'iu');
      return true;
    } catch (err) {
      onSkip?.(w, err);
      return false;
    }
  });
  if (list.length === 0) return identityFilter;
  // 长词优先，避免短词先命中把长词拆开
  list.sort((a, b) => Array.from(b).length - Array.from(a).length || (a < b ? -1 : 1));
  const re = new RegExp(list.map(escapeRe).join('|'), 'giu');
  return (text) => {
    const chars = Array.from(text);
    // 比对串：去掉可忽略码点；unitToChar[k] = 比对串第 k 个 UTF-16 单元所属字符在 chars 里的下标
    let skel = '';
    const unitToChar: number[] = [];
    chars.forEach((ch, i) => {
      if (IGNORABLE_RE.test(ch)) return;
      skel += ch;
      for (let k = 0; k < ch.length; k++) unitToChar.push(i);
    });
    let masked: Uint8Array | null = null;
    for (const m of skel.matchAll(re)) {
      if (m[0].length === 0) continue;
      const from = unitToChar[m.index]!;
      const to = unitToChar[m.index + m[0].length - 1]!;
      masked ??= new Uint8Array(chars.length);
      masked.fill(1, from, to + 1);
    }
    if (masked === null) return text;
    let out = '';
    chars.forEach((ch, i) => {
      if (masked[i] !== 1) out += ch;
      else if (!IGNORABLE_RE.test(ch)) out += '*';
    });
    return out;
  };
}

/** 读取词表文件；文件不存在时返回恒等过滤器。skipped 为无法使用而跳过的词（调用方记日志） */
export function loadBadWordFilter(path: string): { filter: ChatFilter; count: number; skipped: string[] } {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return { filter: identityFilter, count: 0, skipped: [] };
    throw err;
  }
  const words = parseBadWords(text);
  const skipped: string[] = [];
  const filter = createBadWordFilter(words, (w) => skipped.push(w));
  return { filter, count: words.length - skipped.length, skipped };
}
