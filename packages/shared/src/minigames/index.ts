// @rich4/shared/minigames 入口：契约类型、三个原版小游戏的确定性 sim、bot、重放与日志校验（architecture §5.10）。
// 各游戏的常量、几何与辅助函数在命名空间 penguin / balloon / xicong 下；常用的 sim、bot、state 类型另在顶层导出。
import { BALLOON_BOT } from './balloon/bot';
import { BALLOON_SIM } from './balloon/sim';
import { PENGUIN_BOT } from './penguin/bot';
import { PENGUIN_SIM } from './penguin/sim';
import type { MinigameBot, MinigameId, MinigameSim, MinigameSpec } from './types';
import { XICONG_BOT } from './xicong/bot';
import { XICONG_SIM } from './xicong/sim';

export { BALLOON_BOT } from './balloon/bot';
export * as balloon from './balloon/index';
export { BALLOON_SIM, BALLOON_SPEC, type BalloonState } from './balloon/sim';
export * from './hash';
export { PENGUIN_BOT } from './penguin/bot';
export * as penguin from './penguin/index';
export { PENGUIN_SIM, PENGUIN_SPEC, type PenguinEndReason, type PenguinState, penguinPose } from './penguin/sim';
export * from './replay';
export { idiv, rand15, randMod, randScale } from './rng';
export * from './session';
export * from './types';
export * from './validate';
export { XICONG_BOT } from './xicong/bot';
export * as xicong from './xicong/index';
export { XICONG_SIM, XICONG_SPEC, type XicongState, xicongPose } from './xicong/sim';

/** 三个 sim 的注册表（服务器裁判、客户端宿主、观战共用同一份） */
export const MINIGAME_SIMS: Readonly<Record<MinigameId, MinigameSim>> = Object.freeze({
  penguin: PENGUIN_SIM,
  balloon: BALLOON_SIM,
  xicong: XICONG_SIM,
});

/** AI 代玩（测试、演示、可选玩法；不用于原版结算） */
export const MINIGAME_BOTS: Readonly<Record<MinigameId, MinigameBot>> = Object.freeze({
  penguin: PENGUIN_BOT,
  balloon: BALLOON_BOT,
  xicong: XICONG_BOT,
});

export const MINIGAME_SPECS: Readonly<Record<MinigameId, Readonly<MinigameSpec>>> = Object.freeze({
  penguin: PENGUIN_SIM.spec,
  balloon: BALLOON_SIM.spec,
  xicong: XICONG_SIM.spec,
});
