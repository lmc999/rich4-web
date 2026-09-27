// 分层依赖守卫（docs/architecture.md §3）：用正则解析 import/export from、副作用 import、动态 import 与 require 的模块说明符，
// 把相对路径与 @rich4/* 包说明符解析到所属模块后按分层表判定。用法：tsx scripts/check-deps.ts [--root <dir>]
import { existsSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { join, posix } from 'node:path';
import { isMainModule, parseRootArg, walkFiles } from './lib/cli';
import { lineLocator, lineText, maskSource } from './lib/lexer';

// ───────────────────────── 解析 import ─────────────────────────

export interface ImportRef {
  spec: string;
  kind: 'static' | 'side-effect' | 'dynamic' | 'require';
  typeOnly: boolean;
  /** 命名绑定（含 default、*），用于名字级规则 */
  names: string[];
  offset: number;
}

const NOT_MEMBER = String.raw`(?<![\w$.])`;
// import/export … from '…'（子句只允许标识符、花括号、逗号、星号、空白，且不跨越另一个 import/export）
const STATIC_RE = new RegExp(
  String.raw`${NOT_MEMBER}(import|export)\s+(type\s+)?((?:(?!\b(?:import|export)\b)[\w$\s{},*])*?)\s*\bfrom\s*(['"])`,
  'g',
);
const SIDE_EFFECT_RE = new RegExp(String.raw`${NOT_MEMBER}import\s*(['"])`, 'g');
const DYNAMIC_RE = new RegExp(String.raw`${NOT_MEMBER}import\s*\(\s*(['"\x60])`, 'g');
const REQUIRE_RE = new RegExp(String.raw`${NOT_MEMBER}require\s*\(\s*(['"\x60])`, 'g');

function parseNames(clause: string): string[] {
  const names: string[] = [];
  const braced = clause.match(/\{([^}]*)\}/);
  if (braced) {
    for (const part of (braced[1] ?? '').split(',')) {
      const name = part
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (name) names.push(name);
    }
  }
  const outside = clause.replace(/\{[^}]*\}/, '').trim();
  if (/\*/.test(outside)) names.push('*');
  const def = outside
    .replace(/\*\s*as\s+[\w$]+/, '')
    .replace(/,/g, ' ')
    .trim();
  if (def && /^[\w$]+$/.test(def)) names.push('default');
  return names;
}

/** 从源码中提取模块说明符（注释中的 import 不计，字符串内容里的伪 import 不计） */
export function parseImports(source: string): ImportRef[] {
  const code = maskSource(source); // 字符串内容已遮蔽，只在真实代码位置匹配关键字
  const out: ImportRef[] = [];
  const readSpec = (quotePos: number): string | null => {
    const q = code[quotePos]!;
    const end = code.indexOf(q, quotePos + 1);
    if (end === -1) return null;
    const spec = source.slice(quotePos + 1, end);
    if (q === '`' && spec.includes('${')) return null;
    return spec;
  };
  const push = (
    m: RegExpMatchArray,
    kind: ImportRef['kind'],
    quoteGroup: number,
    typeOnly: boolean,
    names: string[],
  ) => {
    const start = m.index ?? 0;
    const quotePos = start + m[0].length - (m[quoteGroup] ?? '').length;
    const spec = readSpec(quotePos);
    if (spec !== null) out.push({ spec, kind, typeOnly, names, offset: start });
  };
  for (const m of code.matchAll(STATIC_RE)) {
    const clause = m[3] ?? '';
    push(m, 'static', 4, Boolean(m[2]), parseNames(clause));
  }
  for (const m of code.matchAll(SIDE_EFFECT_RE)) push(m, 'side-effect', 1, false, []);
  for (const m of code.matchAll(DYNAMIC_RE)) push(m, 'dynamic', 1, false, ['*']);
  for (const m of code.matchAll(REQUIRE_RE)) push(m, 'require', 1, false, ['*']);
  return out.sort((a, b) => a.offset - b.offset);
}

// ───────────────────────── 文件与目标分类 ─────────────────────────

export type PkgId = 'shared' | 'server' | 'client' | 'extract' | 'scripts' | 'e2e' | 'root';

