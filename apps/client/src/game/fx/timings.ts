// 棋盘特效的时长（1x，ms）：Fx 与演出预算测试共用（不依赖 Pixi）
export const FLOAT_MS = 1000;
export const COIN_MS = 560;
export const COIN_COUNT = 8;
export const COIN_STAGGER_MS = 30;
/** 金币飞行总时长：最后一枚出发时间 + 飞行时长 */
export const COIN_FLIGHT_MS = (COIN_COUNT - 1) * COIN_STAGGER_MS + COIN_MS;
export const FLAG_MS = 380;
export const POP_MS = 420;
export const HOP_MS = 260;
