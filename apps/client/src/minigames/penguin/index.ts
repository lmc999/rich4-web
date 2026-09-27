// 企鹅挖宝（落点码 6）的前端模块：sim 来自 shared，场景、输入、HUD 在本目录。
import { PENGUIN_SIM, type PenguinState, penguinPose } from '@rich4/shared/minigames';
import type { MinigameClientModule } from '../types';
import PenguinHud from './Hud';
import { createPenguinInput } from './input';
import { PenguinView } from './view';

const POSE_KEYS = ['pose.low', 'pose.mid', 'pose.high'] as const;

const mod: MinigameClientModule<PenguinState> = {
  id: 'penguin',
  sim: PENGUIN_SIM,
  createView: async (ctx) => new PenguinView(ctx),
  createInput: createPenguinInput,
  Hud: PenguinHud,
  poseKey: (s, score) => (s.endReason === 'bomb' ? 'pose.bomb' : POSE_KEYS[penguinPose(score)]),
};

export default mod;
