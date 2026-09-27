// 原版神明弹窗（original-skin.md §4.2 通用：神明老虎机 Panel#67；ui.md §2.2）：
// - 带老虎机（GOD_POWER 的财神发威，slot = {位数, 结果}）：4 位 / 3 位机身摆在棋盘视窗中央，拉杆先拉下，各滚轮
//   （Panel#67 图4–23 滚轮条）滚动后从左到右依次定格在结果数字；上方消息框写标题与台词，下方写金额；
// - 不带老虎机（附身、显灵、召来死神）：神明小像（Panel#9 图13–24，按目视与 GodKind 对上）+ 宝石消息框写标题、台词与玩家。
// 与程序化 GodArrivePopup 同一份 spec；data-testid 同名（god-popup[data-god]、god-line、god-slot[data-value][data-rolling]）。
import type { ReactNode } from 'react';
import { useTx } from '../../../i18n/tx';
import type { GodPopupSpec } from '../../popups/popupStore';
import { classicText, TEXT } from '../common/textStyles';
import { MessageBox } from '../dialogs/parts';
import { REGION } from '../layout';
import { Sprite } from '../Sprite';
import { ASSETS_SHEET, godFrame, reelFrame, reelSpinFrame, SLOT, SLOT_SHEET, slotDigits } from './layout';
import { useElapsed, useTicker } from './PopupScene';
import pp from './popups.module.css';

/** 机身画点（锚点居中）：棋盘视窗中央偏下 */
export const SLOT_AT = { x: REGION.board.x + REGION.board.w / 2, y: REGION.board.y + 250 } as const;

export function SlotMachine({ digits, value, rollMs }: { digits: number; value: number; rollMs: number }): ReactNode {
  const n = digits >= 4 ? 4 : 3;
  const body = SLOT.body[n];
  const elapsed = useElapsed(rollMs);
  const rolling = elapsed < rollMs;
  const tick = useTicker(rolling, 45);
  const ds = slotDigits(value, n);
  const left = SLOT_AT.x - body.ax;
  const top = SLOT_AT.y - body.ay;
  // 滚轮从左到右依次定格：第 i 个在 rollMs·(0.55 + 0.45·i/(n−1)) 时停
  const stopAt = (i: number): number => rollMs * (0.55 + (0.45 * i) / Math.max(1, n - 1));
  return (
    <div
      className={pp.spin}
      style={{ left: 0, top: 0, width: 640, height: 480 }}
      data-testid="god-slot"
      data-value={value}
      data-digits={n}
      data-rolling={rolling ? 'true' : 'false'}
    >
      <Sprite sheet={SLOT_SHEET} frame={body.frame} x={SLOT_AT.x} y={SLOT_AT.y} />
      {ds.map((dgt, i) => {
        const done = elapsed >= stopAt(i);
        return (
          <Sprite
            // biome-ignore lint/suspicious/noArrayIndexKey: 位置固定
            key={i}
            sheet={SLOT_SHEET}
            frame={done ? reelFrame(dgt) : reelSpinFrame(tick, i)}
            x={left + SLOT.reel.x0 + i * SLOT.reel.dx}
            y={top + SLOT.reel.y0}
            origin="topLeft"
          />
        );
      })}
      <Sprite
        sheet={SLOT_SHEET}
        frame={elapsed < Math.min(400, rollMs * 0.3) ? SLOT.lever.down : SLOT.lever.up}
        x={left + body.w - 6}
        y={top + 12}
        origin="topLeft"
      />
      <span className={pp.srOnly}>{ds.join('')}</span>
    </div>
  );
}

export function GodPopup({ spec, ms }: { spec: GodPopupSpec; ms: number }): ReactNode {
  const t = useTx();
  const gf = godFrame(spec.god);
  const amountTone = spec.amountText?.startsWith('-') ? '#ff9a8a' : '#9fe39a';
  if (spec.slot) {
    return (
      <section
        className={pp.layer}
        style={{ left: 0, top: 0, width: 640, height: 480 }}
        data-testid="god-popup"
        data-god={spec.god}
      >
        <MessageBox x={SLOT_AT.x} y={REGION.board.y + 81 + 10} lines={3} testId="god-title">
          <p style={TEXT.title}>{spec.title}</p>
          <p data-testid="god-line">「{spec.line}」</p>
          {spec.player && <p>{spec.player.name}</p>}
        </MessageBox>
        <p className={pp.srOnly}>{t('events:popup.slot')}</p>
        <SlotMachine {...spec.slot} rollMs={Math.min(1600, ms * 0.55)} />
        {spec.amountText && (
          <p
            className={pp.text}
            style={{
              ...classicText({ size: 24, bold: true, color: amountTone, align: 'center', lineHeight: 28 }),
              left: REGION.board.x + 20,
              top: SLOT_AT.y + 92,
              width: REGION.board.w - 40,
            }}
            data-testid="god-amount"
          >
            {spec.amountText}
          </p>
        )}
      </section>
    );
  }
  return (
    <section
      className={pp.layer}
      style={{ left: 0, top: 0, width: 640, height: 480 }}
      data-testid="god-popup"
      data-god={spec.god}
    >
      {gf !== null && <Sprite sheet={ASSETS_SHEET} frame={gf} x={SLOT_AT.x} y={SLOT_AT.y - 60} />}
      <MessageBox x={SLOT_AT.x} y={SLOT_AT.y + 20 + 81} lines={4} testId="god-message">
        <p style={TEXT.title}>{spec.title}</p>
        <p data-testid="god-line">「{spec.line}」</p>
        {spec.amountText && <p style={classicText({ size: 15, bold: true, color: amountTone })}>{spec.amountText}</p>}
        {spec.player && <p>{spec.player.name}</p>}
      </MessageBox>
    </section>
  );
}
