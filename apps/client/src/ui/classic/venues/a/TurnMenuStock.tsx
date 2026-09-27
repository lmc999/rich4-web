// 回合菜单（TURN_MENU）的股票子页 → 原版股市场景（original-skin.md §4.2 场所屏：股市 Panel#75；§5 A12）。
// TURN_MENU 的原版场景由 ui/classic/dialogs 登记（dialogs/TurnMenuFull.tsx：卡片欄、道具欄、目标选择），它用这里的
// ClassicStockSheet 包住回合菜单，requiredKeys 并入 STOCK_KEYS（./StockMarket）——缺任何一个整体回退程序化 TurnMenuDialog。
// ClassicStockSheet 的做法：拦下 TurnMenuSheetContext 的 'stock' 请求（工具列「股票」：打开股市，EXIT 后收起回合菜单，
// 与程序化快捷入口一致）与菜单里 data-testid="turn-stock" 的钮（捕获阶段截下：打开股市，EXIT 后回到回合菜单）；
// 其余子页请求原样转给 children。股市场景打开期间不渲染 children（两个模态场景不同时存在）。
import { type MouseEvent, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { TurnMenuSheetContext, type TurnMenuSheetControl } from '../../../decisions/turnMenuSheet';
import type { DecisionProps } from '../../../decisions/types';
import { useDecision } from '../../../decisions/useDecision';
import { StockMarketScene } from './StockMarket';

type Origin = 'shortcut' | 'menu';

export interface ClassicStockSheetProps extends DecisionProps<'TURN_MENU'> {
  /** 回合菜单本体（原版或程序化）；股市场景打开时不渲染 */
  children: ReactNode;
}

/** 把回合菜单的股票子页换成原版股市场景（见文件头） */
export function ClassicStockSheet({ children, ...props }: ClassicStockSheetProps): ReactNode {
  const outer = useContext(TurnMenuSheetContext);
  const ctl = useDecision(props);
  const [origin, setOrigin] = useState<Origin | null>(null);
  const wantsStock = outer?.request === 'stock';

  useEffect(() => {
    if (!wantsStock || !outer) return;
    setOrigin((o) => o ?? 'shortcut');
    outer.consume();
  }, [wantsStock, outer]);

  const inner = useMemo<TurnMenuSheetControl | null>(
    () =>
      outer
        ? {
            request: outer.request === 'stock' ? null : outer.request,
            consume: outer.consume,
            collapse: outer.collapse,
          }
        : null,
    [outer],
  );

  // React 的合成事件沿组件树传播（含 portal）：原版回合菜单挂在舞台上，点它的「股票」钮同样经过这里的捕获阶段
  const intercept = (e: MouseEvent<HTMLDivElement>): void => {
    const el = e.target instanceof Element ? e.target : null;
    if (!el?.closest('[data-testid="turn-stock"]')) return;
    e.preventDefault();
    e.stopPropagation();
    setOrigin('menu');
  };

  const close = (): void => {
    const via = origin ?? 'shortcut';
    setOrigin(null);
    if (via === 'shortcut') outer?.collapse();
  };

  if (origin !== null || wantsStock) {
    return (
      <StockMarketScene
        decision={props.decision}
        view={props.view}
        map={props.map}
        isMine={props.isMine}
        ctl={ctl}
        onClose={close}
      />
    );
  }
  return (
    // display: contents：不影响回合菜单在决策层里的排版；自己不接收交互，只在捕获阶段截下「股票」钮
    <div style={{ display: 'contents' }} onClickCapture={intercept} data-classic-stock-sheet="">
      <TurnMenuSheetContext.Provider value={inner}>{children}</TurnMenuSheetContext.Provider>
    </div>
  );
}
