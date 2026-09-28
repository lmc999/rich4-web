// 环境变量：电脑策略选择（RICH4_AI_POLICY）、只在测试模式生效的计时倍率（RICH4_TIMER_SCALE）
// 与生产环境下测试模式的本机守卫（RICH4_TEST_MODE + PUBLIC_URL）
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

  it('生产环境开测试模式：只允许显式设置的 PUBLIC_URL 为 localhost（本机验证镜像）', () => {
    const prod = { NODE_ENV: 'production', SAVE_HMAC_SECRET: 's'.repeat(32), RICH4_TEST_MODE: '1' };
    for (const url of [
      'https://localhost:8443',
      'https://localhost:18443',
      'http://127.0.0.1:3000',
      'http://[::1]:8443',
      'https://rich4.localhost',
    ]) {
      const c = loadConfig({ ...prod, PUBLIC_URL: url });
      expect(c.testMode, url).toBe(true);
      expect(c.production).toBe(true);
    }
    // 没设 PUBLIC_URL（缺省值虽是 localhost，生产里多半是漏填）或对外地址一律拒绝，并写清原因
    for (const url of [
      undefined,
      'https://rich4.example.com',
      'https://localhost.example.com',
      'http://192.168.1.10:8080',
      'http://0.0.0.0:3000',
    ]) {
      const env = url === undefined ? prod : { ...prod, PUBLIC_URL: url };
      expect(() => loadConfig(env), String(url)).toThrow(ConfigError);
      expect(() => loadConfig(env), String(url)).toThrow(/RICH4_TEST_MODE=1 只允许用于本机验证/);
    }
    // 生产不开测试模式、或非生产（开发、vitest、E2E 的源码服务器）开测试模式都不受影响
    expect(loadConfig({ ...prod, RICH4_TEST_MODE: '0', PUBLIC_URL: 'https://rich4.example.com' }).testMode).toBe(false);
    expect(loadConfig({ RICH4_TEST_MODE: '1', PUBLIC_URL: 'http://rich4.test' }).testMode).toBe(true);
  });
});
