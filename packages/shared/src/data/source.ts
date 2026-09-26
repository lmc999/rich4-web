/**
 * 出处约定（architecture §4「出处」、design/engine.md §14）。
 *
 * data/tables 里的每条记录都实现 Sourced，JSDoc 同时写两类标注：
 *   @source 人可读的出处：exe 版本 + VA、说明书页码、URL、docs/research 章节
 *   @verify extract 核对项，形如 `extract:cards[19].price`（由 `npm run extract -- verify` 检查）
 * 测试断言每条记录至少有 1 个不是 verify 类的来源（hasPrimarySource）。
 * 证据缺失、先按默认值实现的条目在 JSDoc 里标 ⚑，并登记到 docs/VERIFY.md（DEV-12）。
 */
export type Src =
  | { exe: '2.06' | '3.11'; va: string }
  | { manual: number }
  | { url: string }
  | { research: string }
  | { verify: string };

export type Confidence = 'high' | 'medium' | 'low';

export interface Sourced {
  src: Src[];
  confidence: Confidence;
}

export function isVerifySrc(s: Src): s is { verify: string } {
  return 'verify' in s;
}

/** 至少有 1 个非 verify 的来源 */
export function hasPrimarySource(x: Sourced): boolean {
  return x.src.some((s) => !isVerifySrc(s));
}

/** 返回缺少主来源的记录下标（空数组表示全部合格） */
export function findUnsourced(records: readonly Sourced[]): number[] {
  const bad: number[] = [];
  records.forEach((r, i) => {
    if (!hasPrimarySource(r)) bad.push(i);
  });
  return bad;
}
