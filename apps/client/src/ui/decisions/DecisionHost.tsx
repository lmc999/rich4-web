// DecisionHost：主循环的 DecisionLayer 只需渲染 <DecisionHost {...props} />——按 kind 懒加载对应对话框，
// 加载中显示占位，组件抛错时退回 GenericChoice（保证能按默认处理，流程不会卡死）。
import { Component, type ErrorInfo, type ReactNode, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import s from './decisions.module.css';
import GenericChoice from './GenericChoice';
import { getDecisionComponent } from './registry';
import type { DecisionProps } from './types';

interface BoundaryState {
  error: boolean;
  key: string;
}

/** 渲染出错时显示 fallback；resetKey（decisionId）变化后重试 */
class DecisionBoundary extends Component<
  { resetKey: string; fallback: ReactNode; children: ReactNode },
  BoundaryState
> {
  override state: BoundaryState = { error: false, key: this.props.resetKey };

  static getDerivedStateFromError(): Partial<BoundaryState> {
    return { error: true };
  }

  static getDerivedStateFromProps(props: { resetKey: string }, state: BoundaryState): Partial<BoundaryState> | null {
    return props.resetKey === state.key ? null : { error: false, key: props.resetKey };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[decision] 对话框渲染失败，改用 GenericChoice', error, info.componentStack);
  }

  override render(): ReactNode {
    return this.state.error ? this.props.fallback : this.props.children;
  }
}

function Loading(): ReactNode {
  const { t } = useTranslation();
  return (
    <div className={s.frame} role="status" data-size="sm" style={{ padding: 16 }}>
      {t('common.loading')}
    </div>
  );
}

export function DecisionHost(props: DecisionProps): ReactNode {
  const C = getDecisionComponent(props.decision.kind);
  const key = `${props.decision.seat}:${props.decision.kind}`;
  return (
    <DecisionBoundary resetKey={props.decision.decisionId} fallback={<GenericChoice {...props} />}>
      <Suspense fallback={<Loading />}>
        <C key={key} {...props} />
      </Suspense>
    </DecisionBoundary>
  );
}
