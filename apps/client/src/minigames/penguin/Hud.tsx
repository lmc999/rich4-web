// 企鹅挖宝 HUD：剩余秒数（ceil(timeLeft/10)）、得分；底部列出已挖到的宝物件数，记忆阶段提示看土堆。
import type { PenguinState } from '@rich4/shared/minigames';
import type { ReactNode } from 'react';
import { Chips, StatBox, Stats } from '../host/HostShell';
import { mgText } from '../text';
import type { HudProps } from '../types';

const ITEMS: readonly [kind: number, icon: string, points: number][] = [
  [2, '🪙', 5],
  [4, '💎', 8],
  [3, '♦️', 12],
  [5, '✨', 20],
];

export function penguinScore(s: Readonly<PenguinState>): number {
  return 5 * s.counts[2]! + 12 * s.counts[3]! + 8 * s.counts[4]! + 20 * s.counts[5]!;
}

export default function PenguinHud({ state: s }: HudProps<PenguinState>): ReactNode {
  const secs = Math.ceil(Math.max(0, s.timeLeft) / 10);
  const chips = ITEMS.filter(([k]) => s.counts[k]! > 0).map(([k, icon, pts]) => `${icon}${pts}×${s.counts[k]}`);
  return (
    <>
      <Stats>
        <StatBox label={mgText('host.time')} value={secs} urgent={s.phase === 'play' && secs <= 3} />
        <StatBox label={mgText('host.score')} value={penguinScore(s)} />
      </Stats>
      {/* 记忆阶段的提示由场景里的横幅显示 */}
      {chips.length > 0 && <Chips items={chips} />}
    </>
  );
}
