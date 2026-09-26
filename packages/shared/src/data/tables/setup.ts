/**
 * 开局选项表（总资金 / 地契期限 / 游戏时间 / 胜利倍数 / 交通工具）与开局发放（design/engine.md §5、§14 setup.ts）。
 *
 * @source exe 开局表 VA 0x46cb94（总资金，默认档位 dw_46cb40 = 1 → 200000）
 * @source docs/research/g_arbitration.md §2.h；docs/research/r_rules_map.md §1
 * @verify extract:setup（V-E4：三张表的数值与默认档位）
 */
import type { Sourced, Src } from '../source';
import {
  INITIAL_FUND_OPTIONS,
  type InitialFund,
  ITEM,
  type ItemId,
  START_VEHICLES,
  type StartVehicle,
  TENURE_OPTIONS,
  type Tenure,
  TIME_LIMIT_OPTIONS,
  type TimeLimitDays,
  type Vehicle,
  WIN_MULTIPLE_OPTIONS,
  type WinMultiple,
} from './ids';

export interface SetupTable<T> extends Sourced {
  /** 下拉框顺序 */
  options: readonly T[];
  /** 首次新局的默认档位下标 */
  defaultIndex: number;
}

const SETUP_SRC: Src[] = [
  { exe: '3.11', va: '0x46cb94' },
  { research: 'docs/research/g_arbitration.md §2.h' },
  { research: 'docs/research/r_rules_map.md §1' },
  { verify: 'extract:setup' },
];

/** 总资金：默认第 1 档 = 200000（g_arbitration §2.h；V-E4 / V-R15 待实机复核） */
export const INITIAL_FUND_TABLE: SetupTable<InitialFund> = Object.freeze({
  options: INITIAL_FUND_OPTIONS,
  defaultIndex: 1,
  src: SETUP_SRC,
  confidence: 'medium',
});

/** 地契期限（按日历月加，不夹日：1/31 + 1 个月 = 2/31，永不到期） */
export const TENURE_TABLE: SetupTable<Tenure> = Object.freeze({
  options: TENURE_OPTIONS,
  defaultIndex: 0,
  src: SETUP_SRC,
  confidence: 'high',
});

/** 地契期限对应的月数；unlimited 为 0（tenure 字段写 0 表示无限期） */
export const TENURE_MONTHS = Object.freeze({
  unlimited: 0,
  '2y': 24,
  '1y': 12,
  '6m': 6,
  '3m': 3,
  '1m': 1,
} as const satisfies { readonly [T in Tenure]: number });

/** 游戏时间（天）：0 / 730 / 365 / 182 / 91 / 30 */
export const TIME_LIMIT_TABLE: SetupTable<TimeLimitDays> = Object.freeze({
  options: TIME_LIMIT_OPTIONS,
  defaultIndex: 0,
  src: SETUP_SRC,
  confidence: 'high',
});

/** 胜利条件：资产 ≥ 倍数 × 总资金；0 = 无 */
export const WIN_MULTIPLE_TABLE: SetupTable<WinMultiple> = Object.freeze({
  options: WIN_MULTIPLE_OPTIONS,
  defaultIndex: 0,
  src: SETUP_SRC,
  confidence: 'high',
});

/** 开局交通工具（全员统一） */
export const START_VEHICLE_TABLE: SetupTable<StartVehicle> = Object.freeze({
  options: START_VEHICLES,
  defaultIndex: 0,
  src: SETUP_SRC,
  confidence: 'high',
});

/** 交通工具可选的最多骰子数：步行 1、机车 2、汽车 3、工程车 1（design/engine.md §7.4） */
export const VEHICLE_MAX_DICE = Object.freeze({
  walk: 1,
  moto: 2,
  car: 3,
  engineer: 1,
} as const satisfies { readonly [V in Vehicle]: 1 | 2 | 3 });

/** 装备中的机车 / 汽车对应的道具号（计入 1..8 的共享库存） */
export const VEHICLE_ITEM = Object.freeze({
  walk: null,
  moto: ITEM.MOTORCYCLE,
  car: ITEM.CAR,
  engineer: null,
} as const satisfies { readonly [V in Vehicle]: ItemId | null });

export interface StartItems extends Sourced {
  /** 每位玩家开局各发 1 件 */
  items: readonly ItemId[];
}

/** 开局道具：机器娃娃、路障、地雷、定时炸弹、遥控骰子、机器工人各 1 件（1..8 从共享库存扣） */
export const START_ITEMS: StartItems = Object.freeze({
  items: Object.freeze([
    ITEM.ROBOT_DOLL,
    ITEM.ROADBLOCK,
    ITEM.MINE,
    ITEM.TIME_BOMB,
    ITEM.REMOTE_DICE,
    ITEM.ROBOT_WORKER,
  ]) as readonly ItemId[],
  src: [
    { url: 'https://github.com/mytbk/rich4/blob/master/csrc/game_init.c' },
    { research: 'docs/research/r_rules_map.md §1' },
  ],
  confidence: 'medium',
});

export interface StartFundSplit extends Sourced {
  /** 真人：现金 = 总资金 × humanCashPct / 100，其余进存款 */
  humanCashPct: number;
}

/** 真人现金、存款各半；电脑按角色 cashRatio（characters.ts） */
export const START_FUND_SPLIT: StartFundSplit = Object.freeze({
  humanCashPct: 50,
  src: [{ research: 'docs/research/g_arbitration.md §2.h' }, { research: 'docs/research/r_rules_map.md §1' }],
  confidence: 'high',
});
