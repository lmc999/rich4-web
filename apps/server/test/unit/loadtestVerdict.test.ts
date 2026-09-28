import { describe, expect, it } from 'vitest';
import { exitCodeOf, judge, type VerdictInput } from '../../scripts/loadtestVerdict';

/** 一切正常的一轮压测 */
function ok(over: Partial<VerdictInput> = {}): VerdictInput {
  return {
    p99MaxMs: 50,
    serverP99: 33,
    statsError: null,
    failedRooms: 0,
    seqGaps: 0,
    disconnects: 0,
    closedUnexpected: 0,
    ackTimeouts: 0,
    appErrors: 0,
    actErrors: new Map(),
    otherErrors: new Map(),
    setupFailures: new Map(),
    interrupted: false,
    ...over,
  };
}

describe('loadtest 判定（scripts/loadtestVerdict.ts；M11 审查）', () => {
  it('一切正常：PASS，退出码 0；p99 超阈值：FAIL', () => {
    expect(judge(ok())).toEqual({ verdict: 'PASS', reasons: [] });
    expect(exitCodeOf('PASS')).toBe(0);
    const r = judge(ok({ serverP99: 51 }));
    expect(r.verdict).toBe('FAIL');
    expect(r.reasons).toEqual(['服务器事件循环 p99 51ms > 50ms']);
  });

  it('app:error、game:act 的非预期错误码、其余请求出错、再来一局失败都判 FAIL', () => {
    expect(judge(ok({ appErrors: 3 })).verdict).toBe('FAIL');
    const act = judge(ok({ actErrors: new Map([['game:act:INTERNAL', 2]]) }));
    expect(act.verdict).toBe('FAIL');
    expect(act.reasons.join()).toContain('game:act:INTERNAL');
    expect(judge(ok({ otherErrors: new Map([['game:resync:INTERNAL', 1]]) })).verdict).toBe('FAIL');
    const rematch = judge(ok({ setupFailures: new Map([['rematch:room:start:NOT_ALL_READY', 1]]) }));
    expect(rematch.verdict).toBe('FAIL');
    expect(rematch.reasons.join()).toContain('再来一局失败 1 次');
    expect(exitCodeOf('FAIL')).toBe(1);
  });

  it('autoPlay 自己处理的错误码与决策竞态不算功能性错误', () => {
    const errors = new Map([
      ['game:act:INVALID_ACTION', 4],
      ['game:act:RATE_LIMITED', 1],
      ['game:act:STALE_DECISION', 2],
      ['game:act:NOT_YOUR_DECISION', 1],
    ]);
    expect(judge(ok({ actErrors: errors })).verdict).toBe('PASS');
  });

  it('压测中服务器崩溃（意外断线 + 结束时连不上 /admin/stats）判 FAIL 而不是无法判定', () => {
    const r = judge(ok({ serverP99: null, statsError: 'connect ECONNREFUSED 127.0.0.1:3391', disconnects: 2 }));
    expect(r.verdict).toBe('FAIL');
    expect(r.reasons).toEqual(['/admin/stats 读取失败：connect ECONNREFUSED 127.0.0.1:3391', '意外断线 2 次']);
    expect(exitCodeOf(r.verdict)).toBe(1);
  });

  it('功能正常、只缺 p99 读数（/admin/stats 失败或没有 ADMIN_TOKEN）：UNKNOWN，退出码 2', () => {
    const r = judge(ok({ serverP99: null, statsError: 'HTTP 401' }));
    expect(r).toEqual({ verdict: 'UNKNOWN', reasons: ['/admin/stats 读取失败：HTTP 401'] });
    expect(judge(ok({ serverP99: null })).reasons).toEqual(['没有 ADMIN_TOKEN，无法判定事件循环延迟']);
    expect(exitCodeOf('UNKNOWN')).toBe(2);
  });
});
