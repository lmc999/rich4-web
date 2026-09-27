// 门禁开启时受保护响应的缓存改写（http/access.ts）：public → private、去掉 immutable、max-age 封顶 30 天；
// 续期 cookie 只附在共享缓存与浏览器都不会复用的响应上
import { describe, expect, it } from 'vitest';
import { cookieSafeCacheControl, gatedCacheControl } from '../../src/http/access';

describe('gatedCacheControl', () => {
  it('public / immutable / s-maxage 去掉，max-age 封顶 30 天，补上 private', () => {
    expect(gatedCacheControl('public, max-age=31536000, immutable')).toBe('private, max-age=2592000');
    expect(gatedCacheControl('public, max-age=60, s-maxage=600')).toBe('private, max-age=60');
    expect(gatedCacheControl('no-cache')).toBe('private, no-cache');
    expect(gatedCacheControl('private, max-age=2592000')).toBe('private, max-age=2592000');
    expect(gatedCacheControl('private, no-cache')).toBe('private, no-cache');
    expect(gatedCacheControl('no-store')).toBe('no-store');
    expect(gatedCacheControl(undefined)).toBe('private, no-cache');
    expect(gatedCacheControl('')).toBe('private, no-cache');
    expect(gatedCacheControl('public')).toBe('private');
    expect(gatedCacheControl('max-age=abc')).toBe('private, max-age=0');
  });

  it('cookieSafeCacheControl：no-store，或 private 且 no-cache', () => {
    expect(cookieSafeCacheControl('no-store')).toBe(true);
    expect(cookieSafeCacheControl('private, no-cache')).toBe(true);
    expect(cookieSafeCacheControl('Private, No-Cache')).toBe(true);
    expect(cookieSafeCacheControl('private, max-age=2592000')).toBe(false);
    expect(cookieSafeCacheControl('no-cache')).toBe(false);
    expect(cookieSafeCacheControl('public, no-cache')).toBe(false);
    expect(cookieSafeCacheControl(undefined)).toBe(false);
  });
});
