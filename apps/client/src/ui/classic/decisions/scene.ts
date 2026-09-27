// 原版决策场景的登记方式（original-skin.md §4.2「原版场景只换表现层」）：
//
//   // dialogs/BuyLand.tsx（场景模块）
//   export const requiredKeys: RequiredKeys<'BUY_LAND'> = (p) => ['ui.yesno', 'ui.common', speakerSheet(char)];
//   export default function BuyLandScene(props: DecisionProps<'BUY_LAND'>) { const ctl = useDecision(props); … }
//
//   // dialogs/index.ts（登记）
//   export const classicDialogs: ClassicDecisionRegistry = { BUY_LAND: classicScene(() => import('./BuyLand')) };
//
// - 场景组件的 props 与程序化对话框完全相同（DecisionProps）；状态与提交沿用 ui/decisions 的 useDecision（提交锁、倒计时）；
// - requiredKeys：场景依赖的素材逻键（数组，或按 props 计算的函数）。宿主在渲染前用 PackClient.usableEntry 逐个检查，
//   精灵还会预先载入仓库；任一不可用（缺失、组缺失、置信度 guess、加载失败）→ 整体回退到程序化对话框，不半原版半程序化；
// - classicScene() 返回 React.lazy 组件（注册表类型不变），同时记下加载函数，宿主据此在渲染前拿到模块的 requiredKeys。
//   直接用 lazy() 登记的组件视为不依赖任何素材键（只要求有素材包）。
import type { DecisionKind } from '@rich4/shared/engine';
import { type ComponentType, type LazyExoticComponent, lazy } from 'react';
import type { DecisionProps } from '../../decisions/types';

export type RequiredKeys<K extends DecisionKind = DecisionKind> =
  | readonly string[]
  | ((props: DecisionProps<K>) => readonly string[]);

/** 原版场景模块的形状 */
export interface ClassicSceneModule<K extends DecisionKind = DecisionKind> {
  default: ComponentType<DecisionProps<K>>;
  requiredKeys?: RequiredKeys<K>;
}

export type ClassicSceneComponent = LazyExoticComponent<ComponentType<DecisionProps>>;

/** 原版决策注册表（kind → 懒加载的原版场景） */
export type ClassicDecisionRegistry = Partial<Record<DecisionKind, ClassicSceneComponent>>;

export interface SceneLoader {
  load(): Promise<ClassicSceneModule>;
  /** 已加载完成的模块（同步取用；未完成为 null） */
  readonly loaded: ClassicSceneModule | null;
}

const loaders = new WeakMap<object, SceneLoader>();

/** 登记一个原版场景模块（懒加载；同一模块只加载一次，失败后下次重试） */
export function classicScene<K extends DecisionKind>(
  load: () => Promise<ClassicSceneModule<K>>,
): ClassicSceneComponent {
  let p: Promise<ClassicSceneModule> | null = null;
  const loader = {
    loaded: null as ClassicSceneModule | null,
    load(): Promise<ClassicSceneModule> {
      p ??= (load() as unknown as Promise<ClassicSceneModule>).then(
        (m) => {
          loader.loaded = m;
          return m;
        },
        (e: unknown) => {
          p = null;
          throw e;
        },
      );
      return p;
    },
  };
  const C = lazy(() => loader.load());
  loaders.set(C, loader);
  return C as unknown as ClassicSceneComponent;
}

/** classicScene() 登记的组件的加载器（直接 lazy() 登记的为 null） */
export function sceneLoader(C: ClassicSceneComponent): SceneLoader | null {
  return loaders.get(C) ?? null;
}

/** 按 props 解出场景依赖的逻辑键（去重） */
export function resolveRequiredKeys(mod: Pick<ClassicSceneModule, 'requiredKeys'>, props: DecisionProps): string[] {
  const r = mod.requiredKeys;
  const keys = r === undefined ? [] : typeof r === 'function' ? r(props) : r;
  return [...new Set(keys)];
}
