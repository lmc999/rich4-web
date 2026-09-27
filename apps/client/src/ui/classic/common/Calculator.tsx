// 原版计算器数字输入（ui.md §2.1 Panel#21 + 命中掩膜 Panel#22；original-skin.md §4.2 通用：计算器数字输入）。受控组件：
// value / onChange，给定 min / max / step；↵ 调 onEnter（值先规整为合法值）。
// - 16 个掩膜区：MAX、↵、C、0、←、1–9 走 Hotspots（每键一颗透明 <button>，Tab 可达；按下时换按下帧）；
// - 计量棒（区 16）：role="slider"，点按 / 拖动按比例取值，方向键 ±step、PageUp/PageDown ±10 步、Home/End；
// - 液晶屏上叠一个透明输入框（inputmode="numeric"）：键盘直接打数字、手机点液晶屏弹出系统数字键盘（热区补到 44px），
//   E2E 可以 fill()；焦点在键上时数字键、Backspace、C、M、Enter 同样有效；
// - 素材不可用时画 CSS 回退（同样的键位与 DOM）。
import clsx from 'clsx';
import { type KeyboardEvent, type PointerEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { useTx } from '../../../i18n/tx';
import { ensureClassicI18n } from '../i18n';
import { Sprite, spriteStyle, useSheetStatus, useSpriteFrame } from '../Sprite';
import s from './common.module.css';
import { type HotspotSpec, Hotspots } from './Hotspots';
import {
  type CalcBounds,
  type CalcKey,
  calcPress,
  keyOfKeyboard,
  LCD_DIGIT_FRAME0,
  lcdDigits,
  meterRatio,
  NUMPAD_H,
  NUMPAD_KEYS,
  NUMPAD_LCD,
  NUMPAD_MASK,
  NUMPAD_METER,
  NUMPAD_SHEET,
  NUMPAD_W,
  parseTyped,
  snapAmount,
  valueAtRatio,
} from './numpad';
import { useEnsureSceneSprites } from './sceneAssets';

export interface CalculatorProps {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  /** ↵ / Enter（参数为规整后的合法值） */
  onEnter?: (v: number) => void;
  /** ↵ 不可按（例如值不合法时由调用方决定） */
  enterDisabled?: boolean;
  /** 左上角（场景坐标） */
  x: number;
  y: number;
  /** 输入框与计量棒的读屏名称（例如「金额」） */
  label: string;
  disabled?: boolean;
  /** data-testid 前缀（缺省 calc） */
  testId?: string;
  className?: string;
}

const FLASH_MS = 120;

export function Calculator({
  value,
  onChange,
  min,
  max,
  step = 1,
  onEnter,
  enterDisabled = false,
  x,
  y,
  label,
  disabled = false,
  testId = 'calc',
  className,
}: CalculatorProps): ReactNode {
  // 键名（清零 / 退格）在 classic 命名空间：场景可能先于经典布局渲染（测试、回退路径），这里幂等登记
  ensureClassicI18n();
  const t = useTx();
  useEnsureSceneSprites([NUMPAD_SHEET]);
  const body = useSpriteFrame(NUMPAD_SHEET, 0);
  const status = useSheetStatus(NUMPAD_SHEET);
  const art = body !== null;
  const bounds: CalcBounds = { min, max, step };
  const [pressed, setPressed] = useState<CalcKey | null>(null);
  const [flash, setFlash] = useState<CalcKey | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const meterRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    [],
  );

  const press = (key: CalcKey, viaKeyboard = false): void => {
    if (disabled) return;
    if (viaKeyboard) {
      setFlash(key);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlash(null), FLASH_MS);
    }
    if (key === 'enter') {
      if (enterDisabled) return;
      const v = calcPress(value, 'enter', bounds);
      if (v !== value) onChange(v);
      onEnter?.(v);
      return;
    }
    const v = calcPress(value, key, bounds);
    if (v !== value) onChange(v);
  };

  const labelOf = (key: CalcKey, cap: string): string => {
    switch (key) {
      case 'max':
        return t('ui:cmp.max');
      case 'enter':
        return t('ui:dlg.intent.CONFIRM');
      case 'back':
        return t('classic:calc.back');
      case 'clear':
        return t('classic:calc.clear');
      default:
        return cap;
    }
  };

  const spots: HotspotSpec[] = NUMPAD_KEYS.map((k) => ({
    id: k.key,
    rect: k.rect,
    region: k.region,
    label: labelOf(k.key, k.cap),
    hit: k.pad,
    testId: `${testId}-key-${k.key}`,
    disabled: disabled || (k.key === 'enter' && enterDisabled),
    onActivate: () => press(k.key),
  }));

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (disabled || e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement;
    const inInput = target.tagName === 'INPUT';
    const k = keyOfKeyboard(e.key);
    if (!k) return;
    // 输入框自己处理数字与退格；按钮上的 Enter 触发按钮自己
    if (inInput && k !== 'enter') return;
    if (!inInput && k === 'enter' && target.tagName === 'BUTTON') return;
    e.preventDefault();
    press(k, true);
  };

  // 计量棒：按比例取值（场景随舞台缩放，按实际像素宽换算）
  const meterValueAt = (clientX: number): number | null => {
    const el = meterRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0)) return null;
    return valueAtRatio((clientX - r.left) / r.width, bounds);
  };
  const onMeterDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (disabled) return;
    dragging.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const v = meterValueAt(e.clientX);
    if (v !== null && v !== value) onChange(v);
  };
  const onMeterMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (!dragging.current || disabled) return;
    const v = meterValueAt(e.clientX);
    if (v !== null && v !== value) onChange(v);
  };
  const onMeterUp = (): void => {
    dragging.current = false;
  };
  const onMeterKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (disabled) return;
    const st = Math.max(1, Math.trunc(step));
    let next: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = snapAmount(value + st, bounds);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = snapAmount(value - st, bounds);
    else if (e.key === 'PageUp') next = snapAmount(value + st * 10, bounds);
    else if (e.key === 'PageDown') next = snapAmount(value - st * 10, bounds);
    else if (e.key === 'Home') next = snapAmount(min, bounds);
    else if (e.key === 'End') next = snapAmount(max, bounds);
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    if (next !== value) onChange(next);
  };

  const shown = flash ?? pressed;
  const ratio = meterRatio(value, bounds);
  const digits = lcdDigits(value);
  const lcd = NUMPAD_LCD;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 键盘快捷键只是便利，每个键都有自己的 <button>
    <div
      className={clsx(s.calc, className)}
      style={{ left: x, top: y }}
      data-testid={testId}
      data-value={value}
      data-art={art ? 'true' : 'false'}
      onKeyDown={onKey}
    >
      {art ? (
        <Sprite sheet={NUMPAD_SHEET} frame={0} x={0} y={0} origin="topLeft" className={s.calcArt} />
      ) : status === 'loading' ? null : (
        <span className={s.calcFallback} aria-hidden="true" />
      )}

      {/* 液晶屏：数字帧右对齐（回退为文字） */}
      {art ? (
        <span
          className={s.calcLcd}
          style={{ left: 0, top: 0, width: NUMPAD_W, height: NUMPAD_H }}
          aria-hidden="true"
          data-testid={`${testId}-lcd`}
          data-value={value}
        >
          {digits.map((d, i) => (
            <Sprite
              // biome-ignore lint/suspicious/noArrayIndexKey: 位数固定从右往左排，下标即位
              key={i}
              sheet={NUMPAD_SHEET}
              frame={LCD_DIGIT_FRAME0 + d}
              x={lcd.right - lcd.digitW - (digits.length - 1 - i) * lcd.step}
              y={lcd.y}
              origin="topLeft"
            />
          ))}
        </span>
      ) : (
        <span
          className={s.calcLcdText}
          style={{ left: lcd.rect.x, top: lcd.rect.y, width: lcd.rect.w, height: lcd.rect.h, background: '#9fd49a' }}
          aria-hidden="true"
          data-testid={`${testId}-lcd`}
          data-value={value}
        >
          {value}
        </span>
      )}

      {/* 计量条亮格：按比例裁出 */}
      {art ? (
        <MeterFill ratio={ratio} />
      ) : (
        <span
          className={s.calcMeterFallback}
          style={{
            left: NUMPAD_METER.rect.x,
            top: NUMPAD_METER.rect.y,
            width: NUMPAD_METER.rect.w,
            height: NUMPAD_METER.rect.h,
          }}
          aria-hidden="true"
        >
          <span style={{ width: `${Math.round(ratio * 100)}%` }} />
        </span>
      )}

      {/* 按下帧 / 回退键帽 */}
      {NUMPAD_KEYS.map((k) =>
        art ? (
          shown === k.key ? (
            <Sprite key={k.key} sheet={NUMPAD_SHEET} frame={k.frame} x={k.at.x} y={k.at.y} origin="topLeft" />
          ) : null
        ) : (
          <span
            key={k.key}
            className={s.calcKeyFallback}
            style={{ left: k.rect.x, top: k.rect.y, width: k.rect.w, height: k.rect.h }}
            data-pressed={shown === k.key ? 'true' : 'false'}
            aria-hidden="true"
          >
            {k.cap}
          </span>
        ),
      )}

      <Hotspots
        x={0}
        y={0}
        w={NUMPAD_W}
        h={NUMPAD_H}
        spots={spots}
        maskKey={art ? NUMPAD_MASK : undefined}
        mask={art ? undefined : null}
        disabled={disabled}
        onPressChange={(id) => setPressed(id as CalcKey | null)}
        testId={`${testId}-keys`}
      />

      {/* 计量棒（叠在热区之上） */}
      <div
        ref={meterRef}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={Math.max(min, max)}
        aria-valuenow={value}
        aria-disabled={disabled || undefined}
        className={s.calcMeter}
        style={{
          left: NUMPAD_METER.rect.x,
          top: NUMPAD_METER.rect.y,
          width: NUMPAD_METER.rect.w,
          height: NUMPAD_METER.rect.h,
        }}
        data-testid={`${testId}-meter`}
        data-ratio={ratio.toFixed(4)}
        onPointerDown={onMeterDown}
        onPointerMove={onMeterMove}
        onPointerUp={onMeterUp}
        onPointerCancel={onMeterUp}
        onKeyDown={onMeterKey}
      />

      {/* 液晶屏上的透明输入框 */}
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="off"
        enterKeyHint="done"
        className={s.calcInput}
        style={{ left: lcd.rect.x, top: lcd.rect.y, width: lcd.rect.w, height: lcd.rect.h }}
        aria-label={label}
        value={String(Math.max(0, Math.trunc(value)))}
        disabled={disabled}
        data-testid={`${testId}-input`}
        onChange={(e) => {
          const v = parseTyped(e.currentTarget.value, bounds);
          if (v !== value) onChange(v);
        }}
        onFocus={(e) => e.currentTarget.select()}
      />
    </div>
  );
}

/** 计量条亮格（图1）按比例裁宽 */
function MeterFill({ ratio }: { ratio: number }): ReactNode {
  const f = useSpriteFrame(NUMPAD_SHEET, 1);
  if (!f) return null;
  const fill = NUMPAD_METER.fill;
  const w = Math.round(fill.w * Math.min(1, Math.max(0, ratio)));
  if (w <= 0) return null;
  return (
    <span
      className={s.calcMeterFill}
      style={{ left: fill.x, top: fill.y, width: w, height: fill.h }}
      aria-hidden="true"
    >
      <span className={s.calcArt} style={{ ...spriteStyle(f, 0, 0, 1, 'topLeft'), backgroundRepeat: 'no-repeat' }} />
    </span>
  );
}
