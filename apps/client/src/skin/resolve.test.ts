// 皮肤判定与回退矩阵（design-draft §3.1、§6.1「皮肤判定矩阵」）：设置、素材包各状态、地图匹配结果、渲染器可用性；
// 条目级回退（缺失、组缺失 / 失败、置信度 guess）

import { describe, expect, it } from 'vitest';
import { syntheticManifest } from '../../../../packages/shared/src/assets/testing/synthetic';
import { checkEntry, mapWarmGroups, type ResolveInput, resolveSkin, usableEntry } from './resolve';
import type { MapCheck, PackState, SkinPref } from './types';

const manifest = syntheticManifest();
const READY: PackState = { status: 'ready', manifest };
const OK: MapCheck = { mapId: 'test', status: 'ok', mismatches: [], group: 'map.test' };

function r(o: Partial<ResolveInput> & { pref?: SkinPref }) {
  return resolveSkin({ pref: 'auto', pack: READY, map: OK, boardRenderer: true, ...o });
}

describe('resolveSkin', () => {
  it('设置为程序化：一律程序化（setting）', () => {
    expect(r({ pref: 'procedural' })).toMatchObject({ skin: 'procedural', board: 'procedural', reason: 'setting' });
  });

  it('素材包不可用：加载中 / 404 / 204 / 非 JSON / 校验失败 / 网络 / 401', () => {
    const cases: [PackState, string][] = [
      [{ status: 'idle' }, 'pack-loading'],
      [{ status: 'loading' }, 'pack-loading'],
      [{ status: 'absent', reason: 'not-found', detail: null }, 'pack-absent'],
      [{ status: 'absent', reason: 'no-content', detail: null }, 'pack-absent'],
      [{ status: 'absent', reason: 'not-json', detail: null }, 'pack-absent'],
      [{ status: 'absent', reason: 'invalid', detail: 'x' }, 'pack-invalid'],
      [{ status: 'absent', reason: 'network', detail: null }, 'pack-error'],
      [{ status: 'absent', reason: 'http', detail: 'HTTP 500' }, 'pack-error'],
      [{ status: 'access-required' }, 'access-required'],
    ];
    for (const [pack, reason] of cases) {
      for (const pref of ['auto', 'original'] as const) {
        const x = r({ pack, pref });
        expect(x, `${pack.status}/${pref}`).toMatchObject({ skin: 'procedural', board: 'procedural', reason });
        expect(x.packId).toBeNull();
      }
    }
  });

  it('素材包正常、不在对局中：原版界面，棋盘无关', () => {
    const x = r({ map: null });
    expect(x).toMatchObject({ skin: 'original', reason: null, boardReason: null, packId: manifest.packId });
  });

  it('全部匹配且原版渲染器可用：原版棋盘', () => {
    expect(r({})).toMatchObject({ skin: 'original', board: 'original', reason: null, boardReason: null });
  });

  it('全部匹配但原版渲染器未注册 / 创建失败：界面原版，棋盘回退程序化', () => {
    expect(r({ boardRenderer: false })).toMatchObject({
      skin: 'original',
      board: 'procedural',
      boardReason: 'renderer-unavailable',
    });
    expect(r({ boardFailed: true })).toMatchObject({
      skin: 'original',
      board: 'procedural',
      boardReason: 'renderer-failed',
    });
  });

  it('地图不匹配 / 缺失 / 分组缺失 / 不含棋盘：auto 整体回退；强制 original 只回退棋盘', () => {
    const mism = { code: 'geometry' as const, expected: 'a', actual: 'b' };
    const cases: [MapCheck, string][] = [
      [{ mapId: 'test', status: 'mismatch', mismatches: [mism], group: 'map.test' }, 'map-mismatch'],
      [{ mapId: 'taiwan', status: 'missing', mismatches: [], group: null }, 'map-missing'],
      [{ mapId: 'test', status: 'group-missing', mismatches: [], group: 'map.test' }, 'group-missing'],
      [{ mapId: 'test', status: 'no-board', mismatches: [], group: 'map.test' }, 'no-board'],
    ];
    for (const [map, reason] of cases) {
      expect(r({ map }), reason).toMatchObject({ skin: 'procedural', board: 'procedural', reason });
      expect(r({ map, pref: 'original' }), reason).toMatchObject({
        skin: 'original',
        board: 'procedural',
        reason: null,
        boardReason: reason,
      });
    }
    expect(r({ map: cases[0]![0] }).mismatches).toEqual([mism]);
  });

  it('运行中加载失败的组 → 分组缺失；地图检查未完成 → 加载中', () => {
    expect(r({ failedGroups: ['map.test'] })).toMatchObject({ skin: 'procedural', reason: 'group-missing' });
    expect(r({ failedGroups: new Set(['char.0']) })).toMatchObject({ skin: 'original', board: 'original' });
    expect(r({ map: null, mapPending: true })).toMatchObject({ skin: 'procedural', reason: 'pack-loading' });
    // 共用棋盘组（board.landmarks）失败：同样缺精灵
    expect(r({ failedGroups: ['board.landmarks'] })).toMatchObject({ skin: 'procedural', reason: 'group-missing' });
  });

  it('预取的组：当前地图组 + 素材包里有的共用棋盘组（旧素材包没有 board.landmarks 时只取地图组）', () => {
    expect(mapWarmGroups(manifest, 'map.test')).toEqual(['map.test']);
    const withShared = { groups: { ...manifest.groups, 'board.landmarks': manifest.groups['map.test']! } };
    expect(mapWarmGroups(withShared, 'map.china')).toEqual(['map.china', 'board.landmarks']);
    expect(mapWarmGroups(null, 'map.test')).toEqual(['map.test']);
  });
});

describe('条目级回退', () => {
  it('存在且置信度足够 → 条目；不存在 → missing', () => {
    expect(checkEntry(manifest, 'char.0.walk')).toMatchObject({ rejected: null });
    expect(checkEntry(manifest, 'nope')).toEqual({ entry: null, rejected: 'missing' });
    expect(usableEntry(null, 'char.0.walk')).toBeNull();
  });

  it('组加载失败或 manifest 里没有该组 → group-missing', () => {
    expect(checkEntry(manifest, 'char.0.walk', new Set(['char.0'])).rejected).toBe('group-missing');
    const broken = { ...manifest, groups: { ...manifest.groups } };
    delete (broken.groups as Record<string, unknown>)['char.0'];
    expect(checkEntry(broken, 'char.0.walk').rejected).toBe('group-missing');
  });

  it('置信度 guess → 默认回退（可显式放行）', () => {
    const e = manifest.entries['char.0.walk']!;
    const guess = {
      ...manifest,
      entries: { ...manifest.entries, 'char.0.walk': { ...e, confidence: 'guess' as const } },
    };
    expect(usableEntry(guess, 'char.0.walk')).toBeNull();
    expect(checkEntry(guess, 'char.0.walk').rejected).toBe('guess');
    expect(usableEntry(guess, 'char.0.walk', undefined, { allowGuess: true })).not.toBeNull();
  });
});
