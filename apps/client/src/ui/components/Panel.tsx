// 奶油底厚描边面板（.panel 在 global.css），可带标题与右侧操作区
import clsx from 'clsx';
import type { HTMLAttributes, ReactNode } from 'react';
import s from './components.module.css';

export interface PanelProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode;
  actions?: ReactNode;
  headingLevel?: 2 | 3;
}

export function Panel({ title, actions, headingLevel = 2, className, children, ...rest }: PanelProps): ReactNode {
  const H = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <section className={clsx('panel', className)} {...rest}>
      {(title !== undefined || actions !== undefined) && (
        <header className={s.panelHead}>
          {title !== undefined && <H>{title}</H>}
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

/** 键值列表（左名右值） */
export function KeyValues({ rows, className }: { rows: [ReactNode, ReactNode][]; className?: string }): ReactNode {
  return (
    <dl className={clsx(s.kv, className)}>
      {rows.map(([k, v], i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 行顺序固定
        <div key={i} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Badge({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span className={clsx(s.badge, className)} title={title}>
      {children}
    </span>
  );
}
