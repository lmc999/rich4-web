import { describe, expect, it } from 'vitest';
import { ExitCode, ExtractError } from '../../src/context';
import { MAP_NAMES, toZhCN } from '../../src/map/i18n';
import { allMapKeys, MAP_KEYS, resolveMapKey, resolveMapKeys } from '../../src/map/pack';

const caught = (f: () => unknown): ExtractError => {
  try {
    f();
  } catch (e) {
    if (e instanceof ExtractError) return e;
    throw e;
  }
  throw new Error('没有抛错');
};

describe('地图键 MAP_KEYS / resolveMapKey', () => {
  it('四张图按 gm 顺序：taiwan 0、china 1、japan 2、usa 3', () => {
    expect(MAP_KEYS).toEqual({ taiwan: 0, china: 1, japan: 2, usa: 3 });
    expect(allMapKeys()).toEqual([
      { key: 'taiwan', gm: 0 },
      { key: 'china', gm: 1 },
      { key: 'japan', gm: 2 },
      { key: 'usa', gm: 3 },
    ]);
  });

  it('按键名或 gm 数字解析', () => {
    expect(resolveMapKey('china')).toEqual({ key: 'china', gm: 1 });
    expect(resolveMapKey('1')).toEqual({ key: 'china', gm: 1 });
    expect(resolveMapKey('3')).toEqual({ key: 'usa', gm: 3 });
    expect(resolveMapKey('taiwan')).toEqual({ key: 'taiwan', gm: 0 });
    expect(resolveMapKeys('japan')).toEqual([{ key: 'japan', gm: 2 }]);
  });

  it('all 返回全部四张图；需要单张图的地方拒绝 all', () => {
    expect(resolveMapKeys('all').map((m) => m.key)).toEqual(['taiwan', 'china', 'japan', 'usa']);
    const e = caught(() => resolveMapKey('all'));
    expect(e.code).toBe('E_ARGS');
    expect(e.message).toContain('只能指定一张图');
  });

  it('未知键 / 越界 gm → E_ARGS，报错列出四个键；缺少 --map → 缺少输入', () => {
    for (const v of ['mars', '4', 'Taiwan', '']) {
      const e = caught(() => resolveMapKeys(v));
      expect(e.code, v).toBe('E_ARGS');
      expect(e.exitCode).toBe(ExitCode.STRUCTURE);
      expect(e.message).toContain('taiwan(0), china(1), japan(2), usa(3)');
      expect(e.message).toContain('all');
    }
    const e = caught(() => resolveMapKeys(undefined));
    expect(e.exitCode).toBe(ExitCode.MISSING_INPUT);
    expect(e.message).toContain('taiwan|china|japan|usa|all');
  });

  it('地图名：每个键都有；台湾一项不变（进入 dataHash），zh-CN 由 opencc 生成', () => {
    expect(Object.keys(MAP_NAMES).sort()).toEqual(Object.keys(MAP_KEYS).sort());
    expect(MAP_NAMES.taiwan).toBe('台灣');
    expect(Object.fromEntries(Object.entries(MAP_NAMES).map(([k, v]) => [k, toZhCN(v)]))).toEqual({
      taiwan: '台湾',
      china: '中国大陆',
      japan: '日本',
      usa: '美国',
    });
  });
});
