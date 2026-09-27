import { lazy, type ReactNode, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Route, Switch } from 'wouter';
import { SkinHome, SkinRoom, SkinSolo } from '../ui/classic/screens/SkinRoutes';
import { NotFound } from '../ui/screens/NotFound';

// 首页 / 房间 / 单机按皮肤选画面（原版皮肤 A14：素材包可用时换成原版标题、开局设置、选人大厅与 Loading，
// 见 ui/classic/screens/SkinRoutes）；房间 / 对局 / 单机页（选角 SVG、Pixi 棋盘）、原版画面与开发页都按路由懒加载，
// 不进首屏 chunk
const MapPreview = lazy(() => import('../dev/MapPreview'));
const Gallery = lazy(() => import('../dev/Gallery'));
const DevDecisions = lazy(() => import('../ui/decisions/DevDecisions'));
const AudioLab = lazy(() => import('../audio/dev/AudioLab'));

/** 路由表（design/client.md §1.3：/、/r/:code、/solo、/dev/*；/dev/audio 为原版皮肤 A9 的音频试听页） */
export const ROUTE_PATHS = {
  home: '/',
  room: '/r/:code',
  solo: '/solo',
  devMap: '/dev/map',
  devGallery: '/dev/gallery',
  devDecisions: '/dev/decisions',
  devAudio: '/dev/audio',
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
        <Route path={ROUTE_PATHS.home} component={SkinHome} />
        <Route path={ROUTE_PATHS.room}>{(params) => <SkinRoom code={params.code} />}</Route>
        <Route path={ROUTE_PATHS.solo} component={SkinSolo} />
        <Route path={ROUTE_PATHS.devMap} component={MapPreview} />
        <Route path={ROUTE_PATHS.devGallery} component={Gallery} />
        <Route path={ROUTE_PATHS.devDecisions} component={DevDecisions} />
        <Route path={ROUTE_PATHS.devAudio} component={AudioLab} />
        <Route>
          <NotFound />
        </Route>
      </Switch>
    </Suspense>
  );
}
