// 访问门禁的 HTTP 契约：请求体 schema 与邀请链接片段
import { describe, expect, it } from 'vitest';
import {
  ACCESS_GRANT_TOKEN_RE,
  AccessGrantBodySchema,
  AccessLoginBodySchema,
  AccessRedeemBodySchema,
  accessGrantPath,
  parseAccessGrantFragment,
} from './access';
import { ERROR_CODES } from './errors';

const TOKEN = 'A'.repeat(21) + '_-' + 'b'.repeat(20);

describe('net/access', () => {
  it('ACCESS_REQUIRED 是已登记的错误码', () => {
    expect(ERROR_CODES).toContain('ACCESS_REQUIRED');
  });

  it('邀请链接：/r/<room>#g=<token>，片段可以读回；格式不对时为 null', () => {
    expect(ACCESS_GRANT_TOKEN_RE.test(TOKEN)).toBe(true);
    const path = accessGrantPath('482913', TOKEN);
    expect(path).toBe(`/r/482913#g=${TOKEN}`);
    expect(parseAccessGrantFragment(path.slice(path.indexOf('#')))).toBe(TOKEN);
    expect(parseAccessGrantFragment(`x=1&g=${TOKEN}`)).toBe(TOKEN);
    expect(parseAccessGrantFragment('#g=short')).toBeNull();
    expect(parseAccessGrantFragment('#gg=' + TOKEN)).toBeNull();
    expect(parseAccessGrantFragment('')).toBeNull();
  });

  it('请求体 schema 一律 strict', () => {
    expect(AccessLoginBodySchema.safeParse({ passcode: 'x' }).success).toBe(true);
    expect(AccessLoginBodySchema.safeParse({ passcode: '' }).success).toBe(false);
    expect(AccessLoginBodySchema.safeParse({ passcode: 'x'.repeat(257) }).success).toBe(false);
    expect(AccessLoginBodySchema.safeParse({ passcode: 'x', extra: 1 }).success).toBe(false);
    expect(AccessGrantBodySchema.safeParse({ room: '482913' }).success).toBe(true);
    expect(AccessGrantBodySchema.safeParse({ room: '082913' }).success).toBe(false);
    expect(AccessRedeemBodySchema.safeParse({ token: TOKEN }).success).toBe(true);
    expect(AccessRedeemBodySchema.safeParse({ token: `${TOKEN}x` }).success).toBe(false);
  });
});
