// 回合菜单的「直接打开子页」请求（HUD 的 ActionPad 点卡片 / 道具 / 股票 / 公布栏时，展开 TURN_MENU 并打开对应子页）。
// DecisionLayer 提供；没有 Provider（开发页、测试）时 TurnMenuDialog 照常从主菜单开始。
import { createContext } from 'react';

export type TurnMenuSheetRequest = 'cards' | 'items' | 'stock' | 'board';

export interface TurnMenuSheetControl {
  request: TurnMenuSheetRequest | null;
  /** 子页已打开，清掉请求 */
  consume(): void;
  /** 经快捷入口打开的子页关闭时收起整个回合菜单（回到棋盘，用行动区掷骰） */
  collapse(): void;
}

export const TurnMenuSheetContext = createContext<TurnMenuSheetControl | null>(null);
