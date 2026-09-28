// 模态面板（radix Dialog：焦点管理、Esc 关闭、无障碍标题）。窄屏（≤640px）自动改为底部抽屉 BottomSheet（design/client.md §5.2）。
import clsx from 'clsx';
import { Dialog } from 'radix-ui';
import { type CSSProperties, type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import s from './components.module.css';

/** 订阅 matchMedia（jsdom 没有 matchMedia 时恒为 false） */
export function useMediaQuery(query: string): boolean {
  const get = (): boolean =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  const [match, setMatch] = useState(get);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const on = (): void => setMatch(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}

export const NARROW_QUERY = '(max-width: 640px)';

export interface ModalProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** 'auto'：窄屏为底部抽屉；true 强制抽屉；false 强制居中 */
  sheet?: boolean | 'auto';
  /** 最大宽度（px） */
  width?: number;
  /** false 时点遮罩与 Esc 不关闭（仍可点关闭按钮） */
  dismissable?: boolean;
  /**
   * 层级：'panel'（缺省，遮罩 40、面板 41，决策与游戏面板）；'system'（遮罩 46、面板 47：系统菜单、设置、托管设置这类
   * 系统界面，盖在画面正中央的决策倒计时 z 45 之上——数字只压在决策内容上，不压系统界面，与原版皮肤一致）
   */
  layer?: 'panel' | 'system';
  testId?: string;
}

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  sheet = 'auto',
  width,
  dismissable = true,
  layer = 'panel',
  testId,
}: ModalProps): ReactNode {
  const { t } = useTranslation();
  const narrow = useMediaQuery(NARROW_QUERY);
  const asSheet = sheet === 'auto' ? narrow : sheet;
  const style = width ? ({ '--modal-w': `${width}px` } as CSSProperties) : undefined;
  const block = (e: Event): void => {
    if (!dismissable) e.preventDefault();
  };
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} data-layer={layer} />
        <Dialog.Content
          className={clsx(s.modal, asSheet && s.sheet)}
          style={style}
          data-testid={testId}
          data-sheet={asSheet ? 'true' : 'false'}
          data-layer={layer}
          onPointerDownOutside={block}
          onEscapeKeyDown={block}
          {...(description === undefined ? { 'aria-describedby': undefined } : {})}
        >
          <header className={s.modalHead}>
            <Dialog.Title className={s.modalTitle}>{title}</Dialog.Title>
            <Dialog.Close className={s.closeBtn} aria-label={t('cmp.close')}>
              ×
            </Dialog.Close>
          </header>
          <div className={s.modalBody}>
            {description !== undefined && <Dialog.Description>{description}</Dialog.Description>}
            {children}
          </div>
          {footer !== undefined && <footer className={s.modalFoot}>{footer}</footer>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** 底部抽屉：强制 sheet 形态的 Modal */
export function BottomSheet(props: Omit<ModalProps, 'sheet'>): ReactNode {
  return <Modal {...props} sheet />;
}
