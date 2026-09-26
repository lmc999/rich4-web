// 金额显示：Fredoka 等宽数字 + 千分位；signed 模式显示 +/−，并按红涨绿跌着色（亏损红、收益绿，与股市一致）
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import s from './components.module.css';
import { formatInt, formatShort, formatSigned } from './format';

export interface MoneyProps {
  value: number;
  /** 显示正负号；tone 为 true 时按正负着色 */
  signed?: boolean;
  tone?: boolean;
  /** 简写（4.8万） */
  short?: boolean;
  /** 单位：元（默认）、点（点券）、股，或不显示 */
  unit?: 'yuan' | 'points' | 'shares' | 'none';
  className?: string;
  testId?: string;
}

export function Money({
  value,
  signed = false,
  tone = false,
  short = false,
  unit = 'yuan',
  className,
  testId,
}: MoneyProps): ReactNode {
  const { t } = useTranslation();
  const text = short ? formatShort(value) : signed ? formatSigned(value) : formatInt(value);
  const unitText =
    unit === 'yuan'
      ? t('cmp.unit.yuan')
      : unit === 'points'
        ? t('cmp.unit.points')
        : unit === 'shares'
          ? t('cmp.unit.shares')
          : '';
  return (
    <span
      className={clsx(s.money, tone && value < 0 && s.moneyNeg, tone && value > 0 && s.moneyPos, className)}
      data-testid={testId}
      data-value={value}
    >
      {signed && short && value > 0 ? '+' : ''}
      {text}
      {unitText && <span className={s.unit}>{unitText}</span>}
    </span>
  );
}

/** 点券 */
export function Points({ value, className, testId }: { value: number; className?: string; testId?: string }) {
  return <Money value={value} unit="points" className={className} testId={testId} />;
}
