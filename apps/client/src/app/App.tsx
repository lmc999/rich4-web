import type { ReactNode } from 'react';
import { type BaseLocationHook, Router } from 'wouter';
import { ErrorBoundary } from './ErrorBoundary';
import { AppRoutes } from './routes';

export interface AppProps {
  /** 测试注入的位置钩子（wouter/memory-location）；缺省使用浏览器地址栏 */
  hook?: BaseLocationHook;
}

export function App({ hook }: AppProps): ReactNode {
  const routes = <AppRoutes />;
  return <ErrorBoundary>{hook ? <Router hook={hook}>{routes}</Router> : <Router>{routes}</Router>}</ErrorBoundary>;
}
