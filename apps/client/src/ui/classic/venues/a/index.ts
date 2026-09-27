// 原版场所屏（第一组，original-skin.md §4.2 场所屏、§5 A12）的注册表。登记方式见 ../../decisions/scene.ts：
// KIND: classicScene(() => import('./Xxx'))；与 ../b、../../dialogs 不得重复登记同一 kind。
//   BANK_ATM      ATM（Panel#24；停在银行时叠在银行底图 Panel#23 上）
//   BANK_COUNTER  银行柜台（Panel#23 + 计算器 Panel#21/22）
//   SHOP          百货公司（Panel#10）
//   LOTTERY       乐透投注（Panel#12 + 跑马灯 Panel#14）
// 股市（Panel#75）是回合菜单（TURN_MENU，由 ../../dialogs 登记）的股票子页，不单独登记：dialogs/TurnMenuFull.tsx 用
// ./TurnMenuStock.tsx 的 ClassicStockSheet 包住回合菜单，requiredKeys 并入 ./StockMarket 的 STOCK_KEYS。
// 乐透开奖不是决策：演出组件 ClassicLotteryDraw 在 ./LotteryDraw.tsx，由 PopupLayer 接入（见该文件头注释）。
import type { ClassicDecisionRegistry } from '../../decisions/scene';
import { classicScene } from '../../decisions/scene';

export const classicVenuesA: ClassicDecisionRegistry = {
  BANK_ATM: classicScene(() => import('./BankAtm')),
  BANK_COUNTER: classicScene(() => import('./BankCounter')),
  SHOP: classicScene(() => import('./Shop')),
  LOTTERY: classicScene(() => import('./LotteryBet')),
};
