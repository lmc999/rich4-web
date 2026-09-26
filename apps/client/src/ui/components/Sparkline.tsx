// 迷你走势线（自写 SVG）：末值 ≥ 首值用涨色（红），否则跌色（绿）
import type { ReactNode } from 'react';
import s from './components.module.css';

export interface SparklineProps {
  values: readonly number[];
  width?: number;
  height?: number;
  label?: string;
}

/** 折线路径（纯函数，可单测）：x 等分，y 按 min..max 归一（全平时画中线） */
export function sparkPath(values: readonly number[], width: number, height: number, pad = 2): string {
  if (values.length === 0) return '';
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo;
  const n = values.length;
  const x = (i: number): number => (n === 1 ? width / 2 : pad + ((width - pad * 2) * i) / (n - 1));
  const y = (v: number): number => (span === 0 ? height / 2 : pad + (height - pad * 2) * (1 - (v - lo) / span));
  return values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
}

export function Sparkline({ values, width = 96, height = 28, label }: SparklineProps): ReactNode {
  const first = values[0] ?? 0;
  const last = values[values.length - 1] ?? 0;
  const color = last >= first ? 'var(--c-up)' : 'var(--c-down)';
  const d = sparkPath(values, width, height);
  return (
    <svg
      className={s.spark}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-testid="sparkline"
      data-points={values.length}
    >
      {label && <title>{label}</title>}
      <path d={d} stroke={color} />
    </svg>
  );
}
