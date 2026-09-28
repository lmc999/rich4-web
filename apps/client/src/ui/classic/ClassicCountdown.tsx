// 原版布局的画面正中央决策倒计时（ui/common/DecisionCountdown 的 classic 挂载点）：一层与经典舞台同一落点、同一缩放的
// 640×480 逻辑坐标透明层，经 portal 挂到经典舞台容器（.frame）上——棋盘叠层（40）自成层叠上下文，原版场景（48）也是
// portal 到 .frame 的，倒计时要在场景之上（铺满舞台的场所开着时仍看得到）、侧栏抽屉（70）之下，所以不能留在叠层里。
// 数字始终在舞台正中 (320,240)，不避让（见 countdown.module.css）。整层不接收指针。
// 不在经典舞台之内时（单测、预览）就地渲染在父元素左上角。
import type { RoomView } from '@rich4/shared/net';
import { type CSSProperties, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import s from '../common/countdown.module.css';
import { DecisionCountdown } from '../common/DecisionCountdown';
import type { UseDecisionCountdownOptions } from '../common/useDecisionCountdown';
import { useClassicBox } from './ClassicStage';
import { SCENE_Z, scenePlacement } from './common/stage';

/** 倒计时层：高于原版场景，低于侧栏抽屉 */
export const CLASSIC_COUNTDOWN_Z = SCENE_Z + 1;

export function ClassicCountdown({
  room,
  options,
}: {
  room: RoomView;
  /** 测试注入（时钟、提示音） */
  options?: UseDecisionCountdownOptions;
}): ReactNode {
  const box = useClassicBox();
  const anchorRef = useRef<HTMLSpanElement>(null);
  // undefined：还没找过舞台容器（首帧先渲染锚点，布局阶段找到后同步重渲染）
  const [host, setHost] = useState<HTMLElement | null | undefined>(undefined);
  useLayoutEffect(() => {
    setHost(anchorRef.current?.closest<HTMLElement>('[data-testid="classic-stage"]') ?? null);
  }, []);
  const place = scenePlacement(host && box ? box : null);
  const layer = (
    <div
      className={s.classicLayer}
      style={
        {
          left: place.left,
          top: place.top,
          transform: `scale(${place.scale})`,
          zIndex: CLASSIC_COUNTDOWN_Z,
        } as CSSProperties
      }
      data-testid="decision-countdown-layer"
    >
      <DecisionCountdown room={room} variant="classic" options={options} />
    </div>
  );
  return (
    <>
      <span ref={anchorRef} hidden data-countdown-anchor="" />
      {host === undefined ? null : host ? createPortal(layer, host) : layer}
    </>
  );
}
