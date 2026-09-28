// 程序化布局的镜头 insets：顶栏、侧栏（「右栏」.right）、底栏（等待条 + 行动区）的实际尺寸 → 镜头有效可视区的四边遮挡。
// 左手模式（settingsStore.leftHanded，.game[data-left="true"]）时右栏挪到左边缘：侧栏宽记在 left、right 为 0，
// 镜头中心（Camera.screenAnchor）才落在看得见的棋盘视口（侧栏以外、顶栏以下、底栏以上）正中，
// 与画面正中央的决策倒计时（ui/common/DecisionCountdown，同一块区域的正中）重合。
import { type RefObject, useLayoutEffect, useState } from 'react';
import type { Insets } from '../../game/camera/Camera';

/** HUD 实测尺寸（CSS 像素）：顶栏高、侧栏宽、底栏高 */
export interface HudSizes {
  top: number;
  side: number;
  bottom: number;
}

/** 实测尺寸 → 镜头 insets：侧栏在右（缺省）遮右边，左手模式在左遮左边 */
export function hudInsets(sizes: HudSizes, leftHanded: boolean): Insets {
  return {
    top: sizes.top,
    right: leftHanded ? 0 : sizes.side,
    bottom: sizes.bottom,
    left: leftHanded ? sizes.side : 0,
  };
}

const ZERO: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

function sameInsets(a: Insets, b: Insets): boolean {
  return a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;
}

/**
 * 量顶栏、侧栏、底栏 → 镜头 insets（窗口或 HUD 尺寸变化时更新）。
 * layout 换了（程序化 ↔ 经典）要重新挂观察：ref 指向的元素换了；leftHanded 切换时侧栏宽不变、ResizeObserver 不会触发，
 * 也要重新量一次（左右对调）。尺寸没变时返回同一个对象，不触发下游的 setInsets。
 */
export function useHudInsets(
  top: RefObject<HTMLElement | null>,
  side: RefObject<HTMLElement | null>,
  bottom: RefObject<HTMLElement | null>,
  layout: string,
  leftHanded: boolean,
): Insets {
  const [insets, setInsets] = useState<Insets>(ZERO);
  // biome-ignore lint/correctness/useExhaustiveDependencies: layout 变化时 ref 指向的元素换了，要重新量
  useLayoutEffect(() => {
    const measure = (): void => {
      const next = hudInsets(
        {
          top: top.current?.offsetHeight ?? 0,
          side: side.current?.offsetWidth ?? 0,
          bottom: bottom.current?.offsetHeight ?? 0,
        },
        leftHanded,
      );
      setInsets((cur) => (sameInsets(cur, next) ? cur : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new ResizeObserver(measure);
    for (const r of [top, side, bottom]) if (r.current) ro.observe(r.current);
    return () => ro.disconnect();
  }, [top, side, bottom, layout, leftHanded]);
  return insets;
}
