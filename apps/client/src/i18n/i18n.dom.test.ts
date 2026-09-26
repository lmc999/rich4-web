import { TILE_KINDS } from '@rich4/shared/data';
import i18next from 'i18next';
import { afterAll, describe, expect, it } from 'vitest';
import { FACILITY_TYPES, GOD_KEYS } from '../../../../packages/shared/src/data/tables/ids';
import { INDUSTRY_LOOKS, LANDMARK_LOOKS } from '../game/procedural/building/styles';
import { CHARACTER_KEYS } from '../game/procedural/character/defs';
import { CHARACTER_NAMESETS, initI18n, NAMESPACES, zhCNResources } from './index';

/** 递归列出所有叶子键与值 */
function leaves(obj: unknown, prefix = ''): [string, unknown][] {
  if (obj === null || typeof obj !== 'object') return [[prefix, obj]];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
}

describe('i18n 资源', () => {
  const res = zhCNResources('original');

  it('全部命名空间都已注册', () => {
    expect(Object.keys(res).sort()).toEqual([...NAMESPACES].sort());
    for (const ns of NAMESPACES) expect(i18next.hasResourceBundle('zh-CN', ns)).toBe(true);
  });

  it('所有已有文案都是非空字符串', () => {
    for (const [ns, bundle] of Object.entries(res)) {
      for (const [k, v] of leaves(bundle)) {
        if (k === '') continue; // 骨架命名空间为空对象
        expect(typeof v, `${ns}:${k}`).toBe('string');
        expect((v as string).trim().length, `${ns}:${k}`).toBeGreaterThan(0);
      }
    }
  });

  it('角色名：original 与 alt 键集相同，覆盖 12 个角色，且 alt 名字全部不同于原作', () => {
    const orig = CHARACTER_NAMESETS.original as Record<string, { name: string; tag: string }>;
    const alt = CHARACTER_NAMESETS.alt as Record<string, { name: string; tag: string }>;
    expect(Object.keys(orig).sort()).toEqual([...CHARACTER_KEYS].sort());
    expect(Object.keys(alt).sort()).toEqual([...CHARACTER_KEYS].sort());
    for (const k of CHARACTER_KEYS) {
      expect(orig[k]!.name).not.toBe(alt[k]!.name);
      expect(orig[k]!.tag).toBe(alt[k]!.tag);
    }
    expect(orig.sunXiaomei!.name).toBe('孙小美');
    expect(orig.atubo!.name).toBe('阿土伯');
  });

  it('棋盘用到的动态键齐全：格子种类、行业、设施、地标、神明', () => {
    const t = i18next.t as unknown as (k: string) => string;
    for (const k of TILE_KINDS) expect(i18next.exists(`tiles:kind.${k}`), k).toBe(true);
    for (const k of Object.keys(INDUSTRY_LOOKS)) expect(i18next.exists(`tiles:industry.${k}`), k).toBe(true);
    for (const k of FACILITY_TYPES) expect(i18next.exists(`tiles:facility.${k}`), k).toBe(true);
    for (const k of ['hospital', 'jail', 'scenery']) expect(i18next.exists(`tiles:landmark.${k}`), k).toBe(true);
    for (const k of Object.values(GOD_KEYS)) expect(i18next.exists(`gods:${k}.name`), k).toBe(true);
    for (const k of ['ui:board.forSale', 'ui:board.forLease']) expect(i18next.exists(k), k).toBe(true);
    expect(t('tiles:kind.xicong')).toBe('喜从天降');
    expect(Object.keys(LANDMARK_LOOKS).length).toBeGreaterThan(0);
  });

  it('插值与默认命名空间', () => {
    expect(i18next.t('room.title', { code: 'X1' })).toBe('房间 X1');
    expect(i18next.t('dev.map.rotation', { n: 2 })).toBe('方向 2/4');
  });

  it('VITE_NAMESET=alt 时整体换成虚构名', () => {
    initI18n('alt');
    expect((i18next.t as unknown as (k: string) => string)('characters:sunXiaomei.name')).toBe(
      (CHARACTER_NAMESETS.alt as Record<string, { name: string }>).sunXiaomei!.name,
    );
  });

  afterAll(() => {
    initI18n('original');
  });
});
