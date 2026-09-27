// 原版通用对话框与弹窗的注册表（original-skin.md §4.2 通用、§5 A11）。登记方式见 ../decisions/scene.ts：
//   KIND: classicScene(() => import('./Xxx')),
// 场景模块默认导出组件（props = DecisionProps），并导出 requiredKeys（依赖的素材逻辑键，缺任何一个就整体回退）。
// 一个模块可以服务多个 kind（Upgrade：UPGRADE_LAND / UPGRADE_FACILITY；PickSeat：SCAPEGOAT / DEATH_GOD_TARGET；
// FacilityPick：BUILD_FACILITY / FACILITY_TYPE；CardPick：DISCARD_CARD / BIRTHDAY_PICK），打包后是同一个 chunk。
// 场所屏（银行、百货、乐透、魔法屋、拍卖、监狱医院）由 ../venues/a、../venues/b 登记，这里不重复。
import type { ClassicDecisionRegistry } from '../decisions/scene';
import { classicScene } from '../decisions/scene';

export const classicDialogs: ClassicDecisionRegistry = {
  // 回合菜单：卡片欄 / 道具欄 / 目标选择（./TurnMenu）+ 场所组的股市、公佈欄子页（./TurnMenuFull）
  TURN_MENU: classicScene(() => import('./TurnMenuFull')),
  BUY_LAND: classicScene(() => import('./BuyLand')),
  BUY_FACILITY: classicScene(() => import('./BuyFacility')),
  UPGRADE_LAND: classicScene(() => import('./Upgrade')),
  UPGRADE_FACILITY: classicScene(() => import('./Upgrade')),
  BUILD_FACILITY: classicScene(() => import('./FacilityPick')),
  FACILITY_TYPE: classicScene(() => import('./FacilityPick')),
  RESEARCH: classicScene(() => import('./Research')),
  USE_FREE_CARD: classicScene(() => import('./FreeCard')),
  SCAPEGOAT: classicScene(() => import('./PickSeat')),
  DEATH_GOD_TARGET: classicScene(() => import('./PickSeat')),
  DISCARD_CARD: classicScene(() => import('./CardPick')),
  BIRTHDAY_PICK: classicScene(() => import('./CardPick')),
  SUBSCRIBE_SHARES: classicScene(() => import('./Subscribe')),
  CONSTRUCTION_PICK: classicScene(() => import('./ConstructionPick')),
  MINIGAME: classicScene(() => import('./Minigame')),
};
