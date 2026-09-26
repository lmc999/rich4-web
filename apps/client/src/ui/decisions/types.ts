// 决策对话框的公共类型（design/client.md §5.3；architecture §5.4）。前端主循环从这里导入 DecisionProps。
import type { MapIndex } from '@rich4/shared/data';
import type { DecisionKind, PlayerIntent } from '@rich4/shared/engine';
import type { DecisionForYou, GameView } from '@rich4/shared/view';
import type { ComponentType } from 'react';

/**
 * submit 的返回值（通常 void）：
 * - 非 Promise：发出后保持锁定，直到收到新的决策（decisionId 变化）或对话框卸载；
 * - Promise：解析为 false、{ ok: false }，或 reject 时解锁（nack 后允许重试）；其他结果保持锁定。
 *   net 的 Ack 结果 Result<T>（{ ok: true, … } | { ok: false, error }）可以直接作为解析值。
 */
export type SubmitOutcome = boolean | { ok: boolean } | undefined;
export type SubmitFn = (intent: PlayerIntent) => unknown;

export interface DecisionProps<K extends DecisionKind = DecisionKind> {
  /** 本人的决策（DecisionForYou；net 的 YourDecision 可直接传入） */
  decision: DecisionForYou<K>;
  /** false：只读等待态（例如托管中、旁观热座），所有控件禁用 */
  isMine: boolean;
  /** 显示态 view（HUD 同源） */
  view: GameView;
  map: MapIndex;
  submit: SubmitFn;
  /** 服务器时间估计 Date.now() + 时钟偏移；缺省取 DecisionClockContext */
  now?: () => number;
}

export type DecisionComponent<K extends DecisionKind = DecisionKind> = ComponentType<DecisionProps<K>>;

/** K 的各成员分别展开成判别联合（kind 与 options 一一对应），便于 if (d.kind === 'X') 收窄 */
export type DecisionOf<K extends DecisionKind> = { [P in K]: DecisionForYou<P> }[K];

/** 一个组件服务多个 kind 时，把 DecisionForYou<K1 | K2> 转成判别联合（对应关系由引擎保证） */
export function narrowDecision<K extends DecisionKind>(d: DecisionForYou<K>): DecisionOf<K> {
  return d as unknown as DecisionOf<K>;
}
