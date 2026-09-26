// 胖圆角按钮（基础样式 .btn 在 global.css；按下下沉 2px）
import clsx from 'clsx';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import s from './components.module.css';

export type ButtonVariant = 'sun' | 'blue' | 'green' | 'cream' | 'red' | 'purple' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  icon?: ReactNode;
}

const VARIANT_CLASS: Record<ButtonVariant, string | undefined> = {
  sun: undefined,
  blue: 'btn--blue',
  green: 'btn--green',
  cream: 'btn--cream',
  red: s.btnRed,
  purple: s.btnPurple,
  ghost: clsx('btn--cream', s.btnGhost),
};

export function Button({
  variant = 'sun',
  size = 'md',
  block = false,
  icon,
  className,
  type = 'button',
  children,
  ...rest
}: ButtonProps): ReactNode {
  return (
    <button
      type={type}
      className={clsx(
        'btn',
        VARIANT_CLASS[variant],
        size === 'sm' && 'btn--sm',
        size === 'lg' && s.btnLg,
        block && s.btnBlock,
        className,
      )}
      {...rest}
    >
      {icon !== undefined && <span aria-hidden="true">{icon}</span>}
      {children}
    </button>
  );
}
