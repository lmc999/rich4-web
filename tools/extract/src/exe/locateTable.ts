import { hexVa } from '../pe/scan';
import { chk, passes, type TableSpec } from './tables/common';
import type { AnyTableId, Check, LocateCandidate, LocateContext, LocateInfo, LocateMethod } from './types';
import { xrefTransfer } from './xrefTransfer';

/**
 * 表定位（data-pipeline.md §6.2）：每张表收集 signature / xref / hint 三类候选，逐一做结构校验；
 * 通过校验的候选必须指向同一地址，按 signature → xref → hint 的顺序报告采用的方法。
 * 全部失败或互相矛盾时抛 LocateError（exe tables 以 exit 1 结束）。
 */

export class LocateError extends Error {
  readonly table: AnyTableId;
  readonly candidates: LocateCandidate[];
  constructor(table: AnyTableId, message: string, candidates: LocateCandidate[]) {
    super(`E_LOCATE: ${table}: ${message}`);
    this.name = 'LocateError';
    this.table = table;
    this.candidates = candidates;
  }
}

const METHOD_ORDER: readonly LocateMethod[] = ['signature', 'xref', 'hint'];

export function locateTable<R>(spec: TableSpec<R>, ctx: LocateContext): { va: number; info: LocateInfo } {
  const raw: { method: LocateMethod; va: number | null; detail: string }[] = [];
  const sig = spec.signature(ctx);
  raw.push({ method: 'signature', va: sig.va, detail: sig.detail });
  const refVa = ctx.ref?.located[spec.id];
  if (ctx.ref && refVa !== undefined) {
    const x = xrefTransfer(ctx.ref.file, ctx.file, refVa, { span: spec.xrefSpan });
    const siteInfo = `${x.resolved}/${x.sites.length} 个引用点唯一命中`;
    const outliers = x.sites.filter(
      (s) => s.result !== null && x.va !== null && Number.parseInt(s.result, 16) !== x.va,
    );
    const how = x.agreed
      ? '且一致'
      : `，多数一致（${x.support}/${x.resolved}；离群 ${outliers.map((s) => `${s.at}→${s.result}`).join(', ')}）`;
    raw.push({
      method: 'xref',
      va: x.va,
      detail: x.va !== null ? `自参考 ${x.target} 迁移：${siteInfo}${how}` : `自参考 ${x.target} 迁移失败：${siteInfo}`,
    });
  }
  const h = spec.hint(ctx);
  if (h !== null) raw.push({ method: 'hint', va: h, detail: `参考 VA 提示（anchors/tables.json）` });

  const candidates: LocateCandidate[] = [];
  const checksByVa = new Map<number, Check[]>();
  for (const c of raw) {
    let accepted = false;
    let detail = c.detail;
    if (c.va !== null) {
      let checks = checksByVa.get(c.va);
      if (!checks) {
        try {
          checks = spec.validate(ctx.file, c.va, ctx);
        } catch (e) {
          checks = [chk(`${spec.id}.read`, 'error', false, e instanceof Error ? e.message : String(e))];
        }
        checksByVa.set(c.va, checks);
      }
      accepted = passes(checks);
      if (!accepted) {
        const failed = checks.filter((k) => !k.ok && k.level === 'error');
        detail += `；结构校验失败：${failed.map((k) => `${k.id}（${k.detail}）`).join('；')}`;
      }
    }
    candidates.push({ method: c.method, va: c.va === null ? null : hexVa(c.va), accepted, detail });
  }
  const ok = candidates.filter((c) => c.accepted);
  const vas = [...new Set(ok.map((c) => c.va))];
  if (vas.length === 0) throw new LocateError(spec.id, '没有通过结构校验的候选', candidates);
  if (vas.length > 1) throw new LocateError(spec.id, `通过校验的候选互相矛盾：${vas.join(' / ')}`, candidates);
  const va = Number.parseInt(vas[0]!, 16);
  const method = METHOD_ORDER.find((m) => ok.some((c) => c.method === m))!;
  return {
    va,
    info: {
      va: hexVa(va),
      fileOffset: hexVa(ctx.file.vaToOff(va)),
      method,
      candidates,
      checks: checksByVa.get(va) ?? [],
    },
  };
}
