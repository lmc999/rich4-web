/**
 * 需要用户正版文件（original/ 下两个 rich4.exe）；不存在时整组 skip。
 * D2 第二部分：常量锚点两版一致、新闻/命运/魔法屋表与参数、农历表导出、节日 weekday、函数级对比无待复核差异。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runConstants } from '../../src/commands/constants';
import { ExtractContext } from '../../src/context';
import { CodeIndex } from '../../src/exe/code';
import { loadConstantAnchors, resolveConstants } from '../../src/exe/constants';
import { extractEditions, readExe } from '../../src/exe/extract';
import { buildFuncSeeds, funcDiff } from '../../src/exe/funcdiff';
import { stringMapping } from '../../src/exe/insnTransfer';
import { holidaysForMap } from '../../src/exe/mapData';
import type { ExeEdition, ExtractedTables } from '../../src/exe/types';
import { PeFile } from '../../src/pe/scan';
import { REVIEWED_DIFFS } from '../../src/report/versionDiff';

const ctx = new ExtractContext({ logger: { out: () => {}, err: () => {} } });
const available = ['Game/rich4.exe', 'MultiverseJourney/rich4.exe'].every((p) => existsSync(path.join(ctx.srcDir, p)));
const T = { timeout: 120_000 };

describe.skipIf(!available)('D2 第二部分（本机原版 exe）', () => {
  let cached: Record<ExeEdition, ExtractedTables> | null = null;
  const both = async () => {
    cached ??= (await extractEditions(ctx, ['v311', 'v206'])) as Record<ExeEdition, ExtractedTables>;
    return cached;
  };

  it(
    'verify --constants 的判定：两版全部解析、等于期望值、anchors 的 v2.06 VA 不过期、同源乘法链读同一地址',
    T,
    async () => {
      const rep = await runConstants(ctx, loadConstantAnchors());
      expect(rep.editions).toEqual(['v206', 'v311']);
      expect(rep.failed).toEqual([]);
      expect(rep.stale).toEqual([]);
      expect(rep.chainSources.every((c) => c.ok)).toBe(true);
      expect(rep.results.every((r) => r.same === true)).toBe(true);
      const v = Object.fromEntries(rep.results.map((r) => [r.id, r.v206?.value]));
      expect(v).toMatchObject({
        'bomb.fuse': 38,
        'doll.steps': 9,
        'missile.halfWidth': 100,
        'nuke.radiusArg': -1,
        'window.size': 440,
        'window.center': 220,
        'god.respawnDistX': 300,
        'villain.stepsMod': 9,
        'villain.stepsBase': 2,
        'lottery.numbers': 36,
        'lottery.ticket': 1000,
        'bail.jail': [30, 30, 30, 30, 300, 300, 300, 300],
        'loan.days': 90,
        'beggar.almsPI': 1000,
        'news.27.suspendDays': 15,
        'shop.sellRateCard': 0.9,
        'bank.monthlyInterest': 1.1,
        'penguin.playTicks': 150,
        'penguin.itemTotal': 28,
        'penguin.maxScore': 188,
        'balloon.slots': 16,
        'balloon.lanes': 8,
        'balloon.scoreClamp': 999,
        'xicong.playTicks': 360,
        'xicong.bombPct': 30,
        'ai.buyLand.reserveRate': 0.05,
        'ai.buyLand.reserveCap': 7000,
        'ai.bank.lendGateMod': 10,
        'ai.bank.lendCashFloor': 30000,
        'ai.dice.lookahead': 5,
      });
    },
  );

  it(
    '新闻 36 / 命运 37 / 魔法屋 12 × 12：两版表按签名定位、xref 迁移一致；标题、分类、加持类别两版相同',
    T,
    async () => {
      const { v206, v311 } = await both();
      for (const t of [v206, v311]) {
        expect(t.facts.filter((f) => !f.ok && f.level !== 'info')).toEqual([]);
        expect(t.news).toHaveLength(36);
        expect(t.fate).toHaveLength(37);
        expect(t.magic?.conditions).toHaveLength(12);
        expect(t.magic?.effects).toHaveLength(12);
        for (const l of Object.values(t.eventTables!.locate)) expect(l.method).toBe('signature');
        expect(Object.values(t.eventTables!.helpers).every((h) => h !== null)).toBe(true);
      }
      expect(v311.eventTables!.locate.newsHandlers.va).toBe('0x475e24');
      expect(v311.eventTables!.locate.fateHandlers.va).toBe('0x475ef0');
      for (const [id, l] of Object.entries(v206.eventTables!.locate)) {
        const xr = l.candidates.find((c) => c.method === 'xref');
        expect(xr?.accepted, id).toBe(true);
        expect(xr?.va, id).toBe(l.va);
      }
      const shape = (t: ExtractedTables) => ({
        news: t.news!.map((r) => [r.headline, r.category, r.calls, r.params]),
        fate: t.fate!.map((r) => [r.headline, r.fortune, r.calls, r.params, r.variants.map((v) => v.days)]),
        magic: [t.magic!.conditions.map((r) => r.name), t.magic!.effects.map((r) => [r.name, r.calls, r.params])],
      });
      expect(shape(v206)).toEqual(shape(v311));
      const fortune = v311.fate!.map((r) =>
        r.fortune ? `${r.fortune.class}${r.fortune.handlesDouble ? '' : '-'}` : '',
      );
      expect(fortune.filter((x) => x !== '')).toHaveLength(33);
      expect([0, 1, 4, 5].map((k) => fortune[k])).toEqual(['', '', '', '']);
      expect([3, 8, 9, 10, 11, 32].map((k) => fortune[k])).toEqual([
        'penalty-',
        'penalty-',
        'penalty-',
        'misfortune-',
        'misfortune-',
        'misfortune-',
      ]);
      expect(fortune[16]).toBe('penalty');
      expect([20, 21, 22, 25, 27, 28, 29, 31].every((k) => fortune[k] === 'reward')).toBe(true);
      expect(v311.news!.map((r) => r.category)).toEqual([
        0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
      ]);
      expect(v311.fate![33]!.variants.map((v) => v.days)).toEqual([3, 3, 3]);
    },
  );

  it('农历表导出到 tables.v206.json 的 lunar：8401 天、285 个农历月、9 个闰月；春节公历日期抽查', T, async () => {
    const { v206, v311 } = await both();
    expect(v206.lunar.packed).toHaveLength(8401);
    expect(v206.lunar.packed).toEqual(v311.lunar.packed);
    expect(v206.lunar.months).toHaveLength(285);
    expect(v206.lunar.months.filter((m) => m.leap)).toHaveLength(9);
    const cny = (y: number) => v206.lunar.months.find((m) => m.year === y && m.month === 1 && !m.leap)?.solarStart;
    expect([1998, 2000, 2008, 2020].map(cny)).toEqual(['1998-01-28', '2000-02-05', '2008-02-07', '2020-01-25']);
  });

  it('台湾节日：kind 2（五月第 2 个星期日）写 weekday 0；两版相同', T, async () => {
    const { v206, v311 } = await both();
    const h = holidaysForMap(v206, 0);
    expect(h.holidays.filter((x) => x.kind === 2).map((x) => [x.month, x.day, x.weekday])).toEqual([[5, 2, 0]]);
    expect(h.holidays.filter((x) => x.kind !== 2).every((x) => x.weekday === undefined)).toBe(true);
    expect(holidaysForMap(v311, 0)).toEqual(h);
  });

  it('视野投影表（V-E10）：两版相同', T, async () => {
    const { v206, v311 } = await both();
    expect(v206.view?.subcell.data).toEqual(v311.view?.subcell.data);
    expect(v206.view?.cellScreen.data).toEqual(v311.view?.cellScreen.data);
    expect(v206.view?.drawOrder.data).toEqual(v311.view?.drawOrder.data);
  });

  it('函数级对比：种子全部配对；所有非表现层数值差异都已人工复核', T, async () => {
    const { v206, v311 } = await both();
    const a = (await readExe(ctx, 'v311'))!;
    const b = (await readExe(ctx, 'v206'))!;
    const pa = new PeFile(a.bytes, 'v311');
    const pb = new PeFile(b.bytes, 'v206');
    const ca = CodeIndex.build(pa);
    const cb = CodeIndex.build(pb);
    const m = stringMapping(pa, pb);
    const consts = resolveConstants(loadConstantAnchors(), ca, cb, { translate: m.translate });
    const seeds = buildFuncSeeds(
      ca,
      cb,
      v311,
      v206,
      consts.map((c) => ({ id: c.id, v311: c.v311.va, v206: c.v206?.va ?? null })),
    );
    const r = funcDiff(ca, cb, seeds, { translate: m.translate, dstStrings: m.targets, depth: 1 });
    expect(r.paired).toBe(r.seeds);
    const unreviewed = r.results.flatMap((x) => x.diffs).filter((d) => !REVIEWED_DIFFS[d.split(' ')[0]!]);
    expect(unreviewed).toEqual([]);
    const fate = r.results.filter((x) => x.system === 'fate' && !x.propagated);
    expect(fate.every((x) => x.class === 'same')).toBe(true);
  });
});
