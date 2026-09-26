import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findUnsourced } from '../source';
import { ECON } from './economy';
import {
  AIRLINE_WHEEL,
  FACILITY_CAPS,
  HOTEL_WHEEL,
  INDUSTRIES,
  INDUSTRY,
  INSURANCE_WHEEL,
  industryFee,
  MALL_WHEEL,
  VEHICLE_FEE_FACTOR,
} from './facilities';
import { ITEMS } from './items';

function histogram(slots: readonly number[]): Record<number, number> {
  const h: Record<number, number> = {};
  for (const v of slots) h[v] = (h[v] ?? 0) + 1;
  return h;
}

describe('设施与企业收费表（g_map §4.2–§4.3）', () => {
  it('转盘：旅馆 4/3/2/3、购物中心 1..6 各 2、航空 0..3 为 2/4/4/2、保险 5/3/30/20/15/10', () => {
    expect(HOTEL_WHEEL.slots).toHaveLength(12);
    expect(histogram(HOTEL_WHEEL.slots)).toEqual({ 1: 4, 2: 3, 3: 2, 4: 3 });
    expect(histogram(MALL_WHEEL.slots)).toEqual({ 1: 2, 2: 2, 3: 2, 4: 2, 5: 2, 6: 2 });
    expect(histogram(AIRLINE_WHEEL.slots)).toEqual({ 0: 2, 1: 4, 2: 4, 3: 2 });
    expect(INSURANCE_WHEEL.slots).toEqual([5, 3, 30, 20, 15, 10]);
    expect(findUnsourced([HOTEL_WHEEL, MALL_WHEEL, AIRLINE_WHEEL, INSURANCE_WHEEL])).toEqual([]);
  });

  it('等级上限、交通工具倍率、行业收费方式', () => {
    expect([FACILITY_CAPS.park, FACILITY_CAPS.hotel, FACILITY_CAPS.mall, FACILITY_CAPS.gas, FACILITY_CAPS.lab]).toEqual(
      [1, 5, 5, 1, 5],
    );
    expect([
      VEHICLE_FEE_FACTOR.walk,
      VEHICLE_FEE_FACTOR.moto,
      VEHICLE_FEE_FACTOR.car,
      VEHICLE_FEE_FACTOR.engineer,
    ]).toEqual([0, 1, 2, 4]);
    expect(industryFee(INDUSTRY.AIRLINE)).toBe('airline');
    expect(industryFee(INDUSTRY.ELECTRONICS)).toBe('electronics');
    expect(industryFee(INDUSTRY.INSURANCE)).toBe('insurance');
    expect(industryFee(INDUSTRY.AUTO)).toBe('vehicle');
    expect(industryFee(INDUSTRY.OIL)).toBe('vehicle');
    expect(industryFee(INDUSTRY.CONSTRUCTION)).toBe('construction');
    expect(industryFee(INDUSTRY.SECT)).toBe('sect');
    for (const i of [INDUSTRY.HOTEL, INDUSTRY.BANK, INDUSTRY.DEPT, 8, 9, 99]) expect(industryFee(i)).toBe('none');
    expect(findUnsourced(INDUSTRIES)).toEqual([]);
    expect(findUnsourced([FACILITY_CAPS, VEHICLE_FEE_FACTOR])).toEqual([]);
  });

  it('M4 常数', () => {
    expect(ECON.LOAN_DAYS).toBe(90);
    expect(ECON.DIVIDEND_DAY).toBe(15);
    expect(ECON.LOTTERY_TICKET).toBe(1000);
    expect(ECON.STOCK_LIMIT_PCT).toBe(10);
    expect(ECON.STOCK_HISTORY_DAYS).toBe(144);
    expect(ECON.GAS_PER_STEP).toBe(500);
    expect(ECON.CONSTRUCTION_NO_TARGET_FEE).toBe(1000);
    expect(ECON.RESEARCH_DAYS).toBe(5);
    expect([ECON.SHOP_SHELF_BASE, ECON.SHOP_SHELF_RANGE]).toEqual([6, 10]);
  });

  it('道具 f7（exe 道具表 +7）：[0,1,1,1,0,0,2,0,1,2,1,2,2]', () => {
    expect(ITEMS.map((i) => i.f7)).toEqual([0, 1, 1, 1, 0, 0, 2, 0, 1, 2, 1, 2, 2]);
  });

  const cache = resolve(__dirname, '../../../../../.cache/extract/tables.v206.json');
  it.skipIf(!existsSync(cache))('与 .cache/extract 的 exe 道具表 f7、设施等级上限一致', () => {
    const t = JSON.parse(readFileSync(cache, 'utf8')) as {
      tools?: { id: number; f7: number }[];
      facilityLevels?: { max: number[] };
    };
    if (t.tools) expect(ITEMS.map((i) => i.f7)).toEqual(t.tools.map((x) => x.f7));
    if (t.facilityLevels) {
      expect([
        FACILITY_CAPS.park,
        FACILITY_CAPS.hotel,
        FACILITY_CAPS.mall,
        FACILITY_CAPS.gas,
        FACILITY_CAPS.lab,
      ]).toEqual(t.facilityLevels.max);
    }
  });
});
