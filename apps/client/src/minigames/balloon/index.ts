// 七彩气球（落点码 7）的前端模块。
import { BALLOON_SIM, type BalloonState } from '@rich4/shared/minigames';
import type { MinigameClientModule } from '../types';
import BalloonHud from './Hud';
import { createBalloonInput } from './input';
import { BalloonView } from './view';

const mod: MinigameClientModule<BalloonState> = {
  id: 'balloon',
  sim: BALLOON_SIM,
  createView: async (ctx) => new BalloonView(ctx),
  createInput: createBalloonInput,
  Hud: BalloonHud,
  // 原版气球没有结算姿势，这里按分数给一句表现文案
  poseKey: (_s, score) => (score < 20 ? 'pose.low' : score < 60 ? 'pose.mid' : 'pose.high'),
};

export default mod;
