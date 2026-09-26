import { describe, expect, it } from 'vitest';
import { extractTables } from '../../src/exe/locate';
import { compareRules, type ManualTables, resolveVerifyRef } from '../../src/verify/rulesAgainstExe';
import { buildSynthExe } from '../helpers/buildExe';

const t311 = extractTables(buildSynthExe({ maps: 2 }).bytes, { label: 'a', edition: 'v311' });
const t206 = extractTables(buildSynthExe({ maps: 1, dataShift: 0x40 }).bytes, { label: 'b', edition: 'v206' });

function manualFromExe(): ManualTables {
  return {
    cards: t311.cards.map((c) => ({ id: c.id, price: c.price, deckCount: c.initCount, f7: c.f7 })),
    items: t311.tools.map((r) => ({ id: r.id, price: r.price, poolInit: r.stock })),
    characters: t311.characters.map((c) => ({
      id: c.id,
      gender: c.gender === 1 ? 'm' : 'f',
      personality: c.personality,
      loanRatio: c.loanRatio,
      cashRatio: c.cashRatio,
      stockRatio: c.stockRatio,
      color: `#${c.color.slice(2)}`,
    })),
    setup: {
      funds: { options: [...t311.setup.funds], defaultIndex: 1 },
      days: { options: [...t311.setup.days], defaultIndex: 0 },
      wealth: { options: [...t311.setup.wealthMultipliers], defaultIndex: 0 },
    },
    facilityMax: [1, 5, 5, 1, 5],
    verifyRefs: [
      { table: 'cards', ref: 'extract:cards[19].price' },
      { table: 'items', ref: 'extract:items[13]' },
      { table: 'setup', ref: 'extract:setup' },
    ],
    notes: [],
  };
}

describe('verify --tables：手录表 ↔ exe', () => {
  it('手录值与两版一致 → 全部 ok，没有对照清单', () => {
    const rep = compareRules(manualFromExe(), { v206: t206, v311: t311 });
    expect(rep.editions).toEqual(['v206', 'v311']);
    expect(rep.rows.filter((r) => r.status === 'mismatch')).toEqual([]);
    expect(rep.verdicts.map((v) => [v.table, v.manual, v.editions])).toEqual([
      ['cards', 'ok', 'same'],
      ['items', 'ok', 'same'],
      ['characters', 'ok', 'same'],
      ['setup', 'ok', 'same'],
      ['facilityLevels', 'ok', 'same'],
    ]);
    expect(rep.checklist).toEqual([]);
    expect(rep.verifyRefs.every((r) => r.ok)).toBe(true);
  });

  it('不符与缺表：mismatch 计数、exeOnly 字段、对照清单', () => {
    const m = manualFromExe();
    m.cards![18]!.price = 30;
    m.characters![2]!.color = '#ffffff';
    m.facilityMax = null;
    m.items = null;
    const rep = compareRules(m, { v311: t311 });
    const bad = rep.rows.filter((r) => r.status === 'mismatch').map((r) => `${r.table}:${r.key}`);
    expect(bad).toEqual(['cards:19.price', 'characters:2.color']);
    expect(rep.rows.find((r) => r.key === '1.f6')?.status).toBe('exeOnly');
    expect(rep.verdicts.find((v) => v.table === 'items')).toMatchObject({ manual: 'missing', editions: 'single' });
    expect(rep.checklist.map((c) => c.split('：')[0])).toEqual(['items.ts', 'facilities.ts']);
  });

  it('@verify 引用解析', () => {
    expect(resolveVerifyRef('extract:cards[30].price', t311)).toMatchObject({ ok: true });
    expect(resolveVerifyRef('extract:items[13]', t311)).toMatchObject({ ok: true, detail: 'tools#13' });
    expect(resolveVerifyRef('extract:characters[11]', t311).ok).toBe(true);
    expect(resolveVerifyRef('extract:characters[12]', t311).ok).toBe(false);
    expect(resolveVerifyRef('extract:setup', t311).ok).toBe(true);
    expect(resolveVerifyRef('extract:gods[1]', t311).ok).toBe(false);
    expect(resolveVerifyRef('cards[1]', t311).ok).toBe(false);
    expect(resolveVerifyRef('extract:cards[1]', null).ok).toBe(false);
  });
});
