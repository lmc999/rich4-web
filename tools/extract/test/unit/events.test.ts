import { describe, expect, it } from 'vitest';
import { loadTableAnchors } from '../../src/exe/anchors';
import { CodeIndex } from '../../src/exe/code';
import type { ConstantResult } from '../../src/exe/constants';
import { FATE_SPEC, MAGIC_EFFECT_SPEC, NEWS_SPEC } from '../../src/exe/eventSpec';
import { extractEvents } from '../../src/exe/events';
import { locateTable } from '../../src/exe/locateTable';
import {
  fateHandlersSpec,
  magicConditionsSpec,
  magicCondJumpSpec,
  magicEffectJumpSpec,
  magicEffectsSpec,
  newsCategoriesSpec,
  newsHandlersSpec,
  stripVoice,
} from '../../src/exe/tables/events';
import type { ExtractedTables, LocateContext } from '../../src/exe/types';
import { Big5StringIndex, hexVa, PeFile } from '../../src/pe/scan';
import { renderEventsDoc } from '../../src/report/eventsDoc';
import { buildEventExe } from '../helpers/buildEventExe';

const x = buildEventExe();
const file = new PeFile(x.bytes, 'events');
const ctx: LocateContext = {
  file,
  strings: Big5StringIndex.build(file),
  edition: 'v311',
  anchors: loadTableAnchors(),
  located: {},
};
const loc = <R>(spec: Parameters<typeof locateTable<R>>[0]) => {
  const r = locateTable(spec, ctx);
  ctx.located[spec.id] = r.va;
  return { ...r, parsed: spec.parse(file, r.va, ctx) };
};

describe('新闻 / 命运 / 魔法屋表：签名定位（合成 exe）', () => {
  const news = loc(newsHandlersSpec);
  const cats = loc(newsCategoriesSpec);
  const fate = loc(fateHandlersSpec);
  const eff = loc(magicEffectsSpec);
  const cond = loc(magicConditionsSpec);
  const effJ = loc(magicEffectJumpSpec);
  const condJ = loc(magicCondJumpSpec);

  it('指针表：表[0]/表[1] 入口附近 push 标题串（签名唯一）；分类紧随其后', () => {
    expect(news.va).toBe(x.va.NEWS);
    expect(news.info.method).toBe('signature');
    expect(news.parsed).toEqual(x.news);
    expect(fate.va).toBe(x.va.FATE);
    expect(fate.parsed).toHaveLength(49);
    expect(cats.parsed.byNews.slice(0, 8)).toEqual([0, 0, 0, 0, 0, 0, 1, 1]);
    expect(cats.parsed.names).toHaveLength(6);
  });

  it('魔法屋：效果表按「+12 名称指针」、条件表按包含匹配定位；两张代码节内跳表按代码结构定位', () => {
    expect(eff.va).toBe(x.va.EFFECTS);
    expect(eff.parsed[1]).toMatchObject({ slot: 1, icon: 7, x: 101, y: 201 });
    expect(cond.va).toBe(x.va.CONDS);
    expect(cond.parsed[0]!.voice).toBe(46);
    expect(effJ).toMatchObject({ va: x.va.JT_E, parsed: x.effects });
    expect(condJ).toMatchObject({ va: x.va.JT_C, parsed: x.conds });
    expect(condJ.info.method).toBe('signature');
  });

  it('extractEvents：标题、调用、加持类别与「是否处理加倍」、参数', () => {
    const code = CodeIndex.build(file);
    const helpers = { byName: { print: hexVa(x.va.PRINT!), fortune: hexVa(x.va.FORTUNE!), jail: null } };
    const constants = [
      {
        id: 'news.1.days',
        desc: '',
        kind: 'imm',
        expected: 3,
        confirmed: true,
        verify: 'T',
        v311: { va: '0x1', value: 3, ok: true, extra: null, error: null },
        v206: null,
        same: null,
      },
    ] as ConstantResult[];
    const ev = extractEvents({
      code,
      edition: 'v311',
      newsHandlers: news.parsed,
      newsCategories: cats.parsed,
      fateHandlers: fate.parsed,
      magicEffects: eff.parsed,
      magicConditions: cond.parsed,
      magicEffectJump: effJ.parsed,
      magicCondJump: condJ.parsed,
      helpers,
      constants,
    });
    expect(ev.news).toHaveLength(36);
    expect(ev.news[1]).toMatchObject({
      headline: '測試新聞延長刑期%d天',
      voice: 101,
      category: 0,
      params: { days: 3 },
    });
    expect(ev.news[1]!.calls).toEqual(['print']);
    expect(ev.news[20]).toMatchObject({ category: 4, categoryName: '類別戊', summary: NEWS_SPEC[20]!.summary });
    expect(ev.fate).toHaveLength(37);
    expect(ev.fate[2]!.fortune).toEqual({ class: 'penalty', misfortune: 0, penalty: 1, handlesDouble: true });
    expect(ev.fate[3]!.fortune?.handlesDouble).toBe(false);
    expect(ev.fate[6]!.fortune?.class).toBe('misfortune');
    expect(ev.fate[20]!.fortune?.class).toBe('reward');
    expect(ev.fate[0]!.fortune).toBeNull();
    expect(ev.fate[33]!.variants.map((v) => v.slot)).toEqual([37, 41, 45]);
    expect(ev.magic.effects[0]).toMatchObject({ name: '變賣所有卡片', effect: MAGIC_EFFECT_SPEC[0]!.effect });
    expect(ev.magic.conditions[0]!.name).toBe('測試財產最多');
    expect(ev.magic.effects.every((e) => e.calls.includes('print'))).toBe(true);

    // 入库文档只含自拟概括与数值，不含抽取到的串
    const t = (edition: string) =>
      ({
        edition,
        eventTables: {
          locate: { newsHandlers: news.info },
          helpers: helpers.byName,
          newsCategoryNames: cats.parsed.names,
        },
        news: ev.news,
        fate: ev.fate,
        magic: ev.magic,
      }) as unknown as ExtractedTables;
    const doc = renderEventsDoc({ command: 'test', v311: t('v311'), v206: t('v206'), constants, funcdiff: [] });
    expect(doc).toContain(`| 1 | ${NEWS_SPEC[1]!.summary} | 0 |`);
    expect(doc).toContain(`| 2 | ${FATE_SPEC[2]!.summary} | 罚金类 |`);
    expect(doc).toContain('days = —（v2.06）/ 3（v3.11） 天');
    for (const s of ['測試新聞', '測試命運', '類別甲', '測試財產最多']) expect(doc).not.toContain(s);
  });

  it('stripVoice 去掉「#dddd」语音前缀', () => {
    expect(stripVoice('#0149abc')).toEqual({ text: 'abc', voice: 149 });
    expect(stripVoice('abc')).toEqual({ text: 'abc', voice: null });
  });
});
