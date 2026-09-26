import type { ReactNode } from 'react';
import styles from './ScreenShell.module.css';

/** 占位页的通用外壳：居中奶油面板 */
export function ScreenShell({ children, testId }: { children: ReactNode; testId: string }): ReactNode {
  return (
    <main className={styles.shell} data-testid={testId}>
      <section className={`panel ${styles.card}`}>{children}</section>
    </main>
  );
}

export { styles as shellStyles };
