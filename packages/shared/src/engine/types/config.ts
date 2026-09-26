/**
 * 对局配置与规则开关（architecture §5.3、§7.1、§16；design/engine.md §1、§5；docs/research/g_arbitration.md）。
 * GameConfig 就是 net 的 RoomSettings.game；开局后只读。
 */
import { VIEW_WINDOW_HALF } from '../../geom/viewWindow';
import type { OverflowMode } from '../../util/int32';
import type {
  CharacterId,
  Controller,
  DateNum,
  InitialFund,
  SeatAiConfig,
  SeatIndex,
  StartVehicle,
  Tenure,
  TimeLimitDays,
  WinMultiple,
} from './ids';

/** 规则开关。PROGRAM = 原版程序行为（默认），MANUAL = 说明书写法；custom 表示逐项改过 */
export interface RuleConfig {
  preset: 'program' | 'manual' | 'custom';
  /** 红卡 / 黑卡：program = 事件字节写法（当天 + 次日各一次，后写覆盖前写）；manual = 3 个开市日，红黑互相抵消（V-R11） */
  redBlack: 'program' | 'manual';
  /** 福神买地：program = 照付全价、投资后多送 1 级；manual = 大福神免费、小福神半价 */
  fortuneGodLand: 'program' | 'manual';
  /** 小穷神过路费倍率 */
  smallPoorToll: 'x1.5' | 'x2';
  /** 工程车：program = 落点别人有建筑的地清到 0 级；manual = 经过和停留都拆 1 级（V-R16） */
  engineeringVehicle: 'program' | 'manual';
  /** 定时炸弹：program = 只影响携带者和所在格；manual3x3 = 半宽 100 的方窗（V-R4） */
  bombBlast: 'program' | 'manual3x3';
  /** 星期日银行休息（V-R6） */
  sundayBankClosed: boolean;
  /** 手牌满 15 张又得卡：autoCheapest = 自动弃最便宜；choose = 弹 DISCARD_CARD（V-R5） */
  handFull: 'autoCheapest' | 'choose';
  /** 神明加持是否也作用于新闻（V-R8） */
  blessingOnNews: boolean;
  /** 送神符能否送走死神（V-R12） */
  deathGodDispellable: boolean;
  /** 命运、新闻的罚款能否用免费卡、嫁祸卡（V-R8） */
  freeCardOnFines: boolean;
  /** 个股停牌天数（V-R11） */
  stockSuspendDays: 15 | 10;
  /** 建设公司董事长免费加盖级数：program = 2（exe 0x41aae8 / 0x41aafc 调用两次，g_map §4.3 裁决）；manual = 1（V-R19） */
  constructionChairmanLevels: 1 | 2;
  /** 卡片、道具目标范围：window = 以使用者为中心的方窗；global = 全图（DEV-04） */
  targetRange: 'window' | 'global';
  /** 方窗半宽（世界坐标），默认 220 */
  windowHalf: number;
  /** 时光机：global = 全场一个锚点（原版）；perSeat = 每座位一个；disabled（DEV-05） */
  timeMachine: 'global' | 'perSeat' | 'disabled';
  /** 金额、点券溢出：saturate（默认，DEV-01）或 wrap（原版） */
  intOverflow: OverflowMode;
  /** 真人全部出局即结束（原版为 true） */
  endWhenNoHumans: boolean;
}

/** 联机适配项（两个预设相同） */
const ONLINE_ADAPT = {
  targetRange: 'window',
  windowHalf: VIEW_WINDOW_HALF,
  timeMachine: 'global',
  intOverflow: 'saturate',
  endWhenNoHumans: true,
} as const satisfies Partial<RuleConfig>;

/** 原版程序行为（默认预设，architecture §7.1） */
export const PROGRAM_RULES: Readonly<RuleConfig> = Object.freeze({
  preset: 'program',
  redBlack: 'program',
  fortuneGodLand: 'program',
  smallPoorToll: 'x1.5',
  engineeringVehicle: 'program',
  bombBlast: 'program',
  sundayBankClosed: false,
  handFull: 'autoCheapest',
  blessingOnNews: false,
  deathGodDispellable: true,
  freeCardOnFines: false,
  stockSuspendDays: 15,
  constructionChairmanLevels: 2,
  ...ONLINE_ADAPT,
});

/** 说明书规则（architecture §7.1 MANUAL 列） */
export const MANUAL_RULES: Readonly<RuleConfig> = Object.freeze({
  preset: 'manual',
  redBlack: 'manual',
  fortuneGodLand: 'manual',
  smallPoorToll: 'x2',
  engineeringVehicle: 'manual',
  bombBlast: 'manual3x3',
  sundayBankClosed: true,
  handFull: 'choose',
  blessingOnNews: true,
  deathGodDispellable: false,
  freeCardOnFines: true,
  stockSuspendDays: 10,
  constructionChairmanLevels: 1,
  ...ONLINE_ADAPT,
});

export const RULE_PRESETS = Object.freeze({ program: PROGRAM_RULES, manual: MANUAL_RULES });

export interface GameConfig {
  /** 'test' | 'test-allkinds' | 'taiwan' | … */
  mapId: string;
  initialFund: InitialFund;
  vehicle: StartVehicle;
  tenure: Tenure;
  /** 0 表示无限 */
  timeLimitDays: TimeLimitDays;
  /** 0 表示无（资产 ≥ 倍数 × 总资金即获胜） */
  winMultiple: WinMultiple;
  /** 服务器传入当天日期；引擎夹到 [START_DATE_MIN, START_DATE_MAX] */
  startDate: DateNum;
  /** skip 相当于原版关闭「動畫過程」：所有人走不玩分支 */
  minigames: 'play' | 'skip';
  rules: RuleConfig;
  /** 只在 RICH4_TEST_MODE 下为 true，这时才接受 SYS_DEBUG */
  debug: boolean;
}

/** 首次新局的默认总资金档位是第 1 档 = 200000（g_arbitration §2.h；V-E4/V-R15 待实机复核） */
export const DEFAULT_INITIAL_FUND: InitialFund = 200000;

export const START_DATE_MIN: DateNum = 19980101;
export const START_DATE_MAX: DateNum = 20100101;

/** 引擎开局时把 startDate 夹到允许范围 */
export function clampStartDate(date: DateNum): DateNum {
  if (!Number.isInteger(date) || date < START_DATE_MIN) return START_DATE_MIN;
  return date > START_DATE_MAX ? START_DATE_MAX : date;
}

/** 大厅的「快速局」预设：1 年、10 倍 */
export const QUICK_GAME_PRESET = Object.freeze({
  timeLimitDays: 365,
  winMultiple: 10,
} as const) satisfies Partial<GameConfig>;

/**
 * 默认对局配置（原版开局默认：步行、地契永久、时间无限、无胜利倍数，总资金 200000）。
 * 每次返回新对象，调用方可以直接修改。
 */
export function defaultGameConfig(mapId: string, startDate: DateNum = START_DATE_MIN): GameConfig {
  return {
    mapId,
    initialFund: DEFAULT_INITIAL_FUND,
    vehicle: 'walk',
    tenure: 'unlimited',
    timeLimitDays: 0,
    winMultiple: 0,
    startDate,
    minigames: 'play',
    rules: { ...PROGRAM_RULES },
    debug: false,
  };
}

/** createGame 的座位入参（2..4 人，seat 与角色不重复） */
export interface PlayerSetup {
  seat: SeatIndex;
  character: CharacterId;
  controller: Controller;
  /** 电脑座位的预设；缺省按角色表（preset 'character'） */
  ai?: SeatAiConfig;
}
