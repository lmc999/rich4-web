// 主循环用到的动态文案键齐全：系统消息（含 internalError）、错误码、决策种类、表情、托管原因、终局原因、设置选项、
// 原版四张图的地图名与节日名
import { DECISION_KINDS } from '@rich4/shared/engine';
import { EMOTE_IDS, ERROR_CODES, SYSTEM_MSG_KEYS } from '@rich4/shared/net';
import i18next from 'i18next';
import { beforeAll, describe, expect, it } from 'vitest';
import { initI18n } from '.';

beforeAll(() => {
  initI18n('original');
});

const has = (k: string): boolean => i18next.exists(k);

describe('i18n 键', () => {
  it('系统消息、错误码、决策种类、表情', () => {
    for (const k of SYSTEM_MSG_KEYS) expect(has(`hud:system.${k}`), k).toBe(true);
    expect(i18next.t('hud:system.internalError')).toContain('内部错误');
    for (const c of ERROR_CODES) expect(has(`hud:error.${c}`), c).toBe(true);
    for (const k of DECISION_KINDS) expect(has(`hud:waiting.kind.${k}`), k).toBe(true);
    for (const e of EMOTE_IDS) expect(has(`hud:emotes.${e}`), e).toBe(true);
  });

  it('托管 / 暂停原因、终局原因、地图名、计时档位', () => {
    for (const r of ['manual', 'afk', 'disconnect', 'left', 'host', 'all_away']) {
      expect(has(`hud:systemReason.${r}`), r).toBe(true);
    }
    for (const r of ['timeLimit', 'wealthTarget', 'lastStanding', 'noHumansLeft']) {
      expect(has(`hud:over.reason.${r}`), r).toBe(true);
    }
    for (const m of ['taiwan', 'china', 'japan', 'usa', 'test', 'test-allkinds']) {
      expect(has(`lobby:maps.${m}`), m).toBe(true);
    }
    for (const p of ['fast', 'normal', 'slow', 'off']) expect(has(`lobby:timer.${p}`), p).toBe(true);
    for (const p of ['character', 'gentle', 'normal', 'cunning']) expect(has(`lobby:aiPreset.${p}`), p).toBe(true);
    for (const r of ['dissolved', 'kicked', 'idle', 'server']) expect(has(`lobby:closed.${r}`), r).toBe(true);
  });

  it('原版四张图的节日名：各图节日表的有效项全有名字（台湾 24 项里 h12 是停用项，exe 节日表 VA 0x47d6aa）', () => {
    const counts = { taiwan: 24, china: 19, japan: 19, usa: 20 } as const;
    for (const [m, n] of Object.entries(counts)) {
      for (let i = 0; i < n; i++) {
        if (m === 'taiwan' && i === 12) continue;
        expect(has(`events:holiday.${m}.h${i}`), `${m}.h${i}`).toBe(true);
      }
      expect(has(`events:holiday.${m}.h${n}`), `${m}.h${n}`).toBe(false);
    }
  });
});
