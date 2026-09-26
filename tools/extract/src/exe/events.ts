import { hexVa, type PeFile } from '../pe/scan';
import { type CodeIndex, disasmFunction } from './code';
import type { ConstantResult, ConstValue } from './constants';
import {
  type EventSpec,
  FATE_SPEC,
  HELPER_CALL_SITES,
  MAGIC_CONDITION_SPEC,
  MAGIC_EFFECT_SPEC,
  MAGIC_FLOW_PARAMS,
  NEWS_SPEC,
  type ParamRef,
} from './eventSpec';
import { type AddressTranslator, alignTransfer, transferInsn } from './insnTransfer';
import { FATE_COUNT, type MagicEffectEntry, NEWS_COUNT, type NewsCategories, stripVoice } from './tables/events';
import { flowOf, type Insn, relTarget } from './x86';

/**
 * 新闻 / 命运 / 魔法屋的逐条抽取（.cache/extract/tables.<edition>.json 的 news / fate / magic 字段）：
 * - 处理函数：由指针表 / 跳表得到入口，递归下降取函数体（含共享尾块）；
 * - 标题与串：函数体引用的 Big5 串（去掉「#0149」这类语音编号前缀）；
 * - 调用：按 eventSpec.HELPER_CALL_SITES 在本版本识别出的辅助函数（坐牢、住院、加持判定、范围伤害……）；
 * - 加持判定（命运）：调用加持函数前压栈的两个参数 → 奖金 / 罚金 / 劫难类，以及是否处理「加倍」结果（cmp 2）；
 * - 参数：anchors/constants.json 在本版本的读取值。
 */

export type Params = Record<string, ConstValue | null>;

export interface EventRowCommon {
  id: number;
  handler: string;
  /** 标题串（去语音前缀；派生数据，只写 .cache） */
  headline: string | null;
  voice: number | null;
  /** 其余引用的 Big5 串 */
  strings: string[];
  /** 调用到的已识别辅助函数（按名称排序） */
  calls: string[];
  /** 函数体指令数 */
  insns: number;
  params: Params;
  paramVa: Record<string, string | null>;
  summary: string;
  effect: string;
  target: string;
  feasible: string;
}

export interface NewsRow extends EventRowCommon {
  category: number;
  categoryName: string;
}

export type FortuneClass = 'reward' | 'penalty' | 'misfortune';

export interface FateRow extends EventRowCommon {
  fortune: { class: FortuneClass; misfortune: number; penalty: number; handlesDouble: boolean } | null;
  /** 编号 33..36：地图组 1..3 的文案变体（表项 37..48） */
  variants: { group: number; slot: number; handler: string; headline: string | null; days: ConstValue | null }[];
}

export interface MagicConditionRow extends EventRowCommon {
  name: string;
}

export interface MagicEffectRow extends EventRowCommon {
  name: string;
  icon: number;
  x: number;
  y: number;
}

export interface MagicTables {
  conditions: MagicConditionRow[];
  effects: MagicEffectRow[];
  flow: Params;
}

export interface EventHelpers {
  /** 辅助函数名 → 本版本入口 VA（识别失败为 null） */
  byName: Record<string, string | null>;
}

/** 在本版本识别辅助函数入口：v3.11 直接读调用点；其他版本先迁移调用点再读 call 目标 */
export function resolveHelpers(code: CodeIndex, ref: CodeIndex | null, translate?: AddressTranslator): EventHelpers {
  const byName: Record<string, string | null> = {};
  for (const [name, site] of Object.entries(HELPER_CALL_SITES)) {
    const va = Number.parseInt(site, 16);
    let at: number | null = va;
    if (ref) {
      const t = transferInsn(ref, code, va, translate ? { translate } : {});
      at = t.va ?? (translate ? alignTransfer(ref, code, va, translate).va : null);
    }
    if (at === null || !code.inCode(at)) {
      byName[name] = null;
      continue;
    }
    const i = code.at(at);
    const tgt = i.mnem === 'call' ? relTarget(i) : null;
    byName[name] = tgt === null ? null : hexVa(tgt);
  }
  return { byName };
}

function stringsOf(file: PeFile, insns: readonly Insn[]): { text: string; voice: number | null }[] {
  const out: { text: string; voice: number | null }[] = [];
  const seen = new Set<number>();
  for (const i of insns) {
    for (const o of i.ops) {
      const v = o.t === 'imm' && o.size === 4 ? o.value >>> 0 : o.t === 'mem' && o.dispSize === 4 ? o.dispU : null;
      if (v === null || seen.has(v) || file.kindOfVa(v) !== 'data') continue;
      const s = file.big5At(v, 300);
      if (!s || !/[\u0080-￿]/u.test(s)) continue;
      seen.add(v);
      out.push(stripVoice(s));
    }
  }
  return out;
}

