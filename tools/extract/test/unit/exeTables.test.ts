import { describe, expect, it } from 'vitest';
import { loadTableAnchors } from '../../src/exe/anchors';
import { extractTables, LocateError, locateTable } from '../../src/exe/locate';
import { companyStockChecks, holidaysForMap, KNOWN_NAME_MISMATCHES, stocksForMap } from '../../src/exe/mapData';
import { cardsSpec } from '../../src/exe/tables/cards';
import { findCodeRefs, plausibleOperand, xrefTransfer } from '../../src/exe/xrefTransfer';
import { canonicalJson } from '../../src/io/writeCanonicalJson';
import { Big5StringIndex, PeFile } from '../../src/pe/scan';
import { buildSynthExe, SYNTH_HOLIDAYS } from '../helpers/buildExe';

const hex = (v: number) => `0x${v.toString(16)}`;

describe('exe 表：合成 PE 上的签名定位与解析', () => {
  const x = buildSynthExe({ maps: 2 });
  const t = extractTables(x.bytes, { label: 'synth', edition: 'unknown' });

  it('每张表都用签名唯一定位（没有提示也能找到）', () => {
    expect(t.locate.cards.va).toBe(hex(x.va.cards));
    expect(t.locate.tools.va).toBe(hex(x.va.tools));
    expect(t.locate.characters.va).toBe(hex(x.va.characters));
    expect(t.locate.stocks.va).toBe(hex(x.va.stocks));
    expect(t.locate.holidays.va).toBe(hex(x.va.holidays));
    expect(t.locate.setupFunds.va).toBe(hex(x.va.funds));
    expect(t.locate.setupDays.va).toBe(hex(x.va.days));
    expect(t.locate.setupWealth.va).toBe(hex(x.va.wealth));
    expect(t.locate.facilityLevels.va).toBe(hex(x.va.facility));
    expect(t.locate.lunar.va).toBe(hex(x.va.lunar));
    for (const l of Object.values(t.locate)) expect(l.method).toBe('signature');
  });

  it('卡片 30 项、初始张数和 100；道具库存与价格；角色编号与现金比例', () => {
    expect(t.cards).toHaveLength(30);
    expect(t.cards.reduce((s, c) => s + c.initCount, 0)).toBe(100);
    expect(t.cards[0]).toMatchObject({ id: 1, name: '均富卡', initCount: 1, price: 200 });
    expect([19, 24, 27, 29].map((id) => t.cards[id - 1]!.price)).toEqual([40, 50, 35, 40]);
    expect(t.tools.map((r) => r.stock)).toEqual([10, 10, 10, 10, 10, 10, 10, 10, 0, 0, 0, 0, 0]);
    expect(t.tools.slice(0, 8).map((r) => r.price)).toEqual([15, 30, 25, 25, 80, 150, 100, 30]);
    expect(t.characters.map((c) => c.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(t.characters[0]).toMatchObject({ name: '約 翰 喬', nameNorm: '約翰喬', abilities: 3, cashRatio: 50 });
    expect(t.characters.every((c) => c.restZero)).toBe(true);
  });

  it('股票：2 张图 24 支，名称去空格，价格整数分，波动取最短十进制', () => {
    expect(t.stocks.maps).toBe(2);
    expect(t.stocks.rows).toHaveLength(24);
    const s3 = t.stocks.rows[3]!;
    expect(s3).toMatchObject({
      mapId: 0,
      index: 3,
      name: '台 積 電',
      nameNorm: '台積電',
      price: 180,
      initPriceCents: 18000,
    });
    expect(s3.volatility).toBe(1.6);
    expect(s3.volatilityF32).toBe('3fcccccd');
    expect(t.stocks.rows[1]!.float).toBe(5000);
    expect(t.stocks.rows[12]).toMatchObject({ mapId: 1, index: 0 });
  });

  it('节日：块数 = 股票图数，布局解读与代码用法佐证', () => {
    expect(t.holidays.maps).toBe(2);
    const tw = t.holidays.rows.filter((r) => r.mapId === 0);
    expect(tw).toHaveLength(24);
    expect(tw[12]).toMatchObject({ disabled: true, closed: false, month: 10, day: 31 });
    expect(tw[15]).toMatchObject({ closed: true, giveCard: true, bgmChange: true, picture: 501, bgm: 3 });
    expect(tw[7]).toMatchObject({ kind: 2, month: 5, day: 2, weekday: 0, closed: false });
    expect(tw.filter((r) => r.lunar)).toHaveLength(8);
    expect(t.holidays.rows.filter((r) => r.mapId === 1 && !r.empty)).toHaveLength(3);
    expect(t.holidays.code).toMatchObject({ flags0Tests: [0x80], flags0Cmps: [0], eventTests: [1, 4, 8] });
  });

  it('开局三表与默认档位（静态初值 + 立即数写入）；设施上限；农历表', () => {
    expect(t.setup.funds).toEqual([300000, 200000, 100000, 50000, 30000, 10000]);
    expect(t.setup.defaults.funds).toMatchObject({ var: hex(x.va.idxFunds), index: 1, value: 200000, immWrites: [1] });
    expect(t.setup.defaults.days).toMatchObject({ var: hex(x.va.idxDays), index: 0, value: 0 });
    expect(t.setup.defaults.wealthMultipliers).toMatchObject({ var: hex(x.va.idxWealth), index: 0 });
    expect(t.facilityLevels.max).toEqual([1, 5, 5, 1, 5]);
    expect(t.lunar).toMatchObject({
      days: 400,
      firstLunar: '1997-12-03',
      firstSolar: '1998-01-01',
      lastSolar: '1999-02-04',
    });
    expect(t.lunar.maxDayMonth12).toBe(29);
    // 逐日数据与按月归并（供引擎做农历换算对照）
    expect(t.lunar.packed).toHaveLength(400);
    expect(t.lunar.packed[0]).toBe((1997 << 16) | (12 << 8) | 3);
    expect(t.lunar.months[0]).toEqual({ solarStart: '1998-01-01', year: 1997, month: 12, leap: false, days: 27 });
    expect(t.lunar.months[1]).toEqual({ solarStart: '1998-01-28', year: 1998, month: 1, leap: false, days: 30 });
    expect(t.lunar.months.reduce((s, m) => s + m.days, 0)).toBe(400);
    // edition 为 unknown 时不跑第二阶段
    expect(t.news).toBeNull();
    expect(t.constants).toBeNull();
  });

  it('事实核对全部通过（农历「十二月三十一」按信息项报告）', () => {
    const failed = t.facts.filter((f) => !f.ok);
    expect(failed.map((f) => f.id)).toEqual(['holidays.lunarUnreachable']);
    expect(failed[0]!.level).toBe('info');
  });

  it('确定性：两次抽取 JSON 字节一致', () => {
    const again = extractTables(x.bytes, { label: 'synth', edition: 'unknown' });
    expect(canonicalJson(again)).toBe(canonicalJson(t));
  });

  it('事实核对能发现卡价不符', () => {
    const bad = extractTables(buildSynthExe({ cardPrice19: 30 }).bytes, { label: 'bad' });
    expect(bad.facts.find((f) => f.id === 'cards.disputedPrices')?.ok).toBe(false);
  });
});

describe('exe → MapDef 按图数据', () => {
  const t = extractTables(buildSynthExe({ maps: 1 }).bytes, { label: 'synth', edition: 'v206' });

  it('stocksForMap：12 支、名称去空格、hasCompany 转布尔', () => {
    const s = stocksForMap(t, 0);
    expect(s).toHaveLength(12);
    expect(s[3]).toEqual({
      stock: {
        index: 3,
        hasCompany: false,
        float: 10000,
        initPriceCents: 18000,
        volatility: 1.6,
        volatilityF32: '3fcccccd',
      },
      name: '台積電',
    });
    expect(s[0]!.stock.hasCompany).toBe(true);
    expect(() => stocksForMap(t, 1)).toThrow(/E_EXE_STOCKS/);
  });

  it('holidaysForMap：停用项不输出；kind 2 写 weekday；flagsRaw 打包 flags0 | 事件 << 8 | 星期 << 16', () => {
    const h = holidaysForMap(t, 0);
    expect(h.holidays).toHaveLength(23);
    expect(h.dropped).toEqual([{ slot: 12, reason: 'disabled' }]);
    expect(h.holidays.map((x) => x.slot)).not.toContain(12);
    const xmas = h.holidays.find((x) => x.slot === 15)!;
    expect(xmas).toEqual({
      slot: 15,
      month: 12,
      day: 25,
      kind: 0,
      flagsRaw: 0x0f01,
      closed: true,
      giveCard: true,
      bgm: true,
      lunar: false,
    });
    expect(h.holidays.find((x) => x.slot === 17)).toMatchObject({ lunar: true, bgm: true, flagsRaw: 0x0401 });
    // kind 2（该月第 n 个星期几）写 weekday，其余不带
    expect(h.holidays.find((x) => x.slot === 7)).toMatchObject({ kind: 2, day: 2, weekday: 0, flagsRaw: 0 });
    expect(h.holidays.filter((x) => x.weekday !== undefined).map((x) => x.slot)).toEqual([7]);
    expect(SYNTH_HOLIDAYS).toHaveLength(24);
  });

  it('companyStockChecks：企业引用的股票须 hasCompany 且同名', () => {
    const def = {
      companies: [{ id: 'C1', stockIndex: 1, nameKey: 'c1' }],
      stocks: [
        { index: 0, hasCompany: true, nameKey: 's0' },
        { index: 1, hasCompany: true, nameKey: 's1' },
      ],
      strings: { 'zh-TW': { c1: '臺灣人壽', s0: '中國信託', s1: '臺灣人壽' }, 'zh-CN': {} },
    } as unknown as Parameters<typeof companyStockChecks>[0];
    const r = companyStockChecks(def);
    expect(r[0]).toMatchObject({ ok: true, status: 'OK' });
    expect(r[1]).toMatchObject({ ok: false, status: 'BAD', detail: 'hasCompany 的股票 2 支，企业 1 家' });
  });

  it('companyStockChecks 白名单：大陆 C4「王井府百貨」对股票 2「王府井百貨」为 KNOWN，其余名称不一致仍为 BAD', () => {
    const defOf = (gm: number, cid: string, cname: string, sname: string, stockIndex = 2) =>
      ({
        globalMapId: gm,
        companies: [{ id: cid, stockIndex, nameKey: 'c' }],
        stocks: [{ index: stockIndex, hasCompany: true, nameKey: 's' }],
        strings: { 'zh-TW': { c: cname, s: sname }, 'zh-CN': {} },
      }) as unknown as Parameters<typeof companyStockChecks>[0];
    expect(KNOWN_NAME_MISMATCHES).toHaveLength(1);
    const known = companyStockChecks(defOf(1, 'C4', '王井府百貨', '王府井百貨'))[0]!;
    expect(known).toMatchObject({ status: 'KNOWN', ok: true, company: 'C4', stockIndex: 2 });
    expect(known.detail).toContain('原版名称不一致');
    // 同样的名称出现在别的图、别的企业号、别的股票下标，或名称有任何不同 → BAD
    expect(companyStockChecks(defOf(0, 'C4', '王井府百貨', '王府井百貨'))[0]!.status).toBe('BAD');
    expect(companyStockChecks(defOf(1, 'C3', '王井府百貨', '王府井百貨'))[0]!.status).toBe('BAD');
    expect(companyStockChecks(defOf(1, 'C4', '王井府百貨', '王府井百貨', 1))[0]!.status).toBe('BAD');
    expect(companyStockChecks(defOf(1, 'C4', '玉井府百貨', '王府井百貨'))[0]!.status).toBe('BAD');
    expect(companyStockChecks(defOf(1, 'C4', '上海銀行', '上海银行'))[0]!).toMatchObject({ status: 'BAD', ok: false });
    // 名称一致仍为 OK
    expect(companyStockChecks(defOf(1, 'C4', '王府井百貨', '王府井百貨'))[0]!.status).toBe('OK');
  });
});

describe('xrefTransfer：从参考版本迁移表地址', () => {
  const ref = buildSynthExe({ maps: 2 });
  const dst = buildSynthExe({ maps: 1, dataShift: 0x230 });
  const refFile = new PeFile(ref.bytes, 'ref');
  const dstFile = new PeFile(dst.bytes, 'dst');

  it('代码模式通配地址后唯一命中，迁移结果即目标版本的表 VA', () => {
    for (const k of ['cards', 'tools', 'characters', 'stocks', 'facility', 'lunar', 'funds', 'days'] as const) {
      const r = xrefTransfer(refFile, dstFile, ref.va[k]);
      expect(r.va, k).toBe(dst.va[k]);
      expect(r.agreed).toBe(true);
    }
    const h = xrefTransfer(refFile, dstFile, ref.va.holidays, { span: 12 });
    expect(h.sites.map((s) => s.field)).toEqual([0, 0, 5, 5, 5]);
    expect(h.va).toBe(dst.va.holidays);
  });

  it('extractTables 带参考时 xref 候选与签名一致；缺少引用时 xref 失败但不影响签名', () => {
    const tRef = extractTables(ref.bytes, { label: 'ref', edition: 'v311' });
    const t = extractTables(dst.bytes, { label: 'dst', edition: 'v206', ref: { bytes: ref.bytes, tables: tRef } });
    for (const [id, l] of Object.entries(t.locate)) {
      const xr = l.candidates.find((c) => c.method === 'xref');
      expect(xr?.accepted, id).toBe(true);
      expect(xr?.va, id).toBe(l.va);
    }
    const noLunarRef = buildSynthExe({ maps: 1, dataShift: 0x100, omitLunarRef: true });
    const t2 = extractTables(noLunarRef.bytes, { label: 'x', ref: { bytes: ref.bytes, tables: tRef } });
    expect(t2.locate.lunar.method).toBe('signature');
    expect(t2.locate.lunar.candidates.find((c) => c.method === 'xref')?.va).toBeNull();
  });

  it('引用过滤：前导字节不像操作数的巧合被排除', () => {
    // push ebp; call rel32 的字节恰好拼出映像地址
    const bytes = Uint8Array.from([0x74, 0x09, 0x55, 0xe8, 0x47, 0x00, 0x00, 0x00]);
    expect(plausibleOperand(bytes, 2)).toBe(false);
    expect(plausibleOperand(Uint8Array.from([0xa1, 0, 0, 0, 0]), 1)).toBe(true);
    expect(plausibleOperand(Uint8Array.from([0x8b, 0x0c, 0x85, 0, 0, 0, 0]), 3)).toBe(true);
    expect(plausibleOperand(Uint8Array.from([0xc7, 0x05, 1, 2, 3, 4, 0, 0, 0, 0]), 6)).toBe(true);
    expect(findCodeRefs(refFile, ref.va.cards).length).toBe(1);
  });
});

describe('locateTable：候选互相矛盾或全部失败时报错', () => {
  it('提示指向错误地址 → 该候选不通过校验；签名仍然成功', () => {
    const x = buildSynthExe();
    const file = new PeFile(x.bytes, 'synth');
    const anchors = structuredClone(loadTableAnchors());
    anchors.tables.cards.hint.v311 = hex(x.va.tools);
    const ctx = { file, strings: Big5StringIndex.build(file), edition: 'v311' as const, anchors, located: {} };
    const r = locateTable(cardsSpec, ctx);
    expect(r.info.va).toBe(hex(x.va.cards));
    expect(r.info.candidates.map((c) => [c.method, c.accepted])).toEqual([
      ['signature', true],
      ['hint', false],
    ]);
    anchors.tables.cards.names = ['不存在卡', '也不存在卡'];
    expect(() => locateTable(cardsSpec, ctx)).toThrow(LocateError);
  });
});
