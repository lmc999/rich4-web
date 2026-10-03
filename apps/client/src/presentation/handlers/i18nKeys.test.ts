// M6/M7 演出用到的动态文案键齐全：新闻 36 条、命运 37 条、神明台词、被动卡、恶人作案、轰炸、加持、魔法屋、路面物件
import {
  FATE_IDS,
  GOD_KEYS,
  type GodKind,
  MAGIC_CONDITION_IDS,
  MAGIC_EFFECT_IDS,
  NEWS_IDS,
  PASSIVE_CARD_IDS,
  VILLAIN_KINDS,
} from '@rich4/shared/engine';
import i18next from 'i18next';
import { beforeAll, describe, expect, it } from 'vitest';
import { NPC_IDS } from '../../game/actors/figures';
import { initI18n } from '../../i18n';
import { NEWS_CATEGORY } from './events';

beforeAll(() => {
  initI18n('original');
});

const has = (k: string): boolean => i18next.exists(k);

describe('M6/M7 文案键', () => {
  it('新闻：分类与每条的原文标题（原版一两行、只用引擎给的插值键）；逐人行只有 11–13 税与 23 储金红利', () => {
    for (const c of new Set(NEWS_CATEGORY)) expect(has(`news:category.${c}`), `category ${c}`).toBe(true);
    expect(NEWS_CATEGORY).toHaveLength(NEWS_IDS.length);
    const allowed = new Set(['{{lot}}', '{{who}}', '{{amount}}', '{{days}}', '{{stock}}', '{{company}}']);
    for (const id of NEWS_IDS) {
      expect(has(`news:${id}.headline`), `news ${id}`).toBe(true);
      expect(has(`news:${id}.body`), `news ${id}`).toBe(false);
      const h = i18next.getResource('zh-CN', 'news', `${id}.headline`) as string;
      expect(h.split('\n').length, h).toBeLessThanOrEqual(2);
      for (const m of h.match(/\{\{[^{}]*\}\}/g) ?? []) expect(allowed.has(m), `${id} ${m}`).toBe(true);
      expect(has(`news:${id}.row`), `news ${id} row`).toBe([11, 12, 13, 23].includes(id));
    }
  });

  it('命运：每条的标题与原文（原文一两行、不写人名）', () => {
    for (const id of FATE_IDS) {
      expect(has(`fate:${id}.title`), `fate ${id}`).toBe(true);
      expect(has(`fate:${id}.text`), `fate ${id}`).toBe(true);
      const text = i18next.getResource('zh-CN', 'fate', `${id}.text`) as string;
      expect(text.split('\n').length, text).toBeLessThanOrEqual(2);
      expect(text, `fate ${id}`).not.toContain('{{who}}');
    }
  });

  it('神明台词、显灵、离身原因与 NPC 名', () => {
    for (const k of Object.keys(GOD_KEYS).map(Number) as GodKind[]) {
      for (const f of ['name', 'arrive', 'power']) expect(has(`gods:${GOD_KEYS[k]}.${f}`), `${k}.${f}`).toBe(true);
    }
    expect(has('gods:death.summon')).toBe(true);
    for (const e of ['levelUp', 'levelDown', 'seize']) expect(has(`gods:manifest.${e}`)).toBe(true);
    for (const r of ['expired', 'displaced', 'dispelled', 'swept', 'struck', 'bitten', 'bankrupt']) {
      expect(has(`events:godLeave.${r}`), r).toBe(true);
    }
    for (const n of NPC_IDS) expect(has(`gods:npc.${n}`), n).toBe(true);
  });

  it('被动卡、加持、恶人、轰炸、关押、路面物件、魔法屋', () => {
    for (const c of PASSIVE_CARD_IDS) expect(has(`events:passive.${c}`), `passive ${c}`).toBe(true);
    for (const ctx of ['toll', 'fee', 'taxAudit', 'fine', 'frame', 'sleepwalk', 'confine']) {
      expect(has(`events:passiveCtx.${ctx}`), ctx).toBe(true);
      // 嫁祸卡是「转嫁」，不能借用免罪 / 免费的「免去」说明
      expect(has(`events:passiveScapegoat.${ctx}`), `scapegoat ${ctx}`).toBe(true);
    }
    for (const ctx of ['frame', 'sleepwalk', 'generic']) expect(has(`events:passiveRevenge.${ctx}`), ctx).toBe(true);
    // 原版皮肤亮卡的句式（「<名>\n\n使用XX卡」「<名>\n\nXX卡生效！」）
    for (const m of ['use', 'passive', 'fizzle', 'target']) expect(has(`events:popup.cardShow.${m}`), m).toBe(true);
    for (const c of ['reward', 'penalty', 'misfortune']) {
      for (const r of ['high', 'low']) expect(has(`events:blessing.${c}_${r}`), `${c}_${r}`).toBe(true);
    }
    for (const v of VILLAIN_KINDS) expect(has(`events:villain.${v}`), v).toBe(true);
    for (const a of ['stealPoints', 'stealObject', 'robDeposit', 'stealCard', 'extort', 'spySurplus', 'spyToll']) {
      expect(has(`events:villainAction.${a}`), a).toBe(true);
    }
    for (const s of ['missile', 'nuke', 'alien', 'typhoon', 'bomb3x3']) expect(has(`events:strike.${s}`), s).toBe(true);
    for (const w of ['jail', 'hospital', 'away', 'hotel']) expect(has(`events:confine.${w}`), w).toBe(true);
    for (const o of ['roadblock', 'mine', 'bomb', 'gift', 'chest']) expect(has(`items:object.${o}`), o).toBe(true);
    for (const c of MAGIC_CONDITION_IDS) expect(has(`magic:condition.${c}`)).toBe(true);
    for (const e of MAGIC_EFFECT_IDS) expect(has(`magic:effect.${e}.name`)).toBe(true);
    for (const k of ['title', 'conditionLine', 'conditionNobody', 'castTitle']) expect(has(`magic:${k}`), k).toBe(true);
  });
});
