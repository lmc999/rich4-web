// 喜从天降（落点码 8）的前端模块。
import { XICONG_SIM, type XicongState, xicongPose } from '@rich4/shared/minigames';
import type { MinigameClientModule } from '../types';
import XicongHud from './Hud';
import { createXicongInput } from './input';
import { XicongView } from './view';

const POSE_KEYS = ['pose.low', 'pose.mid', 'pose.high', 'pose.top'] as const;

const mod: MinigameClientModule<XicongState> = {
  id: 'xicong',
  sim: XICONG_SIM,
  createView: async (ctx) => new XicongView(ctx),
  createInput: createXicongInput,
  Hud: XicongHud,
  // 被炸时原版不播结算姿势
  poseKey: (s, score) => (s.hitBomb ? 'pose.bomb' : POSE_KEYS[xicongPose(score)]),
};

export default mod;
