/**
 * 压测判定（scripts/loadtest.ts；architecture M11 验证 5）：纯函数，单测见 test/unit/loadtestVerdict.test.ts。
 * - 功能性错误一律 FAIL（退出码 1）：房间没能开局、再来一局失败、seq 缺口、意外断线、意外 room:closed、ack 超时、
 *   服务器推来的 app:error、game:act 的非预期错误码、其余请求的错误、Ctrl-C 提前结束；事件循环 p99 超阈值同样 FAIL。
 * - 读不到 /admin/stats（或没有 ADMIN_TOKEN）只影响 p99 这一项：有功能性错误时照样 FAIL——压测途中服务器崩溃
 *   （断线 + 结束时连不上）正是最该抓到的失败，不能和「环境没配好」共用退出码 2；其他都正常、只缺 p99 读数时才是 UNKNOWN。
 */

export type Verdict = 'PASS' | 'FAIL' | 'UNKNOWN';

/**
 * game:act 的预期错误码：autoPlay 自己会处理（INVALID_ACTION 退回默认意图、RATE_LIMITED 稍后重试），
 * 或者是决策刚被计时器 / 电脑推进掉的正常竞态（STALE_DECISION、NOT_YOUR_DECISION）。其余错误码（INTERNAL 等）算功能性错误。
 */
export const EXPECTED_ACT_ERRORS: ReadonlySet<string> = new Set([
  'INVALID_ACTION',
  'RATE_LIMITED',
  'STALE_DECISION',
  'NOT_YOUR_DECISION',
]);

export interface VerdictInput {
  p99MaxMs: number;
  /** 结束时 /admin/stats 的事件循环 p99；读不到或没有 ADMIN_TOKEN 时为 null */
  serverP99: number | null;
  /** /admin/stats 读取失败的原因；没有 ADMIN_TOKEN 时为 null */
  statsError: string | null;
  failedRooms: number;
  seqGaps: number;
  disconnects: number;
  closedUnexpected: number;
  ackTimeouts: number;
  /** 服务器推来的 app:error 条数 */
  appErrors: number;
  /** game:act 的错误，键为 `game:act:<错误码>` */
  actErrors: ReadonlyMap<string, number>;
  /** 其余请求（建房、入座、开局、resync……）的错误，键为 `<事件>:<错误码>` */
  otherErrors: ReadonlyMap<string, number>;
  /** 建房与再来一局的失败原因（再来一局的键以 `rematch:` 开头） */
  setupFailures: ReadonlyMap<string, number>;
  interrupted: boolean;
}

const sum = (m: ReadonlyMap<string, number>): number => [...m.values()].reduce((a, b) => a + b, 0);
const show = (m: ReadonlyMap<string, number>): string => JSON.stringify(Object.fromEntries(m));

export function judge(i: VerdictInput): { verdict: Verdict; reasons: string[] } {
  const reasons: string[] = [];
  let failed = false;
  const fail = (reason: string): void => {
    failed = true;
    reasons.push(reason);
  };
  if (i.serverP99 === null) {
    reasons.push(i.statsError ? `/admin/stats 读取失败：${i.statsError}` : '没有 ADMIN_TOKEN，无法判定事件循环延迟');
  } else if (i.serverP99 > i.p99MaxMs) {
    fail(`服务器事件循环 p99 ${i.serverP99}ms > ${i.p99MaxMs}ms`);
  }
  if (i.failedRooms > 0) fail(`${i.failedRooms} 个房间没能开局`);
  const rematch = new Map([...i.setupFailures].filter(([k]) => k.startsWith('rematch:')));
  if (rematch.size > 0) fail(`再来一局失败 ${sum(rematch)} 次 ${show(rematch)}（房间停在结算、不再产生负载）`);
  if (i.seqGaps > 0) fail(`seq 缺口 ${i.seqGaps} 次`);
  if (i.disconnects > 0) fail(`意外断线 ${i.disconnects} 次`);
  if (i.closedUnexpected > 0) fail(`房间被意外关闭 ${i.closedUnexpected} 次`);
  if (i.ackTimeouts > 0) fail(`ack 超时 ${i.ackTimeouts} 次`);
  if (i.appErrors > 0) fail(`服务器推送 app:error ${i.appErrors} 次`);
  const act = new Map([...i.actErrors].filter(([k]) => !EXPECTED_ACT_ERRORS.has(k.slice(k.lastIndexOf(':') + 1))));
  if (act.size > 0) fail(`game:act 返回非预期错误 ${sum(act)} 次 ${show(act)}`);
  if (i.otherErrors.size > 0) fail(`其余请求返回错误 ${sum(i.otherErrors)} 次 ${show(i.otherErrors)}`);
  if (i.interrupted) fail('被 Ctrl-C 提前结束');
  return { verdict: failed ? 'FAIL' : i.serverP99 === null ? 'UNKNOWN' : 'PASS', reasons };
}

/** 退出码：0 PASS；1 FAIL；2 无法判定 */
export function exitCodeOf(v: Verdict): 0 | 1 | 2 {
  return v === 'PASS' ? 0 : v === 'FAIL' ? 1 : 2;
}
