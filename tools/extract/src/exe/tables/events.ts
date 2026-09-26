import { hexVa, type PeFile } from '../../pe/scan';
import { CodeIndex, memOperand } from '../code';
import type { Check, LocateContext } from '../types';
import { flowOf } from '../x86';
import { chk, hintOf, namePtr, type TableSpec } from './common';

/**
 * 新闻 / 命运 / 魔法屋的表（D2 第二部分；data-pipeline.md §6.2「函数指针表」「魔法屋 12×16」）。
 * - newsHandlers：36 个处理函数指针（v3.11 0x475e24），紧随其后是 36 字节分类号与 6 个分类名指针（newsCategories）；
 * - fateHandlers：49 个处理函数指针（v3.11 0x475ef0）= 37 张 + 编号 33..36 在地图组 1..3 的文案变体 12 个；
 * - magicEffects：12 × 16 字节 {图标号, x, y, 名称指针}（v3.11 0x475718）；magicConditions：12 个名称指针（v3.11 0x4756b8）；
 * - magicEffectJump / magicCondJump：效果执行与条件求名单两个函数里的跳表（在代码节内）。
 * 签名只用标题里的几个字（包含匹配）与代码结构，版本无关；v2.06 另由 xrefTransfer 从 v3.11 迁移交叉核对。
 */

export const NEWS_COUNT = 36;
export const FATE_COUNT = 37;
export const FATE_SLOTS = 49;
export const MAGIC_COUNT = 12;
export const MAGIC_STRIDE = 16;
export const NEWS_CATEGORY_NAMES = 6;

export function codeOf(ctx: LocateContext): CodeIndex {
  ctx.code ??= CodeIndex.build(ctx.file);
  return ctx.code;
}

/** 数据节中文本包含 needle 的串 */
function stringsContaining(ctx: LocateContext, needle: string): number[] {
  return ctx.strings
    .entries()
    .filter((e) => e.text.includes(needle))
    .map((e) => e.va);
}

/** 代码中 `push imm32` 引用 va 的指令 VA */
function pushSites(file: PeFile, va: number): number[] {
  return file
    .findU32InRange(va, va + 1, 'code')
    .filter((r) => file.bytes[file.vaToOff(r.at) - 1] === 0x68)
    .map((r) => r.at - 1);
}

/** 读 count 个 u32；越界返回 null */
function readPtrs(file: PeFile, va: number, count: number): number[] | null {
  if (file.tryVaToOff(va) === null || file.tryVaToOff(va + count * 4 - 1) === null) return null;
  return Array.from({ length: count }, (_, i) => file.u32(va + i * 4));
}

/**
 * 处理函数指针表签名：表[0] 指向的函数在入口后 0x100 字节内 push 标题 0 的串，表[1] 同理对应标题 1，
 * 且标题 0 的 push 位于表[0] 与表[1] 两个入口之间（处理函数按编号顺序排列）。
 */
function handlerTableSignature(
  ctx: LocateContext,
  headlines: readonly string[],
): { va: number | null; detail: string } {
  const sites = headlines.map((h) => stringsContaining(ctx, h).flatMap((s) => pushSites(ctx.file, s)));
  if (sites.some((s) => s.length === 0))
    return { va: null, detail: `找不到 push 标题串「${headlines.join('」「')}」的指令` };
  const nearSite = (fn: number, list: number[]) => list.find((p) => p >= fn && p - fn <= 0x100);
  const hits: number[] = [];
  for (const sp of ctx.file.spans('data')) {
    for (let off = sp.off; off + 8 <= sp.end; off += 4) {
      const a = ctx.file.reader.u32(off);
      const p0 = nearSite(a, sites[0]!);
      if (p0 === undefined) continue;
      const b = ctx.file.reader.u32(off + 4);
      if (b > p0 && nearSite(b, sites[1]!) !== undefined) hits.push(sp.va + (off - sp.off));
    }
  }
  if (hits.length !== 1)
    return { va: null, detail: `符合「表[0]/表[1] 入口附近 push 标题串」的位置 ${hits.length} 处` };
  return { va: hits[0]!, detail: `唯一：表[0]、表[1] 的入口附近分别 push「${headlines.join('」「')}」` };
}

