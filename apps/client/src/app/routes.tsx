import { lazy, type ReactNode, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Route, Switch } from 'wouter';
import { HomeScreen } from '../ui/screens/HomeScreen';
import { NotFound } from '../ui/screens/NotFound';
import { RoomScreen } from '../ui/screens/RoomScreen';
import { SoloScreen } from '../ui/screens/SoloScreen';

// 开发页含 Pixi，按路由懒加载，不进首屏 chunk
const MapPreview = lazy(() => import('../dev/MapPreview'));
const Gallery = lazy(() => import('../dev/Gallery'));

/** 路由表（design/client.md §1.3：/、/r/:code、/solo、/dev/*） */
export const ROUTE_PATHS = {
  home: '/',
  room: '/r/:code',
  solo: '/solo',
  devMap: '/dev/map',
  devGallery: '/dev/gallery',
} as const;

function RouteFallback(): ReactNode {
  const { t } = useTranslation();
  return (
    <div className="panel" role="status" style={{ margin: 24 }}>
      {t('common.loading')}
    </div>
  );
}

export function AppRoutes(): ReactNode {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Switch>
        <Route path={ROUTE_PATHS.home} component={HomeScreen} />
        <Route path={ROUTE_PATHS.room}>{(params) => <RoomScreen code={params.code} />}</Route>
        <Route path={ROUTE_PATHS.solo} component={SoloScreen} />
        <Route path={ROUTE_PATHS.devMap} component={MapPreview} />
        <Route path={ROUTE_PATHS.devGallery} component={Gallery} />
        <Route>
          <NotFound />
        </Route>
      </Switch>
    </Suspense>
  );
}
