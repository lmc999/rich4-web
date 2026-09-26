// 确定性守卫（docs/architecture.md §4）：扫描 packages/shared/src 下 util/geom/data/engine/minigames/ai 的源码，
// 先遮蔽注释与字符串再匹配禁用 API。用法：tsx scripts/check-determinism.ts [--root <dir>]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMainModule, parseRootArg, walkFiles } from './lib/cli';
import { lineLocator, lineText, maskSource } from './lib/lexer';

export const DETERMINISM_DIRS = ['util', 'geom', 'data', 'engine', 'minigames', 'ai'] as const;
export const SHARED_SRC = 'packages/shared/src';

export interface DeterminismRule {
  id: string;
  re: RegExp;
  message: string;
}

// 不以 `.` 或标识符字符开头：只匹配全局名本身，不匹配 foo.Date、startDate
const G = String.raw`(?<![\w$]|\.\s*)`;
const MEMBER = String.raw`\s*(?:\?\.|\.|\[)`;

export const DETERMINISM_RULES: readonly DeterminismRule[] = [
  {
    id: 'math-random',
    re: /\bMath\s*\??\.\s*random\b/g,
    message: '禁用 Math.random（引擎用 util/rng/xoshiro，sim/AI 用 watcom）',
  },
  {
    id: 'math-transcendental',
    re: /\bMath\s*\??\.\s*(?:sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|asinh|acosh|atanh|pow|exp|expm1|log|log2|log10|log1p|hypot|cbrt|round)\b/g,
    message: '禁用 Math 超越函数与 Math.round（跨引擎结果不保证一致；用整数运算、查表或 Math.trunc）',
  },
  {
    id: 'math-indirect',
    re: new RegExp(String.raw`${G}Math(?![\w$])(?!\s*\??\.\s*[A-Za-z_$])`, 'g'),
    message: '禁止动态访问或别名化 Math（只能写 Math.xxx 直接调用，避免绕过检查）',
  },
  {
    id: 'date',
    re: new RegExp(String.raw`${G}Date(?![\w$])`, 'g'),
    message: '禁用 Date（引擎内没有真实时间，日期由服务器传入并用 DateNum 整数表示）',
  },
  {
    id: 'performance',
    re: new RegExp(String.raw`${G}performance(?![\w$])${MEMBER}`, 'g'),
    message: '禁用 performance.*',
  },
  {
    id: 'intl',
    re: new RegExp(String.raw`${G}Intl(?![\w$])`, 'g'),
    message: '禁用 Intl（区域设置相关，结果随环境变化）',
  },
  {
    id: 'locale',
    re: /\.\s*(?:localeCompare|toLocaleString|toLocaleDateString|toLocaleTimeString|toLocaleUpperCase|toLocaleLowerCase)\b/g,
    message: '禁用区域相关方法（隐式依赖 Intl；排序比较器用 < / > 并按 seat 或 id 定序）',
  },
  {
    id: 'crypto',
    re: new RegExp(String.raw`${G}crypto(?![\w$])${MEMBER}`, 'g'),
    message: '禁用 crypto.*（非确定性随机源）',
  },
  {
    id: 'global-escape',
    re: /\b(?:globalThis|window|self|global)\s*\??\.\s*(?:Math|Date|performance|Intl|crypto)\b/g,
    message: '禁止经全局对象访问 Math/Date/performance/Intl/crypto',
  },
  {
    id: 'for-in',
    re: /\bfor\s*\(\s*(?:(?:const|let|var)\s+)?[\w$]+\s+in\b/g,
    message: '禁用 for…in（用 for…of 配合 Object.keys 并显式排序）',
  },
];

export interface DeterminismFinding {
  file: string;
  line: number;
  col: number;
  rule: string;
  message: string;
  text: string;
}

/** 是否属于确定性扫描范围（相对仓库根的 posix 路径） */
export function isScannedFile(relPath: string): boolean {
  if (!relPath.startsWith(`${SHARED_SRC}/`)) return false;
  const rest = relPath.slice(SHARED_SRC.length + 1);
  const top = rest.split('/')[0] ?? '';
  if (!(DETERMINISM_DIRS as readonly string[]).includes(top)) return false;
  if (!/\.(?:ts|tsx|mts|cts)$/.test(rest) || rest.endsWith('.d.ts')) return false;
  if (/\.(?:test|spec)\.[cm]?tsx?$/.test(rest)) return false;
  const segs = rest.split('/');
  return !segs.includes('testing') && !segs.includes('__tests__');
}

/** 检查单个源文件（纯函数） */
export function checkSource(file: string, source: string): DeterminismFinding[] {
  const masked = maskSource(source);
  const locate = lineLocator(source);
  const findings: DeterminismFinding[] = [];
  for (const rule of DETERMINISM_RULES) {
    rule.re.lastIndex = 0;
    for (const m of masked.matchAll(rule.re)) {
      const { line, col } = locate(m.index ?? 0);
      findings.push({ file, line, col, rule: rule.id, message: rule.message, text: lineText(source, line) });
    }
  }
  return findings.sort((a, b) => a.line - b.line || a.col - b.col || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));
}

/** 扫描仓库；目录不存在时跳过 */
export function scan(root: string): { files: string[]; findings: DeterminismFinding[] } {
  const files: string[] = [];
  for (const dir of DETERMINISM_DIRS) files.push(...walkFiles(root, `${SHARED_SRC}/${dir}`, isScannedFile));
  files.sort();
  const findings = files.flatMap((f) => checkSource(f, readFileSync(join(root, f), 'utf8')));
  return { files, findings };
}

export function formatFinding(f: DeterminismFinding): string {
  return `${f.file}:${f.line}:${f.col}  [${f.rule}] ${f.message}\n    ${f.text}`;
}

function main(): void {
  const root = parseRootArg(process.argv.slice(2));
  const { files, findings } = scan(root);
  if (findings.length > 0) {
    console.error(findings.map(formatFinding).join('\n'));
    console.error(`\ncheck-determinism: 发现 ${findings.length} 处违规（扫描 ${files.length} 个文件）`);
    process.exit(1);
  }
  console.log(`check-determinism: OK（扫描 ${files.length} 个文件）`);
}

if (isMainModule(import.meta)) main();
