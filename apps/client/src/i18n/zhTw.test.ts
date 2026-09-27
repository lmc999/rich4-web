// zh-TW 语言包（原版皮肤 A5）：与 zh-CN 键集完全一致、占位符一致、非空；入库的生成物与 opencc 重新生成的结果一致；
// 转换保护占位符并套用词汇 / 键覆盖表；i18next 切到 zh-TW 后取繁体、缺键回退 zh-CN。
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DECISION_KINDS } from '@rich4/shared/engine';
import { EMOTE_IDS, ERROR_CODES, SYSTEM_MSG_KEYS } from '@rich4/shared/net';
import i18next from 'i18next';
import { Converter } from 'opencc-js/cn2t';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SKIN_PREFS, SKIN_REASONS } from '../skin/types';
import { initI18n, loadZhTw, NAMESPACES, setUiLanguage, uiLanguage, zhCNResources } from '.';
import { zhTWResources } from './locales/zh-TW';
import {
  applyPhrases,
  convertBundle,
  convertText,
  formatLocaleJson,
  type JsonTree,
  leafEntries,
  placeholdersOf,
} from './zhTw';

const here = dirname(fileURLToPath(import.meta.url));
const CN_DIR = join(here, 'locales/zh-CN');
const TW_DIR = join(here, 'locales/zh-TW');
const jsonFiles = (d: string) =>
  readdirSync(d)
    .filter((f) => f.endsWith('.json'))
    .sort();

describe('zh-TW 语言包：键齐全', () => {
  it('文件一一对应', () => {
    expect(jsonFiles(TW_DIR)).toEqual(jsonFiles(CN_DIR));
  });

  it('每个文件的叶子键与 zh-CN 完全相同，值为非空字符串，占位符一致', () => {
    for (const f of jsonFiles(CN_DIR)) {
      const cn = new Map(leafEntries(JSON.parse(readFileSync(join(CN_DIR, f), 'utf8'))));
      const tw = new Map(leafEntries(JSON.parse(readFileSync(join(TW_DIR, f), 'utf8'))));
      expect([...tw.keys()].sort(), f).toEqual([...cn.keys()].sort());
      for (const [k, v] of tw) {
        expect(typeof v, `${f}:${k}`).toBe('string');
        expect((v as string).trim().length, `${f}:${k}`).toBeGreaterThan(0);
        expect(placeholdersOf(v as string), `${f}:${k}`).toEqual(placeholdersOf(cn.get(k) as string));
      }
    }
  });

  it('资源入口覆盖全部命名空间（两套角色名）', () => {
    for (const set of ['original', 'alt'] as const) {
      const tw = zhTWResources(set);
      const cn = zhCNResources(set);
      expect(Object.keys(tw).sort()).toEqual([...NAMESPACES].sort());
      for (const ns of NAMESPACES) {
        const a = leafEntries(tw[ns]).map(([k]) => k);
        const b = leafEntries(cn[ns]).map(([k]) => k);
        expect(a.sort(), `${set}/${ns}`).toEqual(b.sort());
      }
    }
  });

  it('动态键（系统消息、错误码、决策种类、表情、皮肤选项与回退原因）在两种语言里都有，且不依赖回退', () => {
    const cn = zhCNResources('original') as unknown as Record<string, unknown>;
    const tw = zhTWResources('original') as unknown as Record<string, unknown>;
    const get = (res: Record<string, unknown>, key: string): unknown => {
      const [ns, path] = key.split(':') as [string, string];
      return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], res[ns]);
    };
    const keys = [
      ...SYSTEM_MSG_KEYS.map((k) => `hud:system.${k}`),
      ...ERROR_CODES.map((c) => `hud:error.${c}`),
      ...DECISION_KINDS.map((k) => `hud:waiting.kind.${k}`),
      ...EMOTE_IDS.map((e) => `hud:emotes.${e}`),
      ...SKIN_PREFS.map((p) => `hud:settings.skins.${p}`),
      ...SKIN_REASONS.map((r) => `hud:skin.reason.${r}`),
      ...['map-id', 'source', 'geometry'].map((c) => `hud:skin.mismatch.${c}`),
      ...['badPasscode', 'rateLimited', 'grantInvalid', 'network', 'generic'].map((e) => `hud:access.error.${e}`),
    ];
    for (const k of keys) {
      expect(typeof get(cn, k), `zh-CN ${k}`).toBe('string');
      expect(typeof get(tw, k), `zh-TW ${k}`).toBe('string');
    }
    expect(get(tw, 'hud:error.ACCESS_REQUIRED')).toBe('需要通關密語或邀請連結才能進入');
  });

  it('入库的 zh-TW 与 opencc 重新生成的结果一致（改了 zh-CN 要跑 npx tsx scripts/gen-zh-tw.ts）', () => {
    const convert = Converter({ from: 'cn', to: 'twp' });
    for (const f of jsonFiles(CN_DIR)) {
      const ns = f.replace(/\.json$/, '').replace(/\.(original|alt)$/, '');
      const tree = JSON.parse(readFileSync(join(CN_DIR, f), 'utf8')) as JsonTree;
      expect(readFileSync(join(TW_DIR, f), 'utf8'), f).toBe(formatLocaleJson(convertBundle(ns, tree, convert)));
    }
  });
});

describe('转换规则', () => {
  const fakeConvert = (s: string) => s.replace(/简/g, '簡').replace(/门/g, '門');

  it('占位符原样保留，其余部分转换', () => {
    expect(convertText('{{简}}简门{{n, number}}门', fakeConvert)).toBe('{{简}}簡門{{n, number}}門');
  });

  it('词汇覆盖表与键覆盖表', () => {
    expect(applyPhrases('臺灣的訪問口令與口令')).toBe('台灣的通關密語與密語');
    const out = convertBundle('hud', { a: '简', b: { c: '门' } }, fakeConvert, { 'hud:b.c': '覆蓋' });
    expect(out).toEqual({ a: '簡', b: { c: '覆蓋' } });
  });

  it('角色名按台湾正体', () => {
    const names = zhTWResources('original').characters as Record<string, { name: string }>;
    expect(names.sunXiaomei!.name).toBe('孫小美');
    expect(names.madamQian!.name).toBe('錢夫人');
    expect(names.jinBeibei!.name).toBe('金貝貝');
    expect(names.miyamoto!.name).toBe('宮本寶藏');
  });
});

describe('i18next 切换到 zh-TW', () => {
  beforeAll(() => {
    initI18n('original');
  });
  afterAll(async () => {
    await setUiLanguage('zh-CN');
  });

  it('懒加载语言包后取繁体；缺键回退 zh-CN；切回 zh-CN', async () => {
    await loadZhTw();
    await setUiLanguage('zh-TW');
    expect(uiLanguage()).toBe('zh-TW');
    const t = i18next.t as unknown as (k: string, o?: Record<string, unknown>) => string;
    expect(t('hud:settings.title')).toBe('設定');
    expect(t('hud:access.title')).toBe('需要通關密語');
    expect(t('top.turn', { ns: 'hud', n: 3 })).toBe('第 3 回合');
    i18next.addResource('zh-CN', 'hud', 'onlyCn', '只有简体');
    expect(t('hud:onlyCn')).toBe('只有简体');
    await setUiLanguage('zh-CN');
    expect(uiLanguage()).toBe('zh-CN');
    expect(t('hud:settings.title')).toBe('设置');
  });

  it('连续切换只生效最后一次', async () => {
    const a = setUiLanguage('zh-TW');
    const b = setUiLanguage('zh-CN');
    await Promise.all([a, b]);
    expect(uiLanguage()).toBe('zh-CN');
  });
});
