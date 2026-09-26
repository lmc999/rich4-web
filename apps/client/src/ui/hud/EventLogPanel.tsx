// 事件日志（design/client.md §2 logFormat）：按提交顺序列出最近 200 条（与显示态同步，不剧透未播放的事件）
import clsx from 'clsx';
import { type ReactNode, useEffect, useRef } from 'react';
import { useTx } from '../../i18n/tx';
import { useGameStore } from '../../store/gameStore';
import h from './hud.module.css';

export function EventLogPanel({ className }: { className?: string }): ReactNode {
  const t = useTx();
  const log = useGameStore((s) => s.log);
  const ref = useRef<HTMLOListElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 新日志进来时滚到底
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log.length]);
  return (
    <section className={clsx(h.log, className)} aria-label={t('hud:log.title')} data-testid="event-log">
      <h3>{t('hud:log.title')}</h3>
      <ol ref={ref}>
        {log.length === 0 && <li className={h.logEmpty}>{t('hud:log.empty')}</li>}
        {log.map((l) => (
          <li key={l.id} data-type={l.type} className={l.type === 'DAY_ADVANCED' ? h.logDay : undefined}>
            {l.text}
          </li>
        ))}
      </ol>
    </section>
  );
}
