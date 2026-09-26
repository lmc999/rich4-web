import { buildMapIndex, buildTestMap, buildTestMapAllKinds, type IndustryKey } from '@rich4/shared/data';
import { describe, expect, it } from 'vitest';
import { INDUSTRY_LOOKS, LANDMARK_STYLES, MAX_HOUSE_LEVEL } from '../game/procedural/building/styles';
import { randomPath, startTiles } from './demoWalk';
import { galleryRows } from './galleryScene';
import { loadMapDef } from './mapSource';

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('galleryRows', () => {
  it('覆盖住宅 0–5 级、全部设施、全部地标与全部行业', () => {
    const items = galleryRows().flatMap((r) => r.items.map((i) => i.spec));
    for (let lv = 0; lv <= MAX_HOUSE_LEVEL; lv++)
      expect(items.some((s) => s.kind === 'house' && s.level === lv)).toBe(true);
    for (const f of ['vacant', 'park', 'gas', 'hotel', 'mall', 'lab'])
      expect(items.some((s) => s.kind === `facility:${f}`)).toBe(true);
    for (const l of LANDMARK_STYLES) expect(items.some((s) => s.kind === `landmark:${l}`)).toBe(true);
    for (const k of Object.keys(INDUSTRY_LOOKS) as IndustryKey[])
      expect(items.some((s) => s.sign === INDUSTRY_LOOKS[k].sign)).toBe(true);
    expect(items.filter((s) => s.kind === 'facility:hotel').map((s) => s.level)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('loadMapDef', () => {
  it('fixture 直接构造且校验无 error', async () => {
    for (const id of ['test', 'test-allkinds'] as const) {
      const m = await loadMapDef(id, () => Promise.reject(new Error('should not fetch')));
      expect(m.source).toBe('fixture');
      expect(m.def.id).toBe(id);
      expect(m.errors).toBe(0);
    }
  });

  it('台湾图：先走 /api/maps，失败时（开发模式）再试 /__dev/maps', async () => {
    const payload = buildTestMap();
    const calls: string[] = [];
    const m = await loadMapDef(
      'taiwan',
      async (url) => {
        calls.push(url);
        if (url.startsWith('/api/')) return { ok: false, status: 502, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => payload };
      },
      true,
    );
    expect(calls).toEqual(['/api/maps/taiwan', '/__dev/maps/taiwan']);
    expect(m.source).toBe('dev-local');
    expect(m.def.tiles).toHaveLength(20);
  });

  it('全部失败时报出每个来源的原因', async () => {
    await expect(
      loadMapDef('taiwan', async () => ({ ok: false, status: 404, json: async () => ({}) }), false),
    ).rejects.toThrow('/api/maps/taiwan → HTTP 404');
    await expect(
      loadMapDef('taiwan', async () => ({ ok: true, status: 200, json: async () => ({ bogus: true }) }), false),
    ).rejects.toThrow(/MapDef schema/);
  });
});

describe('演示行走路径', () => {
  it('沿 link 前进、遵守静态封路、死路折返', () => {
    const def = buildTestMapAllKinds();
    const idx = buildMapIndex(def);
    const rand = lcg(7);
    for (let n = 0; n < 200; n++) {
      const starts = startTiles(def);
      const at = starts[Math.floor(rand() * starts.length)]!;
      const path = randomPath(def, at, null, 1 + Math.floor(rand() * 6), rand);
      for (let i = 1; i < path.length; i++) {
        const from = idx.tile(path[i - 1]!);
        const link = from.links.find((l) => l.to === path[i]);
        expect(link, `${path[i - 1]}→${path[i]}`).toBeDefined();
        expect(link!.blocked).toBe(false);
      }
    }
    // 26 是死路：从 25 走过来后只能掉头
    expect(randomPath(def, 26, 25, 1, rand)).toEqual([26, 25]);
    expect(startTiles(def)).not.toContain(1); // 银行格 noItems
  });
});
