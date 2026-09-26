// 日志文案（design/client.md §10.3）：对全部事件类型穷举；真实自对弈事件都能格式化成完整中文（无残留 {{ }} 与缺键）
import { GAME_EVENT_TYPES, type GameEvent } from '@rich4/shared/engine';
import { eventBudgetMs } from '@rich4/shared/view';
import { beforeAll, describe, expect, it } from 'vitest';
import { initI18n } from '../i18n';
import { tx } from '../i18n/tx';
import { selfPlay } from '../test/selfPlay';
import { HANDLERS } from './handlers';
import { formatEvent, LOG_FORMAT } from './logFormat';
import { formatDate, formatMoney, formatMoneyShort, makeNames, weekdayName } from './names';
import { SOUND_MAP } from './soundMap';

beforeAll(() => {
  initI18n('original');
});

describe('穷举表', () => {
  it('handlers / soundMap / logFormat 覆盖全部事件类型', () => {
    const all = [...GAME_EVENT_TYPES].sort();
    expect(Object.keys(HANDLERS).sort()).toEqual(all);
    expect(Object.keys(SOUND_MAP).sort()).toEqual(all);
    expect(Object.keys(LOG_FORMAT).sort()).toEqual(all);
  });
});

describe('formatEvent', () => {
  it('自对弈事件全部格式化为完整中文', () => {
    const sp = selfPlay({ seed: 7, steps: 300 });
    const map = null;
    let view = sp.initial.view;
    const seen = new Set<string>();
    let lines = 0;
    for (const b of sp.batches) {
      for (const e of b.events) {
        const names = makeNames({ t: tx, view: () => view, map: () => map });
        const line = formatEvent(e as GameEvent, names);
        if (line !== null) {
          lines++;
          expect(line, e.type).not.toMatch(/\{\{|\}\}|events:|log\./);
          expect(line.length).toBeGreaterThan(0);
        }
        seen.add(e.type);
      }
      view = b.view;
    }
    expect(lines).toBeGreaterThan(100);
    expect(seen.has('DICE_ROLLED')).toBe(true);
  });

  it('关键事件的具体文案', () => {
    const sp = selfPlay({ seed: 1, steps: 5 });
    const names = makeNames({ t: tx, view: () => sp.initial.view, map: () => null });
    const dice = { type: 'DICE_ROLLED', seat: 0, dice: [3, 4], steps: 7, forced: false, diceCount: 2 } as GameEvent;
    expect(formatEvent(dice, names)).toBe('孙小美 掷出 3 + 4，前进 7 步');
    const buy = { type: 'LAND_BOUGHT', seat: 1, lot: 'L1', price: 2000 } as GameEvent;
    expect(formatEvent(buy, names)).toBe('阿土伯 以 2,000 元买下 L1');
    const toll = {
      type: 'TOLL_PAID',
      payer: 0,
      owner: 1,
      ally: null,
      amount: 1200,
      allyAmount: 0,
      lots: ['L1'],
      mods: [],
    } as unknown as GameEvent;
    expect(formatEvent(toll, names)).toBe('孙小美 付给 阿土伯 过路费 1,200 元');
    const div = {
      type: 'DIVIDENDS',
      rows: [
        { company: 'C1', seat: 0, amount: 1200 },
        { company: 'C1', seat: 1, amount: -300 },
      ],
    } as GameEvent;
    expect(formatEvent(div, names)).toBe('C1 发放股息：孙小美 +1,200、阿土伯 −300 元');
    const div2 = {
      type: 'DIVIDENDS',
      rows: [
        { company: 'C1', seat: 0, amount: -20000 },
        { company: 'C2', seat: 0, amount: 50000 },
      ],
    } as GameEvent;
    expect(formatEvent(div2, names)).toBe('公司发放股息（2 笔）：C1 孙小美 −20,000、C2 孙小美 +50,000 元');
    const status = { type: 'STATUS_SET', actor: { t: 'seat', seat: 1 }, status: 'insurance', value: 3 } as GameEvent;
    expect(formatEvent(status, names)).toBe('阿土伯：保险 3 天');
    expect(formatEvent({ type: 'TURN_ENDED', actor: { t: 'seat', seat: 0 } } as GameEvent, names)).toBeNull();
    expect(formatEvent({ type: 'SYNC', reason: 'flush' } as GameEvent, names)).toBeNull();
  });

  it('每种事件都有预算（handler 的时长上限）', () => {
    for (const t of GAME_EVENT_TYPES) {
      expect(
        eventBudgetMs({ type: t, path: [1, 2], wheel: null, slot: null, mode: 'played' } as unknown as GameEvent),
      ).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('格式化工具', () => {
  it('金额、日期、星期', () => {
    expect(formatMoney(48800)).toBe('48,800');
    expect(formatMoney(-1200)).toBe('-1,200');
    expect(formatMoney(0)).toBe('0');
    expect(formatMoneyShort(48000)).toBe('4.8万');
    expect(formatMoneyShort(250000)).toBe('25万');
    expect(formatMoneyShort(123456789)).toBe('1.2亿');
    expect(formatMoneyShort(999)).toBe('999');
    expect(formatDate(19980312)).toBe('1998年3月12日');
    expect(weekdayName(4)).toBe('星期四');
    expect(weekdayName(0)).toBe('星期日');
  });
});
