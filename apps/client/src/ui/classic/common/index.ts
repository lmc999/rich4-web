// 原版场景的公共组件（original-skin.md §4.2；design-draft §4.3 Stage4x3 与 Hotspots）。用法见各文件头注释与
// ui/classic/decisions/registry.ts（如何登记原版决策场景、requiredKeys 约定）。

export { Calculator, type CalculatorProps } from './Calculator';
export {
  type ButtonFrames,
  type ButtonState,
  buttonFrame,
  ClassicButton,
  type ClassicButtonProps,
} from './ClassicButton';
export { DecisionStage, type DecisionStageProps } from './DecisionStage';
export { canExtractFrames, frameObjectUrl } from './frameImage';
export {
  CLASSIC_FRAMES,
  type ClassicFrameName,
  type FrameSpec,
  type SliceInsets,
  type SliceMode,
  type SliceRepeat,
  sliceParts,
  sliceSize,
} from './frames';
export { type HitPad, type HotspotSpec, Hotspots, type HotspotsProps } from './Hotspots';
export { type HotspotShape, localPoint, regionBoxes, resolveActivation, spotAt } from './hitTest';
export { type MaskAsset, maskFromImage, maskFromRegions, maskRegion, useSceneMask } from './mask';
export { NineSlice, type NineSliceProps } from './NineSlice';
export {
  type CalcBounds,
  type CalcKey,
  calcPress,
  clampAmount,
  isValidAmount,
  meterRatio,
  NUMPAD_KEYS,
  NUMPAD_MASK,
  NUMPAD_SHEET,
  parseTyped,
  snapAmount,
  valueAtRatio,
} from './numpad';
export {
  BUBBLE_LAYOUT,
  type BubbleKind,
  SPEAKER_HEAD_AT,
  SpeakerBubble,
  type SpeakerBubbleProps,
  type SpeechTail,
  speakerSheet,
} from './SpeakerBubble';
export {
  type SceneBackdrop,
  SceneLayer,
  type SceneLayerProps,
  type SceneStatusTone,
  Stage4x3,
  type Stage4x3Props,
} from './Stage4x3';
export {
  ensureSceneSprite,
  prepareSceneKeys,
  type SceneKeysStatus,
  sceneKeysStatus,
  scenePackClient,
  useEnsureSceneSprites,
} from './sceneAssets';
export { anchored, HIT_MIN_CSS, hitMinLogical, SCENE_H, SCENE_W, SCENE_Z, scenePlacement } from './stage';
export { CLASSIC_FONT, classicText, dropShadow, outlineShadow, TEXT } from './textStyles';
export {
  MESSAGE_BOX,
  messageBoxHeight,
  YESNO,
  YESNO_SHEET,
  YesNoBox,
  type YesNoBoxProps,
  yesNoLayout,
} from './YesNoBox';
