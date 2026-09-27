// zh-TW 语言包管线的核心（纯函数；opencc 由调用方注入）：scripts/gen-zh-tw.ts 用 opencc-js 的 cn → twp
// （简体 → 台湾正体，含台湾惯用词）把 locales/zh-CN/*.json 转成 locales/zh-TW/*.json 并入库；
// 转换时保护插值占位符 {{x}}，转换后先套「词汇覆盖表」修正台湾用语差异，再套「键覆盖表」逐条改写。
// 生成物是我们自己文案的繁体转换，可以入库（original-skin.md U5：原版皮肤下界面文字一律繁体）。

export type TextConverter = (s: string) => string;

/**
 * 词汇覆盖表（按顺序替换，作用于 opencc 输出）：处理 opencc twp 的用字与台湾游戏界面常用说法的差异。
 * 左边是 opencc 的输出，右边是期望的写法。
 */
export const ZH_TW_PHRASES: readonly (readonly [string, string])[] = [
  ['臺灣', '台灣'],
  ['臺北', '台北'],
  ['臺中', '台中'],
  ['臺南', '台南'],
  ['賬號', '帳號'],
  ['賬戶', '帳戶'],
  ['聯機', '連線'],
  ['二維碼', 'QR 碼'],
  ['質量', '品質'],
  // twp 把「类型」「参数」换成程序术语「型別」「引數」，界面文案用一般说法
  ['型別', '類型'],
  ['引數', '參數'],
  // 「访问口令」：台湾说法是「通關密語」
  ['訪問口令', '通關密語'],
  ['訪問憑據', '通行憑證'],
  ['口令', '密語'],
  // 音频设置：台湾惯用「台詞」「背景」（切到后台 = 程序进入背景）
  ['臺詞', '台詞'],
  ['切到後臺', '切到背景'],
];

/** 键覆盖表：`<命名空间>:<键路径>` → 整条文案（opencc 与词汇表都处理不好的个别条目） */
export const ZH_TW_KEY_OVERRIDES: Readonly<Record<string, string>> = {};

/** 插值占位符（{{x}}、{{x, format}}） */
const PLACEHOLDER_RE = /(\{\{[^{}]*\}\})/g;

/** 转换一条文案：占位符原样保留，其余部分 opencc 转换后套词汇覆盖表 */
export function convertText(s: string, convert: TextConverter): string {
  const parts = s.split(PLACEHOLDER_RE);
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    out += i % 2 === 1 ? p : applyPhrases(convert(p));
  }
  return out;
}

export function applyPhrases(s: string): string {
  let out = s;
  for (const [from, to] of ZH_TW_PHRASES) out = out.split(from).join(to);
  return out;
}

export type JsonTree = string | { [k: string]: JsonTree };

/** 转换一个命名空间：保持键与结构不变；键覆盖表优先 */
export function convertBundle(
  ns: string,
  bundle: JsonTree,
  convert: TextConverter,
  overrides: Readonly<Record<string, string>> = ZH_TW_KEY_OVERRIDES,
  prefix = '',
): JsonTree {
  if (typeof bundle === 'string') {
    const key = `${ns}:${prefix}`;
    return Object.hasOwn(overrides, key) ? overrides[key]! : convertText(bundle, convert);
  }
  const out: { [k: string]: JsonTree } = {};
  for (const [k, v] of Object.entries(bundle)) {
    out[k] = convertBundle(ns, v, convert, overrides, prefix ? `${prefix}.${k}` : k);
  }
  return out;
}

/** 递归列出叶子（键路径, 值） */
export function leafEntries(obj: unknown, prefix = ''): [string, unknown][] {
  if (obj === null || typeof obj !== 'object') return [[prefix, obj]];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    leafEntries(v, prefix ? `${prefix}.${k}` : k),
  );
}

/** 文案里的占位符（排序后），用于核对两种语言的插值一致 */
export function placeholdersOf(s: string): string[] {
  return (s.match(PLACEHOLDER_RE) ?? []).slice().sort();
}

/** 生成物的文件格式：2 空格缩进 + 结尾换行（与 zh-CN 源文件一致） */
export function formatLocaleJson(tree: JsonTree): string {
  return `${JSON.stringify(tree, null, 2)}\n`;
}