/**
 * 处理函数自己的标题：从入口按执行顺序（先走顺序流，条件跳转目标排队，无条件跳转换块）找第一个带语音编号的串；
 * 不进入其他处理函数的入口。
 */
function headlineOf(
  code: CodeIndex,
  entry: number,
  stopAt: ReadonlySet<number> = new Set(),
): { text: string; voice: number | null } | null {
  const queue = [entry];
  const seen = new Set<number>();
  let budget = 400;
  while (queue.length > 0 && budget > 0) {
    let at = queue.shift()!;
    while (budget-- > 0 && code.inCode(at) && !seen.has(at) && (at === entry || !stopAt.has(at))) {
      seen.add(at);
      const i = code.at(at);
      for (const s of stringsOf(code.file, [i])) if (s.voice !== null) return s;
      const f = flowOf(i);
      if (f === 'ret' || f === 'ijmp' || f === 'stop') break;
      const t = relTarget(i);
      if (f === 'jmp') {
        if (t !== null) queue.push(t);
        break;
      }
      if (f === 'jcc' && t !== null) queue.push(t);
      at += i.len;
    }
  }
  return null;
}

function callsOf(body: readonly Insn[], helpers: EventHelpers): string[] {
  const rev = new Map(
    Object.entries(helpers.byName)
      .filter(([, v]) => v !== null)
      .map(([k, v]) => [v!, k]),
  );
  const out = new Set<string>();
  for (const i of body) {
    if (i.mnem !== 'call') continue;
    const t = relTarget(i);
    const n = t === null ? undefined : rev.get(hexVa(t));
    if (n) out.add(n);
  }
  return [...out].sort();
}

function paramsOf(refs: readonly ParamRef[], consts: ReadonlyMap<string, ConstantResult>, edition: 'v311' | 'v206') {
  const params: Params = {};
  const paramVa: Record<string, string | null> = {};
  for (const r of refs) {
    const c = consts.get(r.const);
    const side = edition === 'v311' ? c?.v311 : c?.v206;
    params[r.name] = side?.value ?? null;
    paramVa[r.name] = side?.va ?? null;
  }
  return { params, paramVa };
}

function commonRow(
  code: CodeIndex,
  entry: number,
  spec: EventSpec,
  helpers: EventHelpers,
  consts: ReadonlyMap<string, ConstantResult>,
  edition: 'v311' | 'v206',
  stopAt: ReadonlySet<number>,
): EventRowCommon & { body: Insn[] } {
  const body = disasmFunction(code, entry, { stopAt, maxInsns: 3000 }).insns;
  const head = headlineOf(code, entry, stopAt);
  const strs = stringsOf(code.file, body).filter((s) => s.text !== head?.text);
  return {
    id: spec.id,
    handler: hexVa(entry),
    headline: head?.text ?? null,
    voice: head?.voice ?? null,
    strings: strs.map((s) => s.text),
    calls: callsOf(body, helpers),
    insns: body.length,
    ...paramsOf(spec.params, consts, edition),
    summary: spec.summary,
    effect: spec.effect,
    target: spec.target,
    feasible: spec.feasible,
    body,
  };
}

/** 加持判定：`push penalty; push misfortune; call fortune`，以及调用后 30 条内（跟随分支）是否有 `cmp r, 2` */
export function fortuneOf(code: CodeIndex, body: readonly Insn[], fortuneFn: string | null): FateRow['fortune'] {
  if (fortuneFn === null) return null;
  const k = body.findIndex((i) => i.mnem === 'call' && relTarget(i) !== null && hexVa(relTarget(i)!) === fortuneFn);
  if (k < 2) return null;
  const pushes = body.slice(Math.max(0, k - 4), k).filter((i) => i.mnem === 'push' && i.ops[0]?.t === 'imm');
  if (pushes.length < 2) return null;
  const penalty = (pushes[pushes.length - 2]!.ops[0] as { value: number }).value;
  const misfortune = (pushes[pushes.length - 1]!.ops[0] as { value: number }).value;
  // 调用之后按控制流走 60 条，看是否比较了「加倍」结果 2
  const seen = new Set<number>();
  const work = [body[k]!.va + body[k]!.len];
  let handlesDouble = false;
  let budget = 60;
  while (work.length > 0 && budget > 0 && !handlesDouble) {
    let va = work.pop()!;
    while (budget-- > 0 && code.inCode(va) && !seen.has(va)) {
      seen.add(va);
      const i = code.at(va);
      if (i.mnem === 'cmp' && i.ops[0]?.t === 'reg' && i.ops[1]?.t === 'imm' && i.ops[1].value === 2) {
        handlesDouble = true;
        break;
      }
      const f = flowOf(i);
      if (f === 'ret' || f === 'stop' || f === 'ijmp') break;
      if (f === 'jmp') {
        va = relTarget(i) ?? 0;
        continue;
      }
      if (f === 'jcc') {
        const t = relTarget(i);
        if (t !== null) work.push(t);
      }
      va += i.len;
    }
  }
  const cls: FortuneClass = misfortune !== 0 ? 'misfortune' : penalty !== 0 ? 'penalty' : 'reward';
  return { class: cls, misfortune, penalty, handlesDouble };
}