function validateHandlers(file: PeFile, va: number, count: number, id: string): Check[] {
  const ptrs = readPtrs(file, va, count + 1);
  if (!ptrs) return [chk(`${id}.mapped`, 'error', false, `${hexVa(va)} 起 ${count} 项不在已映射的节内`)];
  const inCode = ptrs.slice(0, count).filter((p) => file.kindOfVa(p) === 'code').length;
  const asc = ptrs.slice(0, count).every((p, i) => i === 0 || p > ptrs[i - 1]!);
  return [
    chk(`${id}.code`, 'error', inCode === count, `${inCode}/${count} 项指向代码节`),
    chk(`${id}.ascending`, 'warn', asc, asc ? '入口地址严格递增' : '入口地址不是递增'),
    chk(`${id}.end`, 'info', file.kindOfVa(ptrs[count]!) !== 'code', `第 ${count + 1} 个 u32 ${hexVa(ptrs[count]!)}`),
  ];
}

export const newsHandlersSpec: TableSpec<number[]> = {
  id: 'newsHandlers',
  xrefSpan: NEWS_COUNT * 4,
  hint: (ctx) => hintOf(ctx, ctx.anchors.events.newsHandlers.hint),
  signature: (ctx) => handlerTableSignature(ctx, ctx.anchors.events.newsHandlers.headlines),
  validate: (file, va) => validateHandlers(file, va, NEWS_COUNT, 'newsHandlers'),
  parse: (file, va) => readPtrs(file, va, NEWS_COUNT)!,
  byteLength: () => NEWS_COUNT * 4,
};

export const fateHandlersSpec: TableSpec<number[]> = {
  id: 'fateHandlers',
  xrefSpan: FATE_SLOTS * 4,
  hint: (ctx) => hintOf(ctx, ctx.anchors.events.fateHandlers.hint),
  signature: (ctx) => handlerTableSignature(ctx, ctx.anchors.events.fateHandlers.headlines),
  validate: (file, va) => validateHandlers(file, va, FATE_SLOTS, 'fateHandlers'),
  parse: (file, va) => readPtrs(file, va, FATE_SLOTS)!,
  byteLength: () => FATE_SLOTS * 4,
};

// ───────────────────────── 新闻分类 ─────────────────────────

export interface NewsCategories {
  /** 每条新闻的分类号 0..5 */
  byNews: number[];
  names: string[];
}

export function parseNewsCategories(file: PeFile, va: number): NewsCategories {
  const byNews = Array.from(file.slice(va, NEWS_COUNT));
  const names = Array.from({ length: NEWS_CATEGORY_NAMES }, (_, i) => namePtr(file, va + NEWS_COUNT + i * 4) ?? '');
  return { byNews, names };
}

export const newsCategoriesSpec: TableSpec<NewsCategories> = {
  id: 'newsCategories',
  xrefSpan: NEWS_COUNT + NEWS_CATEGORY_NAMES * 4,
  hint: (ctx) => hintOf(ctx, ctx.anchors.events.newsCategories.hint),
  signature: (ctx) => {
    const t = ctx.located.newsHandlers;
    if (t === undefined) return { va: null, detail: '新闻指针表未定位' };
    return { va: t + NEWS_COUNT * 4, detail: `紧随新闻指针表（${hexVa(t)} + ${NEWS_COUNT * 4}）` };
  },
  validate: (file, va) => {
    if (file.tryVaToOff(va + NEWS_COUNT + NEWS_CATEGORY_NAMES * 4 - 1) === null) {
      return [chk('newsCategories.mapped', 'error', false, `${hexVa(va)} 不在已映射的节内`)];
    }
    const c = parseNewsCategories(file, va);
    const inRange = c.byNews.every((x) => x < NEWS_CATEGORY_NAMES);
    const monotone = c.byNews.every((x, i) => i === 0 || x >= c.byNews[i - 1]!);
    const named = c.names.filter((n) => n.length > 0).length;
    return [
      chk('newsCategories.range', 'error', inRange, `分类号 [${c.byNews.join(',')}]（每项 0..5）`),
      chk('newsCategories.monotone', 'warn', monotone, monotone ? '分类号不减' : '分类号不是单调的'),
      chk('newsCategories.names', 'error', named === NEWS_CATEGORY_NAMES, `${named}/6 个分类名能按 Big5 解码`),
    ];
  },
  parse: (file, va) => parseNewsCategories(file, va),
  byteLength: () => NEWS_COUNT + NEWS_CATEGORY_NAMES * 4,
};

// ───────────────────────── 魔法屋 ─────────────────────────

export interface MagicEffectEntry {
  slot: number;
  name: string;
  /** +0 图标号、+4/+8 转盘上的坐标（表现层） */
  icon: number;
  x: number;
  y: number;
}

export function parseMagicEffects(file: PeFile, va: number): MagicEffectEntry[] {
  return Array.from({ length: MAGIC_COUNT }, (_, i) => {
    const at = va + i * MAGIC_STRIDE;
    return {
      slot: i,
      icon: file.u32(at),
      x: file.u32(at + 4),
      y: file.u32(at + 8),
      name: namePtr(file, at + 12) ?? '',
    };
  });
}

