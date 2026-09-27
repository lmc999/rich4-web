// 原版决策注册表（original-skin.md §4.2、§5 A11/A12）：由三处合并——
//   ../dialogs    通用对话框与弹窗（A11：YES/NO、计算器、卡片欄、被动卡、弃牌…）
//   ../venues/a   场所屏第一组（A12）
//   ../venues/b   场所屏第二组（A12）
// 各自的 index.ts 导出 Partial<Record<DecisionKind, 原版场景>>，用 classicScene(() => import('./X')) 登记（见 ./scene.ts）。
// 同一 kind 被登记两次属于分工冲突：开发期报错、先登记的生效（registry 测试断言没有冲突）。
// 没登记的 kind、或场景依赖的素材不可用 → ClassicDecisionHost 回退到 ui/decisions 的程序化对话框。
import { type DecisionKind, isDecisionKind } from '@rich4/shared/engine';
import { classicDialogs } from '../dialogs';
import { classicVenuesA } from '../venues/a';
import { classicVenuesB } from '../venues/b';
import { type ClassicDecisionRegistry, type ClassicSceneComponent, sceneLoader } from './scene';

export type { ClassicDecisionRegistry, ClassicSceneComponent } from './scene';

export interface RegistryPart {
  name: string;
  registry: ClassicDecisionRegistry;
}

/** 合并几份注册表；重复登记的 kind 记进 conflicts（先登记的生效） */
export function mergeClassicRegistries(parts: readonly RegistryPart[]): {
  registry: ClassicDecisionRegistry;
  conflicts: string[];
} {
  const registry: ClassicDecisionRegistry = {};
  const owner = new Map<string, string>();
  const conflicts: string[] = [];
  for (const part of parts) {
    for (const [kind, C] of Object.entries(part.registry) as [DecisionKind, ClassicSceneComponent | undefined][]) {
      if (!C) continue;
      const prev = owner.get(kind);
      if (prev !== undefined) {
        conflicts.push(`${kind}：${prev} 与 ${part.name} 重复登记`);
        continue;
      }
      owner.set(kind, part.name);
      registry[kind] = C;
    }
  }
  return { registry, conflicts };
}

const merged = mergeClassicRegistries([
  { name: 'dialogs', registry: classicDialogs },
  { name: 'venues/a', registry: classicVenuesA },
  { name: 'venues/b', registry: classicVenuesB },
]);

if (merged.conflicts.length > 0) console.error('[classic] 原版决策注册表冲突', merged.conflicts);

export const classicDecisionRegistry: ClassicDecisionRegistry = merged.registry;

/** 注册表冲突（测试断言为空） */
export const CLASSIC_REGISTRY_CONFLICTS: readonly string[] = merged.conflicts;

/** 某个 kind 的原版场景（未登记为 null） */
export function getClassicScene(
  kind: string,
  registry: ClassicDecisionRegistry = classicDecisionRegistry,
): ClassicSceneComponent | null {
  if (!isDecisionKind(kind)) return null;
  return registry[kind] ?? null;
}

let preloading: Promise<void> | null = null;

/** 进入对局后空闲时预取全部原版场景模块（与 preloadDecisionDialogs 同一时机）；失败不影响之后的懒加载 */
export function preloadClassicScenes(registry: ClassicDecisionRegistry = classicDecisionRegistry): Promise<void> {
  const run = (): Promise<void> =>
    Promise.all(
      Object.values(registry).map((C) => (C ? (sceneLoader(C)?.load() ?? Promise.resolve(null)) : null)),
    ).then(() => undefined);
  if (registry !== classicDecisionRegistry) return run().catch(() => undefined);
  preloading ??= run().catch(() => {
    preloading = null;
  });
  return preloading;
}
