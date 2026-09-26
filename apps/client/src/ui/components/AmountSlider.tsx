// 金额滑条（银行存取款、贷款）：原生 range + 数字框 + 快捷档（¼、½、全部）。
// 不用 radix Slider：原生 range 在手机上手感更好、可直接键盘操作，jsdom 测试也能直接 change。
import { type ReactNode, useId } from 'react';
import { useTranslation } from 'react-i18next';
import s from './components.module.css';
import { clampInt } from './format';
import { useNumberDraft } from './numberDraft';

export interface AmountSliderProps {
  value: number;
  onChange(v: number): void;
  max: number;
  min?: number;
  step?: number;
  label: string;
  disabled?: boolean;
  testId?: string;
}

export function AmountSlider({
  value,
  onChange,
  max,
  min = 0,
  step = 100,
  label,
  disabled = false,
  testId,
}: AmountSliderProps): ReactNode {
  const { t } = useTranslation();
  const id = useId();
  const hi = Math.max(min, max);
  const set = (v: number): void => onChange(clampInt(v, min, hi));
  const off = disabled || hi <= min;
  const draft = useNumberDraft(value, min, hi, onChange);
  const presets: [string, number][] = [
    [t('cmp.slider.quarter'), Math.trunc(hi / 4)],
    [t('cmp.slider.half'), Math.trunc(hi / 2)],
    [t('cmp.slider.all'), hi],
  ];
  return (
    <div className={s.slider} data-testid={testId}>
      <label htmlFor={`${id}-r`} className="visually-hidden">
        {label}
      </label>
      <div className={s.sliderRow}>
        <input
          id={`${id}-r`}
          type="range"
          min={min}
          max={hi}
          step={step}
          value={value}
          disabled={off}
          onChange={(e) => set(Number(e.target.value))}
        />
        <input
          className="input num"
          style={{ width: '11ch', textAlign: 'right' }}
          type="number"
          inputMode="numeric"
          aria-label={label}
          min={min}
          max={hi}
          value={draft.text}
          disabled={off}
          onChange={(e) => draft.change(e.target.value)}
          onBlur={draft.blur}
        />
      </div>
      <div className={s.presets}>
        {presets.map(([name, v]) => (
          <button key={name} type="button" className="btn btn--sm btn--cream" disabled={off} onClick={() => set(v)}>
            {name}
          </button>
        ))}
      </div>
    </div>
  );
}
