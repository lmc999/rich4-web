// TURN_MENU 登记用的完整原版回合菜单：本组的卡片欄 / 道具欄 / 目标选择 / 投降（./TurnMenu）外面套上场所组的两个子页外壳——
// 股市（venues/a 的 ClassicStockSheet → Panel#75）与公佈欄（venues/b 的 ClassicBoardSheet → Panel#73）。两个外壳拦下工具列的
// 「股票」「SALE」请求与菜单里 turn-stock / turn-board 钮，换成原版场景；其余照常交给回合菜单本体（见各自文件头）。
// requiredKeys = 回合菜单 + 股市 + 公佈欄：任何一个缺失就整个回合菜单回退程序化（不半原版半程序化）。
import type { ReactNode } from 'react';
import type { DecisionProps } from '../../decisions/types';
import type { RequiredKeys } from '../decisions/scene';
import { STOCK_KEYS } from '../venues/a/StockMarket';
import { ClassicStockSheet } from '../venues/a/TurnMenuStock';
import { ClassicBoardSheet } from '../venues/b/BoardSheet';
import { BULLETIN_REQUIRED_KEYS } from '../venues/b/bulletinLayout';
import TurnMenuScene, { requiredKeys as menuKeys } from './TurnMenu';

export const requiredKeys: RequiredKeys<'TURN_MENU'> = (p) => [
  ...(typeof menuKeys === 'function' ? menuKeys(p) : menuKeys),
  ...STOCK_KEYS,
  ...BULLETIN_REQUIRED_KEYS,
];

export default function ClassicTurnMenu(props: DecisionProps<'TURN_MENU'>): ReactNode {
  return (
    <ClassicStockSheet {...props}>
      <ClassicBoardSheet {...props}>
        <TurnMenuScene {...props} />
      </ClassicBoardSheet>
    </ClassicStockSheet>
  );
}
