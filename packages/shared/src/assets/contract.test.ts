// 素材包契约与其他 shared 模块、守卫脚本的一致性（测试文件豁免分层表，可以跨模块引用）
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHARACTER_IDS, FACILITY_TYPES } from '../data/tables/ids';
import { isErrorCode } from '../net/errors';
import {
  ASSET_OUTPUT_ROOTS,
  ASSET_SCHEMA,
  assetOutputViolation,
  CHARACTER_COUNT,
  CONTENT_TYPE_BY_EXT,
  DERIVED_JSON_SCHEMAS,
  KIND_CONTENT_TYPES,
  normalizeRepoPath,
  SKIN_FACILITY_TYPES,
} from './index';

describe('与 shared 其他模块对齐', () => {
  it('设施类型、角色数与 shared/data 一致', () => {
    expect([...SKIN_FACILITY_TYPES]).toEqual([...FACILITY_TYPES]);
    expect(CHARACTER_COUNT).toBe(CHARACTER_IDS.length);
  });

  it('ErrorCode ACCESS_REQUIRED 已登记', () => {
    expect(isErrorCode('ACCESS_REQUIRED')).toBe(true);
  });

  it('package.json 导出 ./assets', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      exports: Record<string, string>;
    };
    expect(pkg.exports['./assets']).toBe('./src/assets/index.ts');
  });
});

describe('schema 与文件类型', () => {
  it('派生 JSON schema 全部形如 rich4.<name>/<n> 且唯一', () => {
    expect(DERIVED_JSON_SCHEMAS).toEqual(Object.values(ASSET_SCHEMA));
    expect(new Set(DERIVED_JSON_SCHEMAS).size).toBe(DERIVED_JSON_SCHEMAS.length);
    for (const s of DERIVED_JSON_SCHEMAS) expect(s).toMatch(/^rich4\.[a-z]+\/\d+$/);
  });

  it('白名单里没有可执行或可渲染成页面的类型', () => {
    const types = new Set<string>([...Object.values(CONTENT_TYPE_BY_EXT), ...Object.values(KIND_CONTENT_TYPES).flat()]);
    for (const t of types) expect(t).not.toMatch(/html|svg|javascript|ecmascript|xml|text\//);
  });
});

describe('输出位置规则', () => {
  it.each([
    ['rich4-assets'],
    ['rich4-assets/'],
    ['./rich4-assets/sub'],
    ['.cache/rich4-assets'],
    ['.cache/assets-preview'],
  ])('允许 %s', (p) => {
    expect(assetOutputViolation(p)).toBeNull();
  });

  it.each([
    ['apps/client/public/pack'],
    ['apps/server/public'],
    ['packages/shared/src/assets/out'],
    ['rich4-data/assets'],
    ['../outside'],
    ['/abs/rich4-assets'],
    ['rich4-assets/../apps/client/public'],
    ['C:\\rich4-assets'],
    [''],
    ['.'],
  ])('拒绝 %s', (p) => {
    expect(assetOutputViolation(p)).not.toBeNull();
  });

  it('路径规范化', () => {
    expect(normalizeRepoPath('./a//b/./c/../d')).toBe('a/b/d');
    expect(normalizeRepoPath('a/../..')).toBeNull();
    expect(ASSET_OUTPUT_ROOTS).toEqual(['rich4-assets', '.cache']);
    expect(assetOutputViolation('apps/client/public/x')).toContain('apps/*/public');
  });
});