const PKG_DIRS: ReadonlyArray<readonly [PkgId, string]> = [
  ['shared', 'packages/shared/'],
  ['server', 'apps/server/'],
  ['client', 'apps/client/'],
  ['extract', 'tools/extract/'],
  ['scripts', 'scripts/'],
  ['e2e', 'e2e/'],
];

export interface Unit {
  pkg: PkgId;
  /** 模块单元，形如 shared/engine/core/postPatch、server/src/game/GameRunner（无扩展名） */
  unit: string;
}

const EXT_RE = /\.(?:d\.)?(?:[cm]?[jt]sx?|json)$/;

/** 仓库相对路径（可无扩展名）→ 所属包与模块单元 */
export function unitOf(repoPath: string): Unit {
  const p = repoPath.replace(EXT_RE, '');
  for (const [pkg, dir] of PKG_DIRS) {
    if (!p.startsWith(dir)) continue;
    let rest = p.slice(dir.length);
    if (pkg === 'shared') {
      if (!rest.startsWith('src/')) return { pkg, unit: `shared/.${rest}` };
      rest = rest.slice(4);
    }
    return { pkg, unit: `${pkg}/${rest}` };
  }
  return { pkg: 'root', unit: `root/${p}` };
}

export interface FileInfo extends Unit {
  path: string;
  /** 用于分层表的模块：shared/engine、server/game、client/src … */
  module: string;
  isTest: boolean;
}

/** shared 单元所属模块：shared/engine/core/ctx → shared/engine；src/index.ts → shared/root */
function moduleOfUnit(unit: string): string {
  const segs = unit.split('/');
  if (segs[0] !== 'shared') return `${segs[0]}/${segs[1] ?? ''}`;
  return segs.length === 2 && segs[1] === 'index' ? 'shared/root' : `shared/${segs[1]}`;
}

const TEST_SEGMENTS = new Set(['test', 'tests', '__tests__', 'testing', '__mocks__']);

export function classifyFile(path: string): FileInfo {
  const u = unitOf(path);
  const segs = u.unit.split('/');
  const isTest = /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) || segs.slice(1).some((s) => TEST_SEGMENTS.has(s));
  let module: string;
  switch (u.pkg) {
    case 'shared':
      module = segs[1]!.startsWith('.') ? 'shared/tooling' : moduleOfUnit(u.unit);
      break;
    case 'server':
      if (segs[1] === 'src') module = segs[2] === 'game' && segs.length > 3 ? 'server/game' : 'server/src';
      else if (segs[1] === 'scripts') module = 'server/scripts';
      else if (segs[1] === 'test') module = 'server/test';
      else module = 'server/tooling';
      break;
    case 'client':
      module = segs[1] === 'src' ? 'client/src' : segs[1] === 'scripts' ? 'client/scripts' : 'client/tooling';
      break;
    case 'extract':
      module = segs[1] === 'src' ? 'extract/src' : segs[1] === 'test' ? 'extract/test' : 'extract/tooling';
      break;
    default:
      module = u.pkg;
  }
  return { ...u, path, module, isTest };
}

export type Target =
  | ({ kind: 'internal' } & Unit)
  | { kind: 'node'; name: string }
  | { kind: 'external'; name: string }
  | { kind: 'unresolved'; reason: string };

export interface ResolveContext {
  /** 仓库内全部源文件（posix 相对路径），用于判定目录导入与扩展名 */
  files: ReadonlySet<string>;
  /** packages/shared/package.json 的 exports（'.' → './src/index.ts'） */
  sharedExports: Readonly<Record<string, string>>;
}

const RESOLVE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.json'];

function resolveRepoPath(base: string, ctx: ResolveContext): string {
  const noExt = base.replace(EXT_RE, '');
  if (ctx.files.has(base) || RESOLVE_EXTS.some((e) => ctx.files.has(noExt + e))) return noExt;
  const prefix = `${base.replace(/\/$/, '')}/index`;
  if (RESOLVE_EXTS.some((e) => ctx.files.has(prefix + e))) return prefix;
  return noExt;
}

/** 与 packages/shared/package.json 的 exports 保持一致；CLI 运行时以实际 package.json 为准 */
export const DEFAULT_SHARED_EXPORTS: Readonly<Record<string, string>> = {
  '.': './src/index.ts',
  './util': './src/util/index.ts',
  './geom': './src/geom/index.ts',
  './data': './src/data/index.ts',
  './engine': './src/engine/index.ts',
  './engine-testing': './src/engine/testing/index.ts',
  './view': './src/view/index.ts',
  './net': './src/net/index.ts',
  './minigames': './src/minigames/index.ts',
  './ai': './src/ai/index.ts',
  './save': './src/save/index.ts',
  './assets': './src/assets/index.ts',
};

