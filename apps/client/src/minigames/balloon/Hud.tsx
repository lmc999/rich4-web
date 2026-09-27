// 七彩气球 HUD：剩余秒数（ceil(timeLeft/10)，时间到后为 0，剩下的气球仍可打）、得分、冻结 / 变速状态。
import { type BalloonState, balloon } from '@rich4/shared/minigames';
import type { ReactNode } from 'react';
import { Chips, StatBox, Stats } from '../host/HostShell';
import { mgText } from '../text';
import type { HudProps } from '../types';

export default function BalloonHud({ state: s }: HudProps<BalloonState>): ReactNode {
  const secs = Math.ceil(Math.max(0, s.timeLeft) / 10);
  const chips: string[] = [];
  if (s.freeze > 0) chips.push(`❄ ${mgText('balloon.freeze')}`);
  if (s.speedMode === balloon.SPEED_FAST) chips.push(`⏩ ${mgText('balloon.fast')}`);
  if (s.speedMode === balloon.SPEED_SLOW) chips.push(`🐢 ${mgText('balloon.slow')}`);
  return (
    <>
      <Stats>
        <StatBox label={mgText('host.time')} value={secs} urgent={s.phase === 'play' && secs <= 3} />
        <StatBox label={mgText('host.score')} value={s.score} />
      </Stats>
      {chips.length > 0 && <Chips items={chips} />}
    </>
  );
}