export const magicEffectsSpec: TableSpec<MagicEffectEntry[]> = {
  id: 'magicEffects',
  xrefSpan: MAGIC_COUNT * MAGIC_STRIDE,
  hint: (ctx) => hintOf(ctx, ctx.anchors.events.magicEffects.hint),
  signature: (ctx) => {
    const [a, b] = ctx.anchors.events.magicEffects.names as [string, string];
    const hits: number[] = [];
    for (const s of ctx.strings.find(a)) {
      for (const at of ctx.file.findU32(s.va, 'data')) {
        if (namePtr(ctx.file, at + MAGIC_STRIDE) === b) hits.push(at - 12);
      }
    }
    if (hits.length !== 1) return { va: null, detail: `+12 指向「${a}」且下一项指向「${b}」的位置 ${hits.length} 处` };
    return { va: hits[0]!, detail: `唯一：+12 指向「${a}」、+28 指向「${b}」` };
  },
  validate: (file, va) => {
    if (file.tryVaToOff(va + MAGIC_COUNT * MAGIC_STRIDE - 1) === null) {
      return [chk('magicEffects.mapped', 'error', false, `${hexVa(va)} 不在已映射的节内`)];
    }
    const rows = parseMagicEffects(file, va);
    const named = rows.filter((r) => r.name.length > 0).length;
    return [chk('magicEffects.names', 'error', named === MAGIC_COUNT, `${named}/12 个效果名能按 Big5 解码`)];
  },
  parse: (file, va) => parseMagicEffects(file, va),
  byteLength: () => MAGIC_COUNT * MAGIC_STRIDE,
};

export const stripVoice = (s: string): { text: string; voice: number | null } => {
  const m = /^#(\d{4})/.exec(s);
  return m ? { text: s.slice(5), voice: Number(m[1]) } : { text: s, voice: null };
};

export function parseMagicConditions(file: PeFile, va: number): { slot: number; name: string; voice: number | null }[] {
  return Array.from({ length: MAGIC_COUNT }, (_, i) => {
    const { text, voice } = stripVoice(namePtr(file, va + i * 4) ?? '');
    return { slot: i, name: text, voice };
  });
}

export const magicConditionsSpec: TableSpec<ReturnType<typeof parseMagicConditions>> = {
  id: 'magicConditions',
  xrefSpan: MAGIC_COUNT * 4,
  hint: (ctx) => hintOf(ctx, ctx.anchors.events.magicConditions.hint),
  signature: (ctx) => {
    const [a, b] = ctx.anchors.events.magicConditions.names as [string, string];
    const hits: number[] = [];
    for (const s of stringsContaining(ctx, a)) {
      for (const at of ctx.file.findU32(s, 'data')) {
        const next = namePtr(ctx.file, at + 4);
        if (next?.includes(b)) hits.push(at);
      }
    }
    if (hits.length !== 1) return { va: null, detail: `指向含「${a}」且下一项指向含「${b}」的位置 ${hits.length} 处` };
    return { va: hits[0]!, detail: `唯一：指向含「${a}」、下一项指向含「${b}」的串` };
  },
  validate: (file, va) => {
    if (file.tryVaToOff(va + MAGIC_COUNT * 4 - 1) === null) {
      return [chk('magicConditions.mapped', 'error', false, `${hexVa(va)} 不在已映射的节内`)];
    }
    const rows = parseMagicConditions(file, va);
    const named = rows.filter((r) => r.name.length > 0).length;
    return [chk('magicConditions.names', 'error', named === MAGIC_COUNT, `${named}/12 个条件名能按 Big5 解码`)];
  },
  parse: (file, va) => parseMagicConditions(file, va),
  byteLength: () => MAGIC_COUNT * 4,
};

// ───────────────────────── 代码节内的跳表 ─────────────────────────

/** 代码中所有 `jmp dword [reg*4 + T]`，T 的前 count 项都指向代码节 */
function jumpTables(ctx: LocateContext, count: number): { jmp: number; table: number; targets: number[] }[] {
  const code = codeOf(ctx);
  const out: { jmp: number; table: number; targets: number[] }[] = [];
  for (const va of code.starts) {
    const b0 = ctx.file.bytes[ctx.file.vaToOff(va)];
    if (b0 !== 0xff) continue;
    const i = code.at(va);
    if (i.mnem !== 'jmp' || flowOf(i) !== 'ijmp') continue;
    const m = memOperand(i);
    if (m?.scale !== 4 || m.index === null || m.base !== null || m.dispSize !== 4) continue;
    const t = readPtrs(ctx.file, m.dispU, count);
    if (t?.every((x) => code.inCode(x))) out.push({ jmp: va, table: m.dispU, targets: t });
  }
  return out;
}