const PKG_SPEC: ReadonlyArray<readonly [string, string]> = [
  ['@rich4/server', 'apps/server'],
  ['@rich4/client', 'apps/client'],
  ['@rich4/extract', 'tools/extract'],
];

export function resolveTarget(fromPath: string, spec: string, ctx: ResolveContext): Target {
  // 以 / 开头的是 Vite 等工具的项目根或 public 路径，不属于模块依赖
  if (spec.startsWith('/')) return { kind: 'external', name: spec };
  if (spec.startsWith('.')) {
    const joined = posix.normalize(posix.join(posix.dirname(fromPath), spec));
    if (joined.startsWith('..')) return { kind: 'unresolved', reason: '相对路径越出仓库' };
    return { kind: 'internal', ...unitOf(resolveRepoPath(joined, ctx)) };
  }
  if (spec === '@rich4/shared' || spec.startsWith('@rich4/shared/')) {
    const sub = spec === '@rich4/shared' ? '.' : `./${spec.slice('@rich4/shared/'.length)}`;
    const mapped = ctx.sharedExports[sub];
    const rel = mapped ? posix.join('packages/shared', mapped) : posix.join('packages/shared/src', sub);
    return { kind: 'internal', ...unitOf(resolveRepoPath(rel, ctx)) };
  }
  for (const [name, dir] of PKG_SPEC) {
    if (spec === name || spec.startsWith(`${name}/`)) {
      const rest = spec.slice(name.length).replace(/^\//, '');
      return { kind: 'internal', ...unitOf(rest ? `${dir}/${rest}` : `${dir}/src/index`) };
    }
  }
  if (spec.startsWith('node:') || isBuiltin(spec)) return { kind: 'node', name: spec };
  const segs = spec.split('/');
  const name = spec.startsWith('@') ? segs.slice(0, 2).join('/') : (segs[0] ?? spec);
  return { kind: 'external', name };
}

// ───────────────────────── 分层规则 ─────────────────────────

const under = (unit: string, prefix: string): boolean => unit === prefix || unit.startsWith(`${prefix}/`);
const underAny = (unit: string, prefixes: readonly string[]): boolean => prefixes.some((p) => under(unit, p));

const ENGINE_BARRELS = ['shared/engine/index', 'shared/index'];
const NET_SAVE_ALLOW = [
  'shared/util',
  'shared/data',
  'shared/engine/types',
  'shared/engine/index',
  'shared/view/types',
  'shared/minigames/types',
  'shared/ai/types',
];

/**
 * shared 模块 → 允许依赖的目标前缀（本模块内部始终允许）。
 * 按 §3 表格的「允许依赖」列逐项录入；util 作为零依赖的最底层对所有 shared 模块开放；
 * engine 的对外入口 engine/index 视作公开 API，对 view/ai/net/save 开放，但不得取用引擎实现（见 FORBIDDEN_ENGINE_NAMES）。
 */
export const SHARED_ALLOW: Readonly<Record<string, readonly string[]>> = {
  'shared/util': [],
  'shared/geom': ['shared/util'],
  // §5.1 的 MapIndex（data/maps/mapIndex.ts）要建窗口索引（lotsInWindow），必须调用 geom/viewWindow；
  // geom 只依赖 util，且 §3「禁止」列未列 geom，放行不会产生环
  'shared/data': ['shared/util', 'shared/geom'],
  'shared/engine': ['shared/util', 'shared/geom', 'shared/data'],
  'shared/view': [
    'shared/util',
    'shared/data',
    'shared/engine/types',
    'shared/engine/core/postPatch',
    'shared/engine/index',
  ],
  'shared/minigames': ['shared/util'],
  'shared/ai': [
    'shared/util',
    'shared/geom',
    'shared/data',
    'shared/view',
    'shared/engine/types',
    'shared/engine/selectors',
    'shared/engine/index',
  ],
  'shared/net': NET_SAVE_ALLOW,
  'shared/save': NET_SAVE_ALLOW,
  // 原版皮肤素材包契约（docs/design/original-skin.md、design-draft §2.2）：只依赖 util；
  // 其他 shared 模块不在各自的允许表里列它，因此都不能反向依赖它
  'shared/assets': ['shared/util'],
};

export const CLIENT_ALLOW: readonly string[] = [
  'shared/util',
  'shared/geom',
  'shared/data',
  'shared/view',
  'shared/net',
  'shared/minigames',
  'shared/assets',
  'shared/engine/types',
  'shared/engine/selectors',
  'shared/engine/index',
];

/** apps/server 对 shared 没有额外限制（shared/assets 同样可用）；tools/extract 只能用 data、util 与 assets */
export const EXTRACT_ALLOW: readonly string[] = ['shared/data', 'shared/util', 'shared/assets'];

/** 经由 engine 入口取用时仍视为「引擎实现」的导出名 */
export const FORBIDDEN_ENGINE_NAMES: readonly string[] = ['createEngine', 'engine', 'internal'];
const ENGINE_NAME_GUARDED = new Set(['shared/view', 'shared/ai', 'shared/net', 'shared/save', 'client/src']);

/** 判定单个 import，违规时返回原因 */
export function checkImport(from: FileInfo, imp: ImportRef, target: Target): string | null {
  const productPkg = from.pkg === 'shared' || from.pkg === 'server' || from.pkg === 'client';

  // 1) 硬性：apps/** 与 packages/** 不得依赖 @rich4/extract（测试也不行）
  if (productPkg && target.kind === 'internal' && target.pkg === 'extract') {
    return 'apps/** 与 packages/** 不得依赖 @rich4/extract（tools/extract）';
  }
  if (target.kind === 'unresolved') return `无法解析：${target.reason}`;

  // 2) 包边界
  if (target.kind === 'internal' && target.pkg !== from.pkg) {
    if (from.pkg === 'shared') return 'packages/shared 不得依赖 apps、tools、scripts、e2e';
    if (from.pkg === 'server' && target.pkg === 'client') return 'apps/server 不得依赖 apps/client';
    if (from.pkg === 'client' && target.pkg === 'server') return 'apps/client 不得依赖 apps/server';
    if (from.pkg === 'extract' && (target.pkg === 'server' || target.pkg === 'client')) {
      return 'tools/extract 不得依赖 apps/*';
    }
    if (
      (productPkg || from.pkg === 'extract') &&
      (target.pkg === 'scripts' || target.pkg === 'e2e' || target.pkg === 'root')
    ) {
      return '产品代码不得依赖 scripts/、e2e/ 或仓库根文件';
    }
  }

  // 3) engine-testing 只给测试与脚本
  if (target.kind === 'internal' && under(target.unit, 'shared/engine/testing')) {
    const scriptCtx = from.module === 'server/scripts' || from.pkg === 'scripts' || from.pkg === 'e2e';
    if (!from.isTest && !scriptCtx) return 'engine-testing 只能在测试（test/、*.test.ts、testing/）和脚本中使用';
  }

  // 4) 测试文件与 tooling 只受上面的边界约束
  if (from.isTest || from.module.endsWith('/tooling')) return null;

  // 5) node:* 与 socket.io
  if (target.kind === 'node') {
    if (from.pkg === 'shared') return 'packages/shared 必须零 IO，不得引入 node:*';
    if (from.module === 'client/src') return 'apps/client 不得引入 node:*';
    if (from.module === 'server/game') return 'apps/server/src/game 不得引入 node:*（GameRunner 等必须无 IO）';
    return null;
  }
  if (target.kind === 'external') {
    if (from.module === 'server/game' && (target.name === 'socket.io' || target.name.startsWith('socket.io-'))) {
      return 'apps/server/src/game 不得引入 socket.io';
    }
    return null;
  }

  // 6) 名字级规则
  if (from.module === 'shared/ai' && imp.names.includes('GameState')) {
    return 'shared/ai 不得使用 GameState 类型（只能经 AiView 读取公开信息）';
  }
  if (ENGINE_NAME_GUARDED.has(from.module) && underAny(target.unit, ENGINE_BARRELS)) {
    const bad = imp.names.filter((n) => FORBIDDEN_ENGINE_NAMES.includes(n));
    if (bad.length > 0) return `${from.module} 不得取用引擎实现（${bad.join('、')}）`;
  }

  // 7) 分层表
  if (from.pkg === 'shared' && target.pkg === 'shared') {
    if (from.module === 'shared/root' || under(target.unit, from.module)) return null;
    const allow = SHARED_ALLOW[from.module];
    if (allow && !underAny(target.unit, allow))
      return `${from.module} 不得依赖 ${moduleOfUnit(target.unit)}（${target.unit}）`;
    return null;
  }
  const rootHint = target.unit === 'shared/index' ? '（请改用 @rich4/shared/<子路径>，不要用根入口）' : '';
  if (from.module === 'client/src' && target.pkg === 'shared' && !underAny(target.unit, CLIENT_ALLOW)) {
    return `apps/client 只能依赖 shared 的 util/geom/data/view/net/minigames/assets/engine(types,selectors)，不得依赖 ${target.unit}${rootHint}`;
  }
  if (from.module === 'extract/src' && target.pkg === 'shared' && !underAny(target.unit, EXTRACT_ALLOW)) {
    return `tools/extract 只能依赖 shared/data、shared/assets 与 shared/util，不得依赖 ${target.unit}${rootHint}`;
  }
  return null;
}

// ───────────────────────── 汇总 ─────────────────────────

export interface DepViolation {
  file: string;
  line: number;
  spec: string;
  message: string;
  text: string;
}

const SECRET_RE = /\??\.\s*secret\b/g;

/** 检查一组源文件（纯函数）：files 为 路径 → 源码 */
export function check(
  files: ReadonlyMap<string, string>,
  sharedExports: Readonly<Record<string, string>> = DEFAULT_SHARED_EXPORTS,
): DepViolation[] {
  const ctx: ResolveContext = { files: new Set(files.keys()), sharedExports };
  const out: DepViolation[] = [];
  for (const [path, source] of files) {
    const info = classifyFile(path);
    const locate = lineLocator(source);
    for (const imp of parseImports(source)) {
      const msg = checkImport(info, imp, resolveTarget(path, imp.spec, ctx));
      if (msg) {
        const { line } = locate(imp.offset);
        out.push({ file: path, line, spec: imp.spec, message: msg, text: lineText(source, line) });
      }
    }
    // §3：shared/ai 不得读取 state.secret
    if (info.module === 'shared/ai' && !info.isTest) {
      for (const m of maskSource(source).matchAll(SECRET_RE)) {
        const { line } = locate(m.index ?? 0);
        out.push({
          file: path,
          line,
          spec: '',
          message: 'shared/ai 不得访问 state.secret',
          text: lineText(source, line),
        });
      }
    }
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
}

const SOURCE_RE = /\.(?:[cm]?[jt]sx?)$/;
export const SCAN_DIRS = ['packages', 'apps', 'tools'] as const;

export function readSharedExports(root: string): Record<string, string> {
  const pkg = join(root, 'packages/shared/package.json');
  if (!existsSync(pkg)) return { ...DEFAULT_SHARED_EXPORTS };
  const json = JSON.parse(readFileSync(pkg, 'utf8')) as { exports?: Record<string, string> };
  return json.exports ?? { ...DEFAULT_SHARED_EXPORTS };
}

export function scan(root: string): { files: number; violations: DepViolation[] } {
  const paths = SCAN_DIRS.flatMap((d) => walkFiles(root, d, (p) => SOURCE_RE.test(p)));
  const files = new Map(paths.map((p) => [p, readFileSync(join(root, p), 'utf8')] as const));
  return { files: files.size, violations: check(files, readSharedExports(root)) };
}

function main(): void {
  const root = parseRootArg(process.argv.slice(2));
  const { files, violations } = scan(root);
  if (violations.length > 0) {
    for (const v of violations) {
      console.error(`${v.file}:${v.line}  ${v.message}${v.spec ? `  ← '${v.spec}'` : ''}\n    ${v.text}`);
    }
    console.error(
      `\ncheck-deps: 发现 ${violations.length} 处违规（扫描 ${files} 个文件，规则见 docs/architecture.md §3）`,
    );
    process.exit(1);
  }
  console.log(`check-deps: OK（扫描 ${files} 个文件）`);
}

if (isMainModule(import.meta)) main();
