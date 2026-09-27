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
  it('新闻：分类与每条的标题 / 内文（标题 ≤ 15 字、不带插值）', () => {
    for (const c of new Set(NEWS_CATEGORY)) expect(has(`news:category.${c}`), `category ${c}`).toBe(true);
    expect(NEWS_CATEGORY).toHaveLength(NEWS_IDS.length);
    for (const id of NEWS_IDS) {
      expect(has(`news:${id}.headline`), `news ${id}`).toBe(true);
      expect(has(`news:${id}.body`), `news ${id}`).toBe(true);
      const h = i18next.t(`news:${id}.headline` as never) as string;
      expect([...h].length, h).toBeLessThanOrEqual(15);
      expect(h).not.toContain('{{');
    }
  });

  it('命运：每条的标题与内容', () => {
    for (const id of FATE_IDS) {
      expect(has(`fate:${id}.title`), `fate ${id}`).toBe(true);
      expect(has(`fate:${id}.text`), `fate ${id}`).toBe(true);
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
    }
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
