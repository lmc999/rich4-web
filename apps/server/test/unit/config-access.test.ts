// 素材包与访问门禁的配置与启动守卫（docs/design/original-skin.md §3 修正 3）：
// 启用素材包而门禁为 off 时拒绝启动，唯一例外是本机开发的显式开关；没有按 HOST 判定的回环例外。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPasscode, SCRYPT_LIMITS } from '../../src/access/passcode';
import { ConfigError, isLocalhostUrl, isLoopbackHost, loadConfig, REPO_ROOT } from '../../src/config';

const root = mkdtempSync(join(tmpdir(), 'rich4-cfg-'));
const packDir = join(root, 'pack');
const emptyDir = join(root, 'empty');
const SECRET = 'k'.repeat(32);
let HASH = '';

beforeAll(async () => {
  mkdirSync(packDir);
  mkdirSync(emptyDir);
  writeFileSync(join(packDir, 'manifest.json'), '{}');
  HASH = await hashPasscode('passcode-for-config', { N: SCRYPT_LIMITS.minN, r: 8, p: 1 });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const withPack = (env: Record<string, string> = {}) => ({ RICH4_ASSETS_DIR: packDir, ...env });
const ungated = { RICH4_ASSETS_ALLOW_UNGATED: '1' };

describe('config: 素材包与门禁', () => {
  it('默认：没有素材包、门禁 off、ACCESS_TTL_DAYS=30、ACCESS_GRANTS=1、quick 校验', () => {
    const c = loadConfig({});
    expect(c.assets).toEqual({ dir: null, present: false, verify: 'quick', ungated: false });
    expect(c.access).toMatchObject({
      mode: 'off',
      passcodeHash: null,
      secret: null,
      ttlDays: 30,
      grants: true,
      secure: false,
    });
  });

  it('不自动探测仓库里的 rich4-assets/：只认显式 RICH4_ASSETS_DIR', () => {
    expect(loadConfig({}, root).assets.dir).toBeNull();
  });

  it('目录里没有 manifest.json 视为未启用（不触发守卫）', () => {
    const c = loadConfig({ RICH4_ASSETS_DIR: emptyDir });
    expect(c.assets).toMatchObject({ dir: emptyDir, present: false });
  });

  it('启用素材包 + 门禁 off → ConfigError；HOST 为回环地址也不例外', () => {
    expect(() => loadConfig(withPack())).toThrow(ConfigError);
    expect(() => loadConfig(withPack({ HOST: '127.0.0.1' }))).toThrow(/RICH4_ASSETS_ALLOW_UNGATED/);
    expect(() => loadConfig(withPack({ HOST: '::1', PUBLIC_URL: 'http://localhost:3000' }))).toThrow(ConfigError);
  });

  it('显式例外：非生产 + PUBLIC_URL 为 localhost + TRUST_PROXY=0 + RICH4_ASSETS_ALLOW_UNGATED=1', () => {
    for (const url of [
      undefined,
      'http://localhost:5174',
      'http://127.0.0.1:3000',
      'http://[::1]:3000',
      'http://p2.localhost',
    ]) {
      const c = loadConfig(withPack({ ...ungated, ...(url ? { PUBLIC_URL: url } : {}) }));
      expect(c.assets).toMatchObject({ present: true, ungated: true });
    }
  });

  it('显式例外下不设 HOST 时只监听 127.0.0.1；HOST 显式为非回环地址时拒绝（回环 HOST 是附加的必要条件）', () => {
    const c = loadConfig(withPack(ungated));
    expect(c).toMatchObject({ host: '127.0.0.1', assets: { ungated: true } });
    for (const host of ['127.0.0.1', '::1', 'localhost', '127.0.0.2']) {
      expect(loadConfig(withPack({ ...ungated, HOST: host })).host).toBe(host);
    }
    for (const host of ['0.0.0.0', '::', '192.168.1.5']) {
      expect(() => loadConfig(withPack({ ...ungated, HOST: host })), host).toThrow(/HOST=.* 不是回环地址/);
    }
    // 其他情况的默认监听地址不变
    expect(loadConfig({}).host).toBe('0.0.0.0');
    expect(loadConfig({ RICH4_ASSETS_DIR: emptyDir, ...ungated }).host).toBe('0.0.0.0');
    expect(loadConfig(withPack({ ACCESS_MODE: 'invite', ACCESS_SECRET: SECRET })).host).toBe('0.0.0.0');
  });

  it('例外的每个条件缺一不可', () => {
    const prod = { NODE_ENV: 'production', SAVE_HMAC_SECRET: 'h'.repeat(32) };
    expect(() => loadConfig(withPack({ ...ungated, ...prod }))).toThrow(/NODE_ENV=production/);
    expect(() => loadConfig(withPack({ ...ungated, PUBLIC_URL: 'https://rich4.example.com' }))).toThrow(/localhost/);
    expect(() => loadConfig(withPack({ ...ungated, PUBLIC_URL: 'http://localhost.example.com' }))).toThrow(ConfigError);
    expect(() => loadConfig(withPack({ ...ungated, TRUST_PROXY: '1' }))).toThrow(/TRUST_PROXY=1/);
    expect(() => loadConfig(withPack({ RICH4_ASSETS_ALLOW_UNGATED: '0' }))).toThrow(ConfigError);
  });

  it('启用素材包 + 口令或邀请门禁：生产环境也可以启动', () => {
    const prod = { NODE_ENV: 'production', SAVE_HMAC_SECRET: 'h'.repeat(32), TRUST_PROXY: '1' };
    const c = loadConfig(
      withPack({
        ...prod,
        PUBLIC_URL: 'https://rich4.example.com',
        ACCESS_MODE: 'passcode',
        ACCESS_PASSCODE_HASH: HASH,
        ACCESS_SECRET: SECRET,
      }),
    );
    expect(c.assets).toMatchObject({ present: true, ungated: false });
    expect(c.access).toMatchObject({ mode: 'passcode', secret: SECRET, secure: true });
    expect(c.access.passcodeHash).toMatchObject({ N: SCRYPT_LIMITS.minN, r: 8, p: 1 });
    const inv = loadConfig(
      withPack({ ...prod, PUBLIC_URL: 'http://192.168.1.5:8080', ACCESS_MODE: 'invite', ACCESS_SECRET: SECRET }),
    );
    expect(inv.access).toMatchObject({ mode: 'invite', passcodeHash: null, secure: false });
  });

  it('生产环境开启门禁时必须显式设置 PUBLIC_URL（缺省的 http://localhost 必然是漏填，cookie 会不带 Secure）', () => {
    const prod = { NODE_ENV: 'production', SAVE_HMAC_SECRET: 'h'.repeat(32), TRUST_PROXY: '1' };
    expect(() => loadConfig({ ...prod, ACCESS_MODE: 'invite', ACCESS_SECRET: SECRET })).toThrow(/PUBLIC_URL/);
    expect(() =>
      loadConfig(withPack({ ...prod, ACCESS_MODE: 'passcode', ACCESS_PASSCODE_HASH: HASH, ACCESS_SECRET: SECRET })),
    ).toThrow(/必须设置 PUBLIC_URL/);
    // 门禁关闭（没有素材包的部署）不受影响；非生产也不受影响
    expect(loadConfig(prod).publicUrl).toBe('http://localhost:3000');
    expect(loadConfig({ ACCESS_MODE: 'invite', ACCESS_SECRET: SECRET }).access.secure).toBe(false);
    const ok = loadConfig({
      ...prod,
      PUBLIC_URL: 'https://rich4.example.com',
      ACCESS_MODE: 'invite',
      ACCESS_SECRET: SECRET,
    });
    expect(ok.access.secure).toBe(true);
  });

  it('门禁开启时 ADMIN_TOKEN 至少 32 字节；门禁关闭时（只有 /admin/stats）不限', () => {
    const on = { ACCESS_MODE: 'invite', ACCESS_SECRET: SECRET };
    expect(() => loadConfig({ ...on, ADMIN_TOKEN: 'x' })).toThrow(/ADMIN_TOKEN 至少 32 字节/);
    expect(() => loadConfig({ ...on, ADMIN_TOKEN: 'a'.repeat(31) })).toThrow(ConfigError);
    expect(loadConfig({ ...on, ADMIN_TOKEN: 'a'.repeat(32) }).adminToken).toBe('a'.repeat(32));
    expect(loadConfig({ ...on }).adminToken).toBeNull();
    expect(loadConfig({ ADMIN_TOKEN: 'x' }).adminToken).toBe('x');
  });

  it('deploy/.env.example 照抄（只填 SAVE_HMAC_SECRET）：没有素材包的 compose 部署能启动；挂了素材包则要求设门禁', () => {
    const env: Record<string, string> = {};
    for (const line of readFileSync(join(REPO_ROOT, 'deploy/.env.example'), 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) env[m[1]!] = m[2]!;
    }
    expect(env.ACCESS_MODE).toBe('off');
    // docker-compose.yml 的 environment 覆盖
    const compose = {
      ...env,
      SAVE_HMAC_SECRET: 'h'.repeat(48),
      NODE_ENV: 'production',
      PORT: '3000',
      HOST: '0.0.0.0',
      DATA_DIR: join(root, 'data'),
      TRUST_PROXY: '1',
    };
    const c = loadConfig({ ...compose, RICH4_ASSETS_DIR: emptyDir });
    expect(c.access.mode).toBe('off');
    expect(c.assets.present).toBe(false);
    expect(() => loadConfig({ ...compose, RICH4_ASSETS_DIR: packDir })).toThrow(/ACCESS_MODE=passcode 或 invite/);
  });

  it('门禁参数校验：口令模式要哈希，非 off 要 ≥32 字节的 ACCESS_SECRET，哈希格式错误拒绝', () => {
    expect(() => loadConfig({ ACCESS_MODE: 'passcode', ACCESS_SECRET: SECRET })).toThrow(/ACCESS_PASSCODE_HASH/);
    expect(() => loadConfig({ ACCESS_MODE: 'passcode', ACCESS_PASSCODE_HASH: HASH })).toThrow(/ACCESS_SECRET/);
    expect(() => loadConfig({ ACCESS_MODE: 'invite', ACCESS_SECRET: 'short' })).toThrow(/32/);
    expect(() =>
      loadConfig({ ACCESS_MODE: 'passcode', ACCESS_PASSCODE_HASH: 'hunter2', ACCESS_SECRET: SECRET }),
    ).toThrow(/ACCESS_PASSCODE_HASH/);
    expect(() => loadConfig({ ACCESS_MODE: 'open' })).toThrow(ConfigError);
    // .env 里留空等同于未设置
    expect(() => loadConfig({ ACCESS_MODE: 'passcode', ACCESS_PASSCODE_HASH: '', ACCESS_SECRET: SECRET })).toThrow(
      /需要 ACCESS_PASSCODE_HASH/,
    );
    expect(loadConfig({ RICH4_ASSETS_DIR: '', ACCESS_SECRET: '' }).assets.dir).toBeNull();
    // 中文 11 个字 = 33 字节：按字节计
    expect(loadConfig({ ACCESS_MODE: 'invite', ACCESS_SECRET: '大'.repeat(11) }).access.secret).toBe('大'.repeat(11));
  });

  it('ACCESS_TTL_DAYS、ACCESS_GRANTS、RICH4_ASSETS_VERIFY', () => {
    const c = loadConfig({ ACCESS_TTL_DAYS: '7', ACCESS_GRANTS: '0', RICH4_ASSETS_VERIFY: 'full' });
    expect(c.access).toMatchObject({ ttlDays: 7, grants: false });
    expect(c.assets.verify).toBe('full');
    expect(() => loadConfig({ ACCESS_TTL_DAYS: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ RICH4_ASSETS_VERIFY: 'deep' })).toThrow(ConfigError);
  });

  it('isLoopbackHost', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.1.2.3')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('::')).toBe(false);
    expect(isLoopbackHost('10.0.0.1')).toBe(false);
    expect(isLoopbackHost('localhost.example.com')).toBe(false);
  });

  it('isLocalhostUrl', () => {
    expect(isLocalhostUrl('http://localhost')).toBe(true);
    expect(isLocalhostUrl('https://LOCALHOST:8443/x')).toBe(true);
    expect(isLocalhostUrl('http://127.8.9.10')).toBe(true);
    expect(isLocalhostUrl('http://[::1]:1')).toBe(true);
    expect(isLocalhostUrl('http://0.0.0.0:3000')).toBe(false);
    expect(isLocalhostUrl('http://192.168.1.2')).toBe(false);
    expect(isLocalhostUrl('http://localhost.evil.com')).toBe(false);
    expect(isLocalhostUrl('not a url')).toBe(false);
  });
});
