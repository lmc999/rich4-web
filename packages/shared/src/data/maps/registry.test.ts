import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../util/canonicalJson';
import { fnv1a64 } from '../../util/hash';
import { DataError } from '../errors';
import { computeMapDataHash, verifyMapDataHash, withDataHash } from './dataHash';
import { buildTestMap, buildTestMapAllKinds } from './fixtures/testMap';
import { computeTablesHash, createRegistry, fixtureRegistry } from './registry';
import type { LandLot, MapDef } from './types';

const { createHash } = (await import(/* @vite-ignore */ 'node:crypto' as string)) as {
  createHash(algorithm: 'sha256'): { update(data: string): { digest(encoding: 'hex'): string } };
};

function errCode(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof DataError ? e.code : 'OTHER_ERROR';
  }
  return 'NO_THROW';
}

/** 递归把对象键反序插入，得到内容相同、键顺序不同的副本 */
function reverseKeys(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(reverseKeys);
  if (x !== null && typeof x === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(x).reverse()) out[k] = reverseKeys((x as Record<string, unknown>)[k]);
    return out;
  }
  return x;
}

describe('mapHash（meta.dataHash）', () => {
  it('= 排除 meta.dataHash 后规范化 JSON 的 sha256，与 node:crypto 一致', () => {
    const def = buildTestMap();
    const { dataHash, ...meta } = def.meta;
    const expected = createHash('sha256')
      .update(canonicalJson({ ...def, meta }))
      .digest('hex');
    expect(dataHash).toBe(expected);
    expect(computeMapDataHash(def)).toBe(expected);
    expect(verifyMapDataHash(def)).toBe(true);
  });

  it('与键顺序和 dataHash 本身无关，内容变化即改变', () => {
    const def = buildTestMap();
    const shuffled = reverseKeys(def) as MapDef;
    expect(computeMapDataHash(shuffled)).toBe(def.meta.dataHash);
    expect(computeMapDataHash({ ...def, meta: { ...def.meta, dataHash: 'x' } })).toBe(def.meta.dataHash);
    (def.lots[0] as LandLot).landPrice += 1;
    expect(verifyMapDataHash(def)).toBe(false);
    expect(withDataHash(def).meta.dataHash).toBe(computeMapDataHash(def));
    expect(buildTestMap().meta.dataHash).not.toBe(buildTestMapAllKinds().meta.dataHash);
  });
});

describe('DataRegistry', () => {
  it('fixtureRegistry 列出两张 fixture', () => {
    const list = fixtureRegistry.listMaps();
    expect(list.map((m) => m.id)).toEqual(['test', 'test-allkinds']);
    expect(list.every((m) => m.fixture)).toBe(true);
    expect(list[0]).toEqual({
      id: 'test',
      mapHash: buildTestMap().meta.dataHash,
      nameKey: 'map.test.name',
      counts: { nodes: 20, lands: 5, facilities: 1, companies: 2, landscapes: 2 },
      fixture: true,
    });
    expect(list[1]!.counts).toEqual({ nodes: 26, lands: 5, facilities: 1, companies: 3, landscapes: 2 });
  });

  it('getMap：按 id 与可选 mapHash 取 MapIndex，不符抛 MAP_UNAVAILABLE', () => {
    const hash = buildTestMapAllKinds().meta.dataHash;
    const ix = fixtureRegistry.getMap('test-allkinds', hash);
    expect(ix.def.id).toBe('test-allkinds');
    expect(fixtureRegistry.getMap('test-allkinds')).toBe(ix);
    expect(errCode(() => fixtureRegistry.getMap('test-allkinds', '0'.repeat(64)))).toBe('MAP_UNAVAILABLE');
    expect(errCode(() => fixtureRegistry.getMap('taiwan'))).toBe('MAP_UNAVAILABLE');
  });

  it('tablesHash = FNV-1a 64(规范化 TABLES)，与键顺序无关', () => {
    expect(fixtureRegistry.tablesHash).toBe(fnv1a64('{}'));
    expect(computeTablesHash({ b: [1, 2], a: 'x' })).toBe(computeTablesHash({ a: 'x', b: [1, 2] }));
    const reg = createRegistry([], { tables: { cards: [{ id: 1, price: 100 }] } });
    expect(reg.tablesHash).toBe(fnv1a64('{"cards":[{"id":1,"price":100}]}'));
    expect(reg.tablesHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('createRegistry 拒绝重复 id 与被篡改的 dataHash', () => {
    expect(errCode(() => createRegistry([buildTestMap(), buildTestMap()]))).toBe('MAP_DUPLICATE');
    const bad = buildTestMap();
    (bad.lots[0] as LandLot).landPrice = 1;
    expect(errCode(() => createRegistry([bad]))).toBe('MAP_HASH_MISMATCH');
    const reg = createRegistry([bad], { verifyHash: false });
    expect(reg.getMap('test').def).toBe(bad);
  });
});
