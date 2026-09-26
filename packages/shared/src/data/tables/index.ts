/**
 * 手录全局数据表的入口（architecture §2 data/tables）。
 * TABLES 的规范化 JSON 做 FNV-1a 64 得到 tablesHash（state.dataRef.tablesHash；读档时不符只告警）。
 * M4+ 追加 gods、facilities、companies、news、fate、magic、emotes 时同步加入 TABLES。
 */
import { canonicalJson } from '../../util/canonicalJson';
import { fnv1a64 } from '../../util/hash';
import { CARDS } from './cards';
import { CHARACTERS } from './characters';
import { ECONOMY } from './economy';
import { ITEMS } from './items';
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
export * from './economy';
export * from './ids';
export * from './items';
export * from './setup';

export const TABLES = Object.freeze({
  cards: CARDS,
  items: ITEMS,
  characters: CHARACTERS,
  economy: ECONOMY,
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
