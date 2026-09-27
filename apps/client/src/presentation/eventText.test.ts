// 新闻 / 命运 / 恶人文案参数（eventText）：命运金额的含义、加持结果、天数，与引擎命运表一致
import { fixtureRegistry } from '@rich4/shared/data';
import type { GameView } from '@rich4/shared/view';
import { beforeAll, describe, expect, it } from 'vitest';
import { initI18n } from '../i18n';
import { tx } from '../i18n/tx';
import { eventTextParams, fateShown, newsBody, villainActionText } from './eventText';
import { makeNames } from './names';

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
