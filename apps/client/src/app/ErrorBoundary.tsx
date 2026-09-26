import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

/** 顶层错误边界：渲染异常时给出可恢复的提示，而不是白屏 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[rich4] render error', error, info.componentStack);
  }

  reset = (): void => this.setState({ error: null });

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return (
      <div role="alert" className="panel" style={{ margin: 24 }}>
        <h2>出错了</h2>
        <pre style={{ whiteSpace: 'pre-wrap' }}>{error.message}</pre>
        <button type="button" className="btn" onClick={this.reset}>
          重试
        </button>
      </div>
    );
  }
}
