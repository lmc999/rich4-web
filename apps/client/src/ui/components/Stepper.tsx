// 数量步进器：[−] 输入框 [+]，可选大步长与「最大」。值总是夹在 [min, max]。
import { type ReactNode, useId } from 'react';
import { useTranslation } from 'react-i18next';
import s from './components.module.css';
import { clampInt } from './format';
import { useNumberDraft } from './numberDraft';

export interface StepperProps {
  value: number;
  onChange(v: number): void;
  min?: number;
  max: number;
  step?: number;
  /** 额外的大步长按钮（例如 ±100 股） */
  bigStep?: number;
  label: string;
  disabled?: boolean;
  /** 显示「最大」按钮 */
  showMax?: boolean;
  testId?: string;
}

export function Stepper({
  value,
  onChange,
  min = 0,
  max,
  step = 1,
  bigStep,
  label,
  disabled = false,
  showMax = false,
  testId,
}: StepperProps): ReactNode {
  const { t } = useTranslation();
  const id = useId();
  const set = (v: number): void => onChange(clampInt(v, min, max));
  const off = disabled || max < min;
  const draft = useNumberDraft(value, min, max, onChange);
  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }} data-testid={testId}>
      <fieldset className={s.stepper} aria-labelledby={`${id}-l`}>
        <legend id={`${id}-l`} className="visually-hidden">
          {label}
        </legend>
        {bigStep !== undefined && (
          <button
            type="button"
            onClick={() => set(value - bigStep)}
            disabled={off || value <= min}
            aria-label={t('cmp.stepper.decBy', { n: bigStep })}
          >
            «
          </button>
        )}
        <button
          type="button"
          onClick={() => set(value - step)}
          disabled={off || value <= min}
          aria-label={t('cmp.stepper.dec')}
        >
          −
        </button>
        <input
          type="number"
          inputMode="numeric"
          value={draft.text}
          min={min}
          max={max}
          step={step}
          aria-label={label}
          disabled={off}
          onChange={(e) => draft.change(e.target.value)}
          onBlur={draft.blur}
        />
        <button
          type="button"
          onClick={() => set(value + step)}
          disabled={off || value >= max}
          aria-label={t('cmp.stepper.inc')}
        >
          +
        </button>
        {bigStep !== undefined && (
          <button
            type="button"
            onClick={() => set(value + bigStep)}
            disabled={off || value >= max}
            aria-label={t('cmp.stepper.incBy', { n: bigStep })}
          >
            »
          </button>
        )}
      </fieldset>
      {showMax && (
        <button type="button" className="btn btn--sm btn--cream" onClick={() => set(max)} disabled={off}>
          {t('cmp.max')}
        </button>
      )}
    </span>
  );
}
