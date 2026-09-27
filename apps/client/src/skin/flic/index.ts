// 浏览器端 FLC：解码器、播放器与时长适配（原版皮肤 A5）

export { FlcDecoder, FlcError, type FlcFile, flcFrameDelay, parseFlc } from './FlcDecoder';
export {
  CanvasFrameSink,
  type FlicClock,
  type FlicFrameSink,
  FlicPlayer,
  type FlicPlayerOptions,
  type PlayFitOptions,
  type PlayOptions,
} from './FlicPlayer';
export { DEFAULT_MAX_SPEED, evenFrames, type FitOptions, type FitPlan, type FlicTiming, planFit } from './fit';
export { loadFlicPlayer } from './packFlic';