export interface EventInputs {
  code: CodeIndex;
  edition: 'v311' | 'v206';
  newsHandlers: readonly number[];
  newsCategories: NewsCategories;
  fateHandlers: readonly number[];
  magicEffects: readonly MagicEffectEntry[];
  magicConditions: readonly { slot: number; name: string; voice: number | null }[];
  magicEffectJump: readonly number[];
  magicCondJump: readonly number[];
  helpers: EventHelpers;
  constants: readonly ConstantResult[];
}

const strip = <T extends { body: Insn[] }>(r: T): Omit<T, 'body'> => {
  const { body: _b, ...rest } = r;
  return rest;
};

export function extractEvents(inp: EventInputs): { news: NewsRow[]; fate: FateRow[]; magic: MagicTables } {
  const consts = new Map(inp.constants.map((c) => [c.id, c]));
  const allEntries = new Set<number>([
    ...inp.newsHandlers,
    ...inp.fateHandlers,
    ...inp.magicEffectJump,
    ...inp.magicCondJump,
  ]);
  const others = (self: number) => new Set([...allEntries].filter((x) => x !== self));

  const news: NewsRow[] = NEWS_SPEC.slice(0, NEWS_COUNT).map((spec) => {
    const entry = inp.newsHandlers[spec.id]!;
    const r = commonRow(inp.code, entry, spec, inp.helpers, consts, inp.edition, others(entry));
    const category = inp.newsCategories.byNews[spec.id]!;
    return { ...strip(r), category, categoryName: inp.newsCategories.names[category] ?? '' };
  });

  const fortuneFn = inp.helpers.byName.fortune ?? null;
  const fate: FateRow[] = FATE_SPEC.slice(0, FATE_COUNT).map((spec) => {
    const entry = inp.fateHandlers[spec.id]!;
    const r = commonRow(inp.code, entry, spec, inp.helpers, consts, inp.edition, others(entry));
    const variants: FateRow['variants'] = [];
    if (spec.id >= 33) {
      for (let g = 1; g <= 3; g++) {
        const slot = spec.id + 4 * g;
        const h = inp.fateHandlers[slot];
        if (h === undefined) continue;
        const c = consts.get(`fate.${spec.id}.days${g}`);
        const side = inp.edition === 'v311' ? c?.v311 : c?.v206;
        variants.push({
          group: g,
          slot,
          handler: hexVa(h),
          headline: headlineOf(inp.code, h, others(h))?.text ?? null,
          days: side?.value ?? null,
        });
      }
    }
    return { ...strip(r), fortune: fortuneOf(inp.code, r.body, fortuneFn), variants };
  });

  const conditions: MagicConditionRow[] = MAGIC_CONDITION_SPEC.map((spec) => {
    const entry = inp.magicCondJump[spec.id]!;
    const r = commonRow(inp.code, entry, spec, inp.helpers, consts, inp.edition, others(entry));
    return { ...strip(r), name: inp.magicConditions[spec.id]?.name ?? '' };
  });
  const effects: MagicEffectRow[] = MAGIC_EFFECT_SPEC.map((spec) => {
    const entry = inp.magicEffectJump[spec.id]!;
    const r = commonRow(inp.code, entry, spec, inp.helpers, consts, inp.edition, others(entry));
    const e = inp.magicEffects[spec.id]!;
    return { ...strip(r), name: e.name, icon: e.icon, x: e.x, y: e.y };
  });
  const flow = paramsOf(MAGIC_FLOW_PARAMS, consts, inp.edition).params;
  return { news, fate, magic: { conditions, effects, flow } };
}
