// 决策对话框入口（design/client.md §5.3）。主循环的 DecisionLayer 用 DecisionHost 渲染当前决策；
// 倒计时的服务器时钟用 DecisionClockProvider（或 DecisionClockContext）提供；棋盘高亮与点选经 BoardBridgeContext 接入。
export { type DecisionClock, DecisionClockContext, DecisionClockProvider, useServerNow } from './clock';
export { DecisionFrame, type DecisionFrameProps, type FrameTone } from './DecisionFrame';
export { DecisionHost } from './DecisionHost';
export { default as GenericChoice } from './GenericChoice';
export { type DecisionRegistry, decisionRegistry, GenericChoiceLazy, getDecisionComponent } from './registry';
export {
  buildTarget,
  draftFromPick,
  type TargetDraft,
  TargetPicker,
  type TargetPickerProps,
  type TargetSource,
} from './TargetPicker';
export {
  type BoardBridge,
  BoardBridgeContext,
  type BoardPick,
  EMPTY_HIGHLIGHT,
  highlightOf,
  type TargetHighlight,
  useBoardHighlight,
  useBoardPick,
} from './targeting';
export {
  type DecisionComponent,
  type DecisionOf,
  type DecisionProps,
  narrowDecision,
  type SubmitFn,
  type SubmitOutcome,
} from './types';
export { type DecisionController, useDecision } from './useDecision';
