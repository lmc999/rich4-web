// 决策组件注册表（design/client.md §5.3；architecture §5.4：23 种 DecisionKind 的唯一清单）。
// satisfies 对 DecisionKind 穷举：引擎新增决策种类时这里编译失败；运行期遇到未知 kind 由 GenericChoice 兜底。
// 每个组件按路由懒加载（首屏不含对话框代码）；一个模块可以服务多个 kind（例如 BuyLotDialog 服务 BUY_LAND 与 BUY_FACILITY）。
import { type DecisionKind, isDecisionKind } from '@rich4/shared/engine';
import { type ComponentType, type LazyExoticComponent, lazy } from 'react';
import GenericChoice from './GenericChoice';
import type { DecisionProps } from './types';

export const decisionRegistry = {
  TURN_MENU: lazy(() => import('./TurnMenuDialog')),
  BANK_ATM: lazy(() => import('./BankDialog').then((m) => ({ default: m.BankAtmDialog }))),
  BANK_COUNTER: lazy(() => import('./BankDialog').then((m) => ({ default: m.BankCounterDialog }))),
  BUY_LAND: lazy(() => import('./BuyLotDialog')),
  UPGRADE_LAND: lazy(() => import('./UpgradeDialog')),
  BUY_FACILITY: lazy(() => import('./BuyLotDialog')),
  BUILD_FACILITY: lazy(() => import('./FacilityBuildDialog')),
  UPGRADE_FACILITY: lazy(() => import('./UpgradeDialog')),
  FACILITY_TYPE: lazy(() => import('./FacilityBuildDialog')),
  RESEARCH: lazy(() => import('./ResearchDialog')),
  SHOP: lazy(() => import('./ShopDialog')),
  LOTTERY: lazy(() => import('./LotteryDialog')),
  BAIL: lazy(() => import('./BailDialog')),
  MINIGAME: lazy(() => import('./MinigameIntro')),
  MAGIC_CAST: lazy(() => import('./MagicHouseDialog')),
  CONSTRUCTION_PICK: lazy(() => import('./LotPickDialog')),
  SUBSCRIBE_SHARES: lazy(() => import('./SubscribeDialog')),
  USE_FREE_CARD: lazy(() => import('./PassiveCardDialog')),
  SCAPEGOAT: lazy(() => import('./PassiveCardDialog')),
  AUCTION_BID: lazy(() => import('./AuctionDialog')),
  BIRTHDAY_PICK: lazy(() => import('./BirthdayPickDialog')),
  DISCARD_CARD: lazy(() => import('./DiscardDialog')),
  DEATH_GOD_TARGET: lazy(() => import('./DeathGodTargetDialog')),
} satisfies { readonly [K in DecisionKind]: LazyExoticComponent<ComponentType<DecisionProps<K>>> };

export type DecisionRegistry = typeof decisionRegistry;

/** 全部对话框模块（预加载用；与上表的 import 说明符一致，打包后是同一批 chunk） */
const DIALOG_MODULES = [
  () => import('./TurnMenuDialog'),
  () => import('./BankDialog'),
  () => import('./BuyLotDialog'),
  () => import('./UpgradeDialog'),
  () => import('./FacilityBuildDialog'),
  () => import('./ResearchDialog'),
  () => import('./ShopDialog'),
  () => import('./LotteryDialog'),
  () => import('./BailDialog'),
  () => import('./MinigameIntro'),
  () => import('./MagicHouseDialog'),
  () => import('./LotPickDialog'),
  () => import('./SubscribeDialog'),
  () => import('./PassiveCardDialog'),
  () => import('./AuctionDialog'),
  () => import('./BirthdayPickDialog'),
  () => import('./DiscardDialog'),
  () => import('./DeathGodTargetDialog'),
] as const;

let preloading: Promise<void> | null = null;

/**
 * 进入对局后空闲时预取全部对话框模块：决策出现时懒加载的 chunk 已在缓存里，不再闪「加载中」
 * （尤其是对局中第一次遇到的决策种类，例如银行柜台紧跟在 ATM 之后）。失败不影响懒加载本身。
 */
export function preloadDecisionDialogs(): Promise<void> {
  preloading ??= Promise.all(DIALOG_MODULES.map((load) => load())).then(
    () => undefined,
    () => {
      preloading = null;
    },
  );
  return preloading;
}

/** 未知 kind 的兜底组件（GenericChoice 已被 DecisionHost 静态引用，这里不再单独拆 chunk） */
export const GenericChoiceLazy = lazy(() => Promise.resolve({ default: GenericChoice }));

/** 取某 kind 的组件（类型擦成通用 DecisionProps，kind 与 options 的对应由引擎保证）；未知 kind 返回 GenericChoice */
export function getDecisionComponent(kind: string): LazyExoticComponent<ComponentType<DecisionProps>> {
  if (!isDecisionKind(kind)) return GenericChoiceLazy;
  return decisionRegistry[kind] as unknown as LazyExoticComponent<ComponentType<DecisionProps>>;
}
