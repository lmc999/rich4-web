// 原版轮盘（original-skin.md §4.2 通用：Panel#68–71 航空 / 旅馆 / 购物中心 / 保险；盘面与 WHEEL 表的对应见 ./layout）：
// 转盘摆在棋盘视窗中央，天使（图0/1 挥杖两态）在左上方；转盘先快后慢地转（图2–13，每帧 30°），停在结果扇区朝上的那一帧，
// 下方消息框写这一笔的日志行（已本地化：「X 住宿 N 天」「购物 N 倍」…）。
// 轮盘不是决策也不在演出弹窗队列里：由 ./eventPopups 在事件提交后（FEE_PAID / COMPANY_FEE 带 wheel）弹出，纯展示。
import type { ReactNode } from 'react';
import { TEXT } from '../common/textStyles';
import { MessageBox } from '../dialogs/parts';
import { REGION } from '../layout';
import { Sprite } from '../Sprite';
import { WHEEL, WHEELS, type WheelKind, wheelFrameFor } from './layout';
import { useElapsed } from './PopupScene';
import pp from './popups.module.css';

export interface RouletteSpec {
  wheel: WheelKind;
  value: number;
  /** 已本地化的说明（日志行） */
  caption: string;
  /** 付费者名字 */
  who: string;
}

/** 转盘中心（棋盘视窗中央偏上） */
export const WHEEL_AT = { x: REGION.board.x + REGION.board.w / 2, y: REGION.board.y + 190 } as const;

/**
 * 转动到第 elapsed 毫秒时显示的帧：前 spinMs 按减速曲线转若干圈，最后正好停在 final。
 * 纯函数（测试）：turns 圈 + 到 final 的余量，按 easeOutCubic 分配。
 */
export function wheelFrameAt(elapsed: number, spinMs: number, final: number, turns = 3): number {
  const total = turns * WHEEL.frames + ((final - WHEEL.frame0 + WHEEL.frames) % WHEEL.frames);
  const k = spinMs <= 0 ? 1 : Math.min(1, Math.max(0, elapsed / spinMs));
  const eased = 1 - (1 - k) ** 3;
  const step = Math.round(eased * total);
  return WHEEL.frame0 + (step % WHEEL.frames);
}

export function Roulette({ spec, spinMs }: { spec: RouletteSpec; spinMs: number }): ReactNode {
  const def = WHEELS[spec.wheel];
  const final = wheelFrameFor(spec.wheel, spec.value) ?? WHEEL.frame0;
  const elapsed = useElapsed(spinMs, 40);
  const done = elapsed >= spinMs;
  const frame = wheelFrameAt(elapsed, spinMs, final);
  return (
    <section
      className={pp.layer}
      style={{ left: 0, top: 0, width: 640, height: 480 }}
      data-testid="roulette-popup"
      data-wheel={spec.wheel}
      data-value={spec.value}
      data-frame={frame}
      data-done={done ? 'true' : 'false'}
      aria-label={spec.caption}
    >
      <Sprite sheet={def.key} frame={frame} x={WHEEL_AT.x} y={WHEEL_AT.y} />
      <Sprite
        sheet={def.key}
        frame={done ? WHEEL.angel[1]! : WHEEL.angel[Math.floor(elapsed / 200) % 2]!}
        x={WHEEL_AT.x - 110}
        y={WHEEL_AT.y - 125}
        origin="topLeft"
      />
      <MessageBox x={WHEEL_AT.x} y={WHEEL_AT.y + 92 + 81} lines={3} testId="roulette-caption">
        <p style={TEXT.title}>{spec.who}</p>
        <p style={done ? undefined : { visibility: 'hidden' }}>{spec.caption}</p>
      </MessageBox>
    </section>
  );
}
