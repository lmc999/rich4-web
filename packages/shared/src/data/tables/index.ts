/**
 * 手录全局数据表的入口（architecture §2 data/tables）。
 * TABLES 的规范化 JSON 做 FNV-1a 64 得到 tablesHash（state.dataRef.tablesHash；读档时不符只告警）。
 * M4 加入 facilities（设施与企业收费表）；M6 加入 gods（神明表）与 combat（对抗常数）；M7 加入 news、fate、magic
 * （新闻 36 条、命运 37 条、魔法屋条件与效果表）。
 */
import { canonicalJson } from '../../util/canonicalJson';
import { fnv1a64 } from '../../util/hash';
import { CARDS } from './cards';
import { CHARACTERS } from './characters';
import { COMBAT } from './combat';
import { ECONOMY } from './economy';
import {
  AIRLINE_WHEEL,
  FACILITY_CAPS,
  HOTEL_WHEEL,
  INDUSTRIES,
  INSURANCE_WHEEL,
  MALL_WHEEL,
  VEHICLE_FEE_FACTOR,
} from './facilities';
import { FATE_TABLE } from './fate';
import { GODS } from './gods';
import { ITEMS } from './items';
import { MAGIC_CONDITIONS, MAGIC_EFFECTS, MAGIC_FLOW } from './magic';
import { NEWS_TABLE } from './news';
import {
  INITIAL_FUND_TABLE,
  START_FUND_SPLIT,
  START_ITEMS,
  START_VEHICLE_TABLE,
  TENURE_MONTHS,
  TENURE_TABLE,
  TIME_LIMIT_TABLE,
  VEHICLE_MAX_DICE,
  WIN_MULTIPLE_TABLE,
} from './setup';

export * from './cards';
export * from './characters';
export * from './combat';
export * from './economy';
export * from './facilities';
export * from './fate';
export * from './gods';
export * from './ids';
export * from './items';
export * from './magic';
export * from './news';
export * from './setup';

export const TABLES = Object.freeze({
  cards: CARDS,
  items: ITEMS,
  characters: CHARACTERS,
  economy: ECONOMY,
  combat: COMBAT,
  gods: GODS,
  news: NEWS_TABLE,
  fate: FATE_TABLE,
  magic: Object.freeze({ conditions: MAGIC_CONDITIONS, effects: MAGIC_EFFECTS, flow: MAGIC_FLOW }),
  facilities: Object.freeze({
    caps: FACILITY_CAPS,
    hotelWheel: HOTEL_WHEEL,
    mallWheel: MALL_WHEEL,
    airlineWheel: AIRLINE_WHEEL,
    insuranceWheel: INSURANCE_WHEEL,
    vehicleFeeFactor: VEHICLE_FEE_FACTOR,
    industries: INDUSTRIES,
  }),
  setup: Object.freeze({
    initialFund: INITIAL_FUND_TABLE,
    tenure: TENURE_TABLE,
    tenureMonths: TENURE_MONTHS,
    timeLimit: TIME_LIMIT_TABLE,
    winMultiple: WIN_MULTIPLE_TABLE,
    vehicle: START_VEHICLE_TABLE,
    vehicleMaxDice: VEHICLE_MAX_DICE,
    startItems: START_ITEMS,
    startFundSplit: START_FUND_SPLIT,
  }),
});

/** FNV-1a 64(规范化 TABLES)，16 位小写 hex；与 data/maps/registry 的 computeTablesHash(TABLES) 相同 */
export const tablesHash: string = fnv1a64(canonicalJson(TABLES));
