// 喜从天降 HUD：剩余时间（50ms/tick，显示到 0.1 秒）、得分、各类宝物件数。
import type { XicongState } from '@rich4/shared/minigames';
import type { ReactNode } from 'react';
import { Chips, StatBox, Stats } from '../host/HostShell';
import { mgText } from '../text';
import type { HudProps } from '../types';

const ITEMS: readonly [kind: number, icon: string][] = [
  [0, '🧰'],
  [1, '💰'],
  [2, '🥮'],
  [3, '🪙'],
];

export function xicongScore(s: Readonly<XicongState>): number {
  return 10 * s.counts[0]! + 5 * s.counts[1]! + 3 * s.counts[2]! + s.counts[3]!;
}

export default function XicongHud({ state: s }: HudProps<XicongState>): ReactNode {
  const tenths = Math.max(0, s.timeLeft) / 2;
  const secs = (Math.ceil(tenths) / 10).toFixed(1);
  const chips = ITEMS.filter(([k]) => s.counts[k]! > 0).map(([k, icon]) => `${icon}×${s.counts[k]}`);
  return (
    <>
      <Stats>
        <StatBox label={mgText('host.time')} value={secs} urgent={s.phase === 'play' && tenths <= 30} />
        <StatBox label={mgText('host.score')} value={xicongScore(s)} />
      </Stats>
      {chips.length > 0 && <Chips items={chips} />}
    </>
  );
}
