// 原版月结颁奖与终局画面（original-skin.md §4.2 通用：月结颁奖 Panel#25；ui.md §2.3）：整屏底图（图0）+ MONEY 卡（图5）的
// 四个名次格里站着各人的 Q 版小人（图47+3c，三帧轮播），格下写名字与名次（图6–9 大数字），卡的下半部按总资产画柱状条，
// 右侧主持人立绘（图19）与标题。月结（MONTHLY_REPORT，由 ./eventPopups 在事件提交后弹出）按总资产排名，写本月冠军；
// 终局（演出弹窗 gameOver）按引擎给出的名次，出局者小人不动、名字后标「已出局」。
// 终局沿用程序化 GameOverScreen 的 testid（game-over-screen、over-rank-N[data-seat]）。
import type { SeatIndex } from '@rich4/shared/engine';
import type { ReactNode } from 'react';
import { useTx } from '../../../i18n/tx';
import { formatMoney } from '../../../presentation/names';
import { classicText, TEXT } from '../common/textStyles';
import { Sprite } from '../Sprite';
import { chibiFrame, HOST_FRAME, MONEY_CARD, MONTHLY_SHEET, moneySlot, RANK_FRAME0 } from './layout';
import { useTicker } from './PopupScene';
import pp from './popups.module.css';

export interface RankRow {
  seat: SeatIndex;
  character: number;
  name: string;
  rank: number;
  netWorth: number;
  alive: boolean;
  /** 附加说明（月结：本月增减） */
  note?: string | null;
}

export interface RankingProps {
  rows: readonly RankRow[];
  title: string;
  subtitle: string | null;
  /** 根元素 testid 与各行 testid 前缀 */
  testId: string;
  rowTestId: (rank: number) => string;
}

/** MONEY 卡的左上角 */
export const CARD_AT = { x: 16, y: 15 } as const;
/** 柱状条区（相对 MONEY 卡）：名次格下方到卡底 */
const BARS = { top: 176, bottom: 430 } as const;

export function Ranking({ rows, title, subtitle, testId, rowTestId }: RankingProps): ReactNode {
  const t = useTx();
  const tick = useTicker(true, 320);
  const sorted = [...rows].sort((a, b) => a.rank - b.rank).slice(0, 4);
  const max = Math.max(1, ...sorted.map((r) => Math.max(0, r.netWorth)));
  return (
    <section
      className={pp.layer}
      style={{ left: 0, top: 0, width: 640, height: 480 }}
      data-testid={testId}
      aria-label={title}
    >
      <Sprite sheet={MONTHLY_SHEET} frame={0} x={0} y={0} origin="topLeft" />
      <Sprite sheet={MONTHLY_SHEET} frame={MONEY_CARD.frame} x={CARD_AT.x} y={CARD_AT.y} origin="topLeft" />
      <Sprite sheet={MONTHLY_SHEET} frame={HOST_FRAME} x={446} y={62} origin="topLeft" />
      <div
        className={pp.panel}
        style={{ ...TEXT.body, left: 384, top: 12, width: 236 }}
        data-testid={`${testId}-title`}
      >
        <p style={classicText({ size: 20, color: '#ffe060', bold: true, lineHeight: 24 })}>{title}</p>
        {subtitle && <p>{subtitle}</p>}
      </div>
      <ol className={pp.layer} style={{ left: 0, top: 0, margin: 0, padding: 0, listStyle: 'none' }}>
        {sorted.map((r, i) => {
          const slot = moneySlot(i);
          const x = CARD_AT.x + slot.x;
          const y = CARD_AT.y + slot.y;
          const cx = x + slot.w / 2;
          const barH = Math.round(((BARS.bottom - BARS.top - 80) * Math.max(0, r.netWorth)) / max);
          const rankFrame = RANK_FRAME0 + Math.max(0, Math.min(3, r.rank - 1));
          return (
            <li key={r.seat} data-testid={rowTestId(r.rank)} data-seat={r.seat} data-rank={r.rank}>
              <Sprite
                sheet={MONTHLY_SHEET}
                frame={chibiFrame(r.character, r.alive ? tick + i : 0)}
                x={cx}
                y={y + slot.h - 38}
              />
              <Sprite sheet={MONTHLY_SHEET} frame={rankFrame} x={cx} y={CARD_AT.y + BARS.top + 30} />
              <span
                className={pp.cell}
                style={{
                  ...TEXT.small,
                  left: x - 8,
                  top: y + slot.h + 2,
                  width: slot.w + 16,
                  height: 30,
                  flexDirection: 'column',
                }}
              >
                <span>{r.name}</span>
                {!r.alive && <span style={TEXT.warn}>{t('events:popup.out')}</span>}
              </span>
              <span
                className={pp.bar}
                style={{
                  left: x + 12,
                  width: slot.w - 24,
                  top: CARD_AT.y + BARS.bottom - barH,
                  height: barH,
                  bottom: 'auto',
                }}
                aria-hidden="true"
              />
              <span
                className={pp.cell}
                style={{
                  ...classicText({ size: 12, color: '#fff' }),
                  left: x - 10,
                  top: CARD_AT.y + BARS.bottom - barH - 18,
                  width: slot.w + 20,
                  height: 16,
                }}
                data-testid={`${rowTestId(r.rank)}-worth`}
                data-value={r.netWorth}
              >
                {formatMoney(r.netWorth)}
              </span>
              {r.note && (
                <span
                  className={pp.cell}
                  style={{
                    ...TEXT.small,
                    left: x - 10,
                    top: CARD_AT.y + BARS.bottom + 4,
                    width: slot.w + 20,
                    height: 14,
                  }}
                >
                  {r.note}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