/** 从 target 起线性取 n 条指令 */
function head(code: CodeIndex, va: number, n: number) {
  const out = [];
  let at = va;
  for (let k = 0; k < n && code.inCode(at); k++) {
    const i = code.at(at);
    out.push(i);
    at += i.len;
  }
  return out;
}

function validateJump(file: PeFile, va: number, ctx: LocateContext, id: string): Check[] {
  const t = readPtrs(file, va, MAGIC_COUNT);
  if (!t) return [chk(`${id}.mapped`, 'error', false, `${hexVa(va)} 不在已映射的节内`)];
  const code = codeOf(ctx);
  const ok = t.filter((x) => code.inCode(x) && code.isBoundary(x)).length;
  const near = t.every((x) => Math.abs(x - va) < 0x1000);
  return [
    chk(`${id}.targets`, 'error', ok === MAGIC_COUNT, `${ok}/12 项指向代码节的指令起点`),
    chk(`${id}.near`, 'error', near, near ? '目标都在跳表 ±4KB 内' : '有目标离跳表过远'),
  ];
}

export const magicEffectJumpSpec: TableSpec<number[]> = {
  id: 'magicEffectJump',
  xrefSpan: MAGIC_COUNT * 4,
  hint: (ctx) => hintOf(ctx, ctx.anchors.events.magicEffectJump.hint),
  signature: (ctx) => {
    const eff = ctx.located.magicEffects;
    if (eff === undefined) return { va: null, detail: '魔法屋效果表未定位' };
    const code = codeOf(ctx);
    const names = eff + 12;
    const hits = jumpTables(ctx, MAGIC_COUNT).filter((j) => {
      const refs = j.targets.filter((x) =>
        head(code, x, 40).some((i) => i.ops.some((o) => o.t === 'mem' && o.dispSize === 4 && o.dispU === names)),
      );
      return refs.length >= 8;
    });
    const tables = [...new Set(hits.map((h) => h.table))];
    if (tables.length !== 1) return { va: null, detail: `≥8 个目标读取效果名表的 12 项跳表 ${tables.length} 个` };
    return { va: tables[0]!, detail: `唯一：12 项跳表，≥8 个目标读取效果名表（${hexVa(names)}）` };
  },
  validate: (file, va, ctx) => validateJump(file, va, ctx, 'magicEffectJump'),
  parse: (file, va) => readPtrs(file, va, MAGIC_COUNT)!,
  byteLength: () => MAGIC_COUNT * 4,
};

export const magicCondJumpSpec: TableSpec<number[]> = {
  id: 'magicCondJump',
  xrefSpan: MAGIC_COUNT * 4,
  hint: (ctx) => hintOf(ctx, ctx.anchors.events.magicCondJump.hint),
  signature: (ctx) => {
    const code = codeOf(ctx);
    // 条件 7 / 8：座驾字节 and 3 后与 1 / 2 比较（骑机车、开汽车）
    const vehicleCmp = (x: number, v: number) => {
      const h = head(code, x, 14);
      return h.some(
        (i, k) =>
          i.mnem === 'and' &&
          i.ops[1]?.t === 'imm' &&
          i.ops[1].value === 3 &&
          h[k + 1]?.mnem === 'cmp' &&
          h[k + 1]!.ops[1]?.t === 'imm' &&
          (h[k + 1]!.ops[1] as { value: number }).value === v,
      );
    };
    const hits = jumpTables(ctx, MAGIC_COUNT).filter(
      (j) => vehicleCmp(j.targets[7]!, 1) && vehicleCmp(j.targets[8]!, 2),
    );
    const tables = [...new Set(hits.map((h) => h.table))];
    if (tables.length !== 1)
      return { va: null, detail: `目标 7/8 为「座驾 and 3 后比较 1/2」的 12 项跳表 ${tables.length} 个` };
    return { va: tables[0]!, detail: '唯一：12 项跳表，目标 7/8 分别判断骑机车 / 开汽车' };
  },
  validate: (file, va, ctx) => validateJump(file, va, ctx, 'magicCondJump'),
  parse: (file, va) => readPtrs(file, va, MAGIC_COUNT)!,
  byteLength: () => MAGIC_COUNT * 4,
};

export const EVENT_SPECS = [
  newsHandlersSpec,
  newsCategoriesSpec,
  fateHandlersSpec,
  magicEffectsSpec,
  magicConditionsSpec,
  magicEffectJumpSpec,
  magicCondJumpSpec,
] as const;
