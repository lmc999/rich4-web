// 一行接入原版公佈欄：dialogs/index.ts 的 `TURN_MENU: classicScene(() => import('./TurnMenu'))` 改成
// `TURN_MENU: classicScene(() => import('../venues/b/TurnMenuBoard'))`——本模块的默认导出就是「原版回合菜单 + 原版公佈欄」，
// requiredKeys = 回合菜单的键 + BULLETIN_REQUIRED_KEYS（缺任何一个整体回退程序化 TurnMenuDialog）。
// 同时要原版股市时，把 venues/a 的 ClassicStockSheet 套在外面（两个外壳互不干扰，见 ./BoardSheet.tsx）。
import type { ReactNode } from 'react';
import type { DecisionProps } from '../../../decisions/types';
import type { RequiredKeys } from '../../decisions/scene';
import TurnMenuScene, { requiredKeys as menuKeys } from '../../dialogs/TurnMenu';
import { ClassicBoardSheet } from './BoardSheet';
import { BULLETIN_REQUIRED_KEYS } from './bulletinLayout';

/** 原版回合菜单 + 原版公佈欄需要的全部素材 */
export const requiredKeys: RequiredKeys<'TURN_MENU'> = (p) => [
  ...(typeof menuKeys === 'function' ? menuKeys(p) : menuKeys),
  ...BULLETIN_REQUIRED_KEYS,
];

/** 原版回合菜单（ui/classic/dialogs/TurnMenu）+ 原版公佈欄 */
export default function ClassicTurnMenuWithBoard(props: DecisionProps<'TURN_MENU'>): ReactNode {
  return (
    <ClassicBoardSheet {...props}>
      <TurnMenuScene {...props} />
    </ClassicBoardSheet>
  );
}
