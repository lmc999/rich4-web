// 生成 zh-TW 语言包（原版皮肤 A5；original-skin.md U5：原版皮肤下界面文字一律繁体）：
// 读 apps/client/src/i18n/locales/zh-CN/*.json，用 opencc-js（cn → twp：简体 → 台湾正体并换成台湾惯用词）逐条转换，
// 保护 {{占位符}}，再套 apps/client/src/i18n/zhTw.ts 的词汇覆盖表与键覆盖表，写到 locales/zh-TW/*.json（入库）。
// 生成物是 zh-CN 文案的繁体转换；其中命运 / 新闻（fate / news）的 zh-CN 是原版原文经 opencc 转成的简体（2026-10-03 用户要求
// 用原版短句，architecture §33），转回来与 exe 原文逐字相同（test/fatenews-orig-text.ts 核对）。opencc-js 只在构建期使用
// （tools/extract 的 devDependency，工作区提升到根）。
// 用法：npx tsx scripts/gen-zh-tw.ts [--check]（--check 只比对，不一致时退出码 1）
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Converter } from 'opencc-js/cn2t';
import { convertBundle, formatLocaleJson, type JsonTree } from '../apps/client/src/i18n/zhTw';
import { isMainModule, REPO_ROOT } from './lib/cli';

export const LOCALES_DIR = join(REPO_ROOT, 'apps/client/src/i18n/locales');

/** opencc 转换器：简体 → 台湾正体（含台湾惯用词） */
export function makeConverter(): (s: string) => string {
  return Converter({ from: 'cn', to: 'twp' });
}

/** 生成全部 zh-TW 文件的内容：文件名 → 文本 */
export function generateZhTw(localesDir = LOCALES_DIR): Map<string, string> {
  const convert = makeConverter();
  const src = join(localesDir, 'zh-CN');
  const out = new Map<string, string>();
  for (const f of readdirSync(src)
    .filter((n) => n.endsWith('.json'))
    .sort()) {
    const ns = f.replace(/\.json$/, '').replace(/\.(original|alt)$/, '');
    const tree = JSON.parse(readFileSync(join(src, f), 'utf8')) as JsonTree;
    out.set(f, formatLocaleJson(convertBundle(ns, tree, convert)));
  }
  return out;
}

function main(argv: readonly string[]): number {
  const check = argv.includes('--check');
  const dst = join(LOCALES_DIR, 'zh-TW');
  const files = generateZhTw();
  const stale: string[] = [];
  for (const [f, text] of files) {
    let cur: string | null = null;
    try {
      cur = readFileSync(join(dst, f), 'utf8');
    } catch {
      cur = null;
    }
    if (cur !== text) stale.push(f);
  }
  const extra = (() => {
    try {
      return readdirSync(dst).filter((n) => n.endsWith('.json') && !files.has(n));
    } catch {
      return [];
    }
  })();
  if (check) {
    if (stale.length === 0 && extra.length === 0) {
      console.log(`zh-TW 语言包是最新的（${files.size} 个文件）`);
      return 0;
    }
    console.error(`zh-TW 语言包需要重新生成：${[...stale, ...extra.map((e) => `${e}（多余）`)].join('、')}`);
    console.error('运行 npx tsx scripts/gen-zh-tw.ts');
    return 1;
  }
  mkdirSync(dst, { recursive: true });
  for (const f of stale) writeFileSync(join(dst, f), files.get(f)!);
  console.log(
    `zh-TW：写入 ${stale.length} 个文件，共 ${files.size} 个${extra.length ? `；多余文件 ${extra.join('、')}` : ''}`,
  );
  return 0;
}

if (isMainModule(import.meta)) process.exitCode = main(process.argv.slice(2));
