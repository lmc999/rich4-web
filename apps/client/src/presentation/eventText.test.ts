// 新闻 / 命运 / 恶人文案参数（eventText）：命运金额的含义、加持结果、天数，与引擎命运表一致
import { fixtureRegistry, type MapIndex } from '@rich4/shared/data';
import type { FateId } from '@rich4/shared/engine';
import type { GameView } from '@rich4/shared/view';
import i18next from 'i18next';
import { beforeAll, describe, expect, it } from 'vitest';
import type { SoundQuery } from '../audio/cues';
import { initI18n } from '../i18n';
import { tx } from '../i18n/tx';
import { eventTextParams, fateShown, fateTitle, fateVariantSlot, newsBody, villainActionText } from './eventText';
import { makeNames, pickMapString } from './names';
import { SOUND_MAP } from './soundMap';

beforeAll(() => {
  initI18n('original');
});

const map = fixtureRegistry.getMap('test');
const n = makeNames({ t: tx, view: () => null as GameView | null, map: () => map });

describe('eventText', () => {
  it('新闻参数：地块 / 公司名、股票名、人名、金额千分位', () => {
    const p = eventTextParams(n, { company: 'C1', stock: 0, seat: 1, fine: 10000, days: 5 });
    expect(p.company).not.toBe('C1');
    expect(p.fine).toBe('10,000');
    expect(p.who).toBe('2P');
    expect(p.days).toBe(5);
    expect(newsBody(n, 30, { company: 'C1', stock: 0, fine: 10000 })).toContain('10,000 元');
  });

  it('命运金额：补偿为收入、罚金为支出、贷款与点券带说明', () => {
    expect(fateShown(n, { seat: 0, id: 0, amount: 1500, blessing: null })).toMatchObject({
      amountText: '+1,500',
      amountTone: 'gain',
      tone: 'bad',
    });
    expect(fateShown(n, { seat: 0, id: 14, amount: 3000, blessing: null })).toMatchObject({
      amountText: '-3,000',
      amountTone: 'loss',
    });
    expect(fateShown(n, { seat: 0, id: 2, amount: 10000, blessing: null }).amountText).toBe('贷款 +10,000');
    expect(fateShown(n, { seat: 0, id: 32, amount: 700, blessing: null }).amountText).toBe('+700 点券');
    expect(fateShown(n, { seat: 0, id: 9, amount: 8000, blessing: null }).amountText).toBe('存款 +8,000');
  });

  it('加持：罚金 high 免付（中性）、奖金 low 作废、劫难 low 天数 ×2、不加倍的命运天数不变', () => {
    expect(fateShown(n, { seat: 0, id: 14, amount: 3000, blessing: 'high' })).toMatchObject({
      amountText: '免付（3,000）',
      tone: 'neutral',
      category: 'penalty',
    });
    expect(fateShown(n, { seat: 0, id: 25, amount: 10000, blessing: 'low' }).amountText).toBe('奖金作废（10,000）');
    expect(fateShown(n, { seat: 0, id: 33, amount: null, blessing: 'low' }).params.days).toBe(6);
    expect(fateShown(n, { seat: 0, id: 33, amount: null, blessing: null }).params.days).toBe(3);
    expect(fateShown(n, { seat: 0, id: 3, amount: null, blessing: null }).params.days).toBe(30);
    expect(fateShown(n, { seat: 0, id: 4, amount: null, blessing: null }).params.pct).toBe(10);
    expect(fateShown(n, { seat: 0, id: 5, amount: null, blessing: null }).category).toBeNull();
  });

  it('恶人作案：抢银行没有单一受害人，不出现「无人」', () => {
    const t = villainActionText(n, { kind: 'robber', victim: null, what: 'robDeposit', amount: 12345 });
    expect(t).toContain('12,345');
    expect(t).not.toContain('无人');
  });
});

describe('pickMapString（地图文案按界面语言）', () => {
  const strings = { 'zh-CN': { a: '台北', b: '只有简体' }, 'zh-TW': { a: '臺北', c: '只有繁體' } };
  it('先取界面语言，缺失时回退另一种；都没有为 null；缺省 zh-CN', () => {
    expect(pickMapString(strings, 'a')).toBe('台北');
    expect(pickMapString(strings, 'a', 'zh-TW')).toBe('臺北');
    expect(pickMapString(strings, 'b', 'zh-TW')).toBe('只有简体');
    expect(pickMapString(strings, 'c', 'zh-CN')).toBe('只有繁體');
    expect(pickMapString(strings, 'x', 'zh-TW')).toBeNull();
    expect(pickMapString(undefined, 'a')).toBeNull();
  });

  it('makeNames 的地块名跟随 lang', () => {
    const tw = makeNames({ t: tx, view: () => null, map: () => map, lang: () => 'zh-TW' });
    const lot = map.def.lots[0]!;
    const key = lot.nameKey;
    const twName = map.def.strings['zh-TW'][key] ?? map.def.strings['zh-CN'][key];
    expect(tw.lot(lot.id)).toContain(twName!);
  });
});

