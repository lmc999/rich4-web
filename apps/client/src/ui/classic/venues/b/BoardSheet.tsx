// 回合菜单（TURN_MENU）的公佈欄子页 → 原版公佈欄场景（Panel#73，./BulletinBoard）。
// TURN_MENU 的原版场景由 ui/classic/dialogs/TurnMenu.tsx 登记（卡片欄、道具欄、目标选择），它的公佈欄子页目前是程序化
// BoardPanel（Modal）。这里与 venues/a 的 ClassicStockSheet 同一种接法，不改回合菜单本身：
// ClassicBoardSheet 拦下 TurnMenuSheetContext 的 'board' 请求（工具列 SALE：打开公佈欄，EXIT 后收起回合菜单，与程序化快捷入口
// 一致）与菜单里 data-testid="turn-board" 的钮（捕获阶段截下：打开公佈欄，EXIT 后回到回合菜单）；其余子页请求原样转给
// children。公佈欄打开期间不渲染 children（两个模态场景不同时存在）。可以和 ClassicStockSheet 嵌套：
//   <ClassicStockSheet {...p}><ClassicBoardSheet {...p}><TurnMenuScene {...p} /></ClassicBoardSheet></ClassicStockSheet>
// 一行接入见 ./TurnMenuBoard.tsx。
import { type MouseEvent, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { TurnMenuSheetContext, type TurnMenuSheetControl } from '../../../decisions/turnMenuSheet';
import type { DecisionProps } from '../../../decisions/types';
import { useDecision } from '../../../decisions/useDecision';
import { BulletinBoardScene } from './BulletinBoard';

type Origin = 'shortcut' | 'menu';

export interface ClassicBoardSheetProps extends DecisionProps<'TURN_MENU'> {
  /** 回合菜单本体（原版或程序化）；公佈欄打开时不渲染 */
  children: ReactNode;
}

/** 把回合菜单的公佈欄子页换成原版公佈欄场景（见文件头） */
export function ClassicBoardSheet({ children, ...props }: ClassicBoardSheetProps): ReactNode {
  const outer = useContext(TurnMenuSheetContext);
  const ctl = useDecision(props);
  const [origin, setOrigin] = useState<Origin | null>(null);
  const wantsBoard = outer?.request === 'board';

  useEffect(() => {
    if (!wantsBoard || !outer) return;
    setOrigin((o) => o ?? 'shortcut');
    outer.consume();
  }, [wantsBoard, outer]);

  const inner = useMemo<TurnMenuSheetControl | null>(
    () =>
      outer
        ? {
            request: outer.request === 'board' ? null : outer.request,
            consume: outer.consume,
            collapse: outer.collapse,
          }
        : null,
    [outer],
  );

  // React 的合成事件沿组件树传播（含 portal）：原版回合菜单挂在舞台上，点它的「公布栏」钮同样经过这里的捕获阶段
  const intercept = (e: MouseEvent<HTMLDivElement>): void => {
    const el = e.target instanceof Element ? e.target : null;
    if (!el?.closest('[data-testid="turn-board"]')) return;
    e.preventDefault();
    e.stopPropagation();
    setOrigin('menu');
  };

  const close = (): void => {
    const via = origin ?? 'shortcut';
    setOrigin(null);
    if (via === 'shortcut') outer?.collapse();
  };

  if (origin !== null || wantsBoard) {
    return <BulletinBoardScene {...props} ctl={ctl} onClose={close} />;
  }
  return (
    // display: contents：不影响回合菜单在决策层里的排版；自己不接收交互，只在捕获阶段截下「公布栏」钮
    <div style={{ display: 'contents' }} onClickCapture={intercept} data-classic-board-sheet="">
      <TurnMenuSheetContext.Provider value={inner}>{children}</TurnMenuSheetContext.Provider>
    </div>
  );
}
