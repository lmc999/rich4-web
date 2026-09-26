// 环境变量：电脑策略选择（RICH4_AI_POLICY）与只在测试模式生效的计时倍率（RICH4_TIMER_SCALE）
import { BasicAiPolicy, OriginalAiPolicy } from '@rich4/shared/ai';
import { describe, expect, it } from 'vitest';
import { aiPolicyOf } from '../../src/app';
import { ConfigError, loadConfig } from '../../src/config';

describe('loadConfig', () => {
  it('默认使用原版 AI；RICH4_AI_POLICY=basic 切回 BasicAiPolicy', () => {
    expect(loadConfig({}).aiPolicy).toBe('original');
    expect(aiPolicyOf(loadConfig({}).aiPolicy)).toBe(OriginalAiPolicy);
    expect(aiPolicyOf(loadConfig({ RICH4_AI_POLICY: 'basic' }).aiPolicy)).toBe(BasicAiPolicy);
    expect(() => loadConfig({ RICH4_AI_POLICY: 'smart' })).toThrow(ConfigError);
  });

  it('RICH4_TIMER_SCALE 只在测试模式下生效，范围 (0, 1]', () => {
    expect(loadConfig({}).timerScale).toBe(1);
    expect(loadConfig({ RICH4_TIMER_SCALE: '0.2' }).timerScale).toBe(1);
    expect(loadConfig({ RICH4_TEST_MODE: '1', RICH4_TIMER_SCALE: '0.2' }).timerScale).toBe(0.2);
    expect(() => loadConfig({ RICH4_TEST_MODE: '1', RICH4_TIMER_SCALE: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ RICH4_TEST_MODE: '1', RICH4_TIMER_SCALE: '2' })).toThrow(ConfigError);
  });
});