describe('命运 33–36 按图文案（exe v2.06 处理函数表 0x473d14 第 37–48 项）', () => {
  /** 把 fixture 地图的 globalMapId 换成 gm（台 0 / 中 1 / 日 2 / 美 3） */
  const onMap = (gm: number | null): MapIndex => ({ ...map, def: { ...map.def, globalMapId: gm } });
  const namesOn = (gm: number | null) => makeNames({ t: tx, view: () => null, map: () => onMap(gm) });
  const fate = (id: FateId) => ({ seat: 0 as const, id, amount: null, blessing: null });

  it('fateVariantSlot：33–36 在 gm 1–3 换成 k + 4·gm；其余命运、台湾与 fixture 不变', () => {
    expect([33, 34, 35, 36].map((k) => fateVariantSlot(k as FateId, 1))).toEqual([37, 38, 39, 40]);
    expect([33, 34, 35, 36].map((k) => fateVariantSlot(k as FateId, 2))).toEqual([41, 42, 43, 44]);
    expect([33, 34, 35, 36].map((k) => fateVariantSlot(k as FateId, 3))).toEqual([45, 46, 47, 48]);
    for (const gm of [0, null, undefined, 4, -1]) expect(fateVariantSlot(33, gm)).toBe(33);
    for (const gm of [1, 2, 3]) expect(fateVariantSlot(32, gm)).toBe(32);
  });

  it('每张图 33–36 的变体文案齐全（标题、正文带 {{who}} / {{days}}）', () => {
    for (const id of [33, 34, 35, 36]) {
      for (const gm of [1, 2, 3]) {
        const k = `fate:${id}.byMap.${gm}`;
        expect(i18next.exists(`${k}.title`), k).toBe(true);
        expect(i18next.exists(`${k}.text`), k).toBe(true);
        const text = i18next.t(`${k}.text` as never) as string;
        expect(text).toContain('{{who}}');
        expect(text).toContain('{{days}}');
      }
    }
  });

  it('fateTitle / fateShown.text 按 globalMapId 选文案；台湾与 fixture 用通用文案；天数不变', () => {
    const base = namesOn(null);
    expect(fateTitle(base, 33)).toBe(tx('fate:33.title'));
    expect(fateTitle(namesOn(0), 33)).toBe(tx('fate:33.title'));
    // 日本 33 =「誘騙未成年少女」、美国 36 =「盜賣國家機密」：与通用文案不同
    expect(fateTitle(namesOn(2), 33)).toBe(tx('fate:33.byMap.2.title'));
    expect(fateTitle(namesOn(2), 33)).not.toBe(fateTitle(base, 33));
    expect(fateTitle(namesOn(3), 36)).toBe(tx('fate:36.byMap.3.title'));
    const shown = fateShown(namesOn(3), fate(36));
    expect(shown.params.days).toBe(9);
    expect(shown.text).toBe(tx('fate:36.byMap.3.text', shown.params));
    expect(shown.text).toContain('9');
    expect(fateShown(base, fate(36)).text).toBe(tx('fate:36.text', fateShown(base, fate(36)).params));
    // 其余命运不分图
    expect(fateTitle(namesOn(1), 12)).toBe(fateTitle(base, 12));
  });

  it('命运语音：33–36 在 gm 1–3 播表项 37–48 的语音（voice-map fate.<下标>）', () => {
    const voice = SOUND_MAP.FATE.voice!;
    const q = (gm: number | null) => ({ map: onMap(gm) }) as unknown as SoundQuery;
    const e = { type: 'FATE', ...fate(33) } as const;
    expect(voice(e as never, q(null))).toEqual([{ k: 'news', key: 'fate.33' }]);
    expect(voice(e as never, q(1))).toEqual([{ k: 'news', key: 'fate.37' }]);
    expect(voice({ ...e, id: 36 } as never, q(3))).toEqual([{ k: 'news', key: 'fate.48' }]);
    expect(voice({ ...e, id: 12 } as never, q(3))).toEqual([{ k: 'news', key: 'fate.12' }]);
  });
});
