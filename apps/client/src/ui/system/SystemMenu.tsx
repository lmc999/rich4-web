// 系统菜单（design/client.md §5.7）：存档读档、托管设置（玩家）、暂停 / 继续与解散房间（房主）、设置、离开房间。
// 托管设置对话框也挂在这里（对局页始终挂载 SystemMenu），其他组件用 openTrusteeSettings() 打开。
// 原版皮肤把菜单里打开的界面换成经典舞台里的原版界面时，用 closeSystemMenu() 收起菜单（见 classic/popups/ClassicPopupHost）。
import type { RoomView } from '@rich4/shared/net';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useClient } from '../../app/services';
import { useTx } from '../../i18n/tx';
import { formatDate } from '../../presentation/names';
import { useGameStore } from '../../store/gameStore';
import { useUiStore } from '../../store/uiStore';
import { Modal } from '../components/Modal';
import { SaveLoadMenu } from './SaveLoadMenu';
import { SettingsDialog } from './SettingsDialog';
import sy from './system.module.css';
import { openTrusteeSettings, TrusteeSettingsDialog } from './TrusteeSettings';

/** 打开着的系统菜单的收起函数（对局页只挂一个 SystemMenu；菜单打开期间登记） */
let closeOpenMenu: (() => void) | null = null;

/**
 * 收起系统菜单（没打开时什么也不做）。原版皮肤接管菜单里打开的界面（托管设置 → 原版托管画面）时调用：
 * 原版界面画在经典舞台里，挂在 body 上的系统菜单会盖住它，玩家得先关菜单才能操作。
 * 程序化界面（托管设置对话框等）照旧叠在菜单之上，不调用这里。
 */
export function closeSystemMenu(): void {
  closeOpenMenu?.();
}

export function SystemMenu({
  room,
  open,
  onOpenChange,
  onLeave,
}: {
  room: RoomView;
  open: boolean;
  onOpenChange(o: boolean): void;
  onLeave(): void;
}): ReactNode {
  const t = useTx();
  const client = useClient();
  const date = useGameStore((s) => s.view?.clock.date ?? 0);
  const [settings, setSettings] = useState(false);
  const [confirmDissolve, setConfirmDissolve] = useState(false);
  const host = room.you.isHost;
  const paused = room.phase === 'paused';
  const player = room.you.role === 'player';
  const live = room.phase === 'playing' || room.phase === 'paused';
  const warn = (text: string): void => {
    useUiStore.getState().toast(text, 'warn');
  };
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  useEffect(() => {
    if (!open) return;
    const close = (): void => {
      setConfirmDissolve(false);
      onOpenChangeRef.current(false);
    };
    closeOpenMenu = close;
    return () => {
      if (closeOpenMenu === close) closeOpenMenu = null;
    };
  }, [open]);

  return (
    <>
      <Modal
        open={open}
        onOpenChange={(o) => {
          if (!o) setConfirmDissolve(false);
          onOpenChange(o);
        }}
        title={t('hud:menu.title')}
        testId="system-menu"
        width={520}
        layer="system"
      >
        <div className={sy.menuRow}>
          {host && room.phase !== 'ended' && (
            <button
              type="button"
              className="btn btn--sm btn--blue"
              onClick={async () => {
                const r = await client.pause(!paused);
                if (!r.ok) warn(client.errorText(r.error));
              }}
              data-testid="menu-pause"
            >
              {paused ? t('hud:menu.resume') : t('hud:menu.pause')}
            </button>
          )}
          {player && live && (
            <button
              type="button"
              className="btn btn--sm btn--cream"
              // 叠在系统菜单上打开（先关菜单的话，菜单卸载时焦点回到顶栏按钮，会被托管对话框当成点到外面而关掉）；
              // 原版皮肤接管成原版托管画面时由 ClassicPopupHost 收起菜单（closeSystemMenu）
              onClick={() => openTrusteeSettings()}
              data-testid="menu-trustee"
            >
              🤖 {t('ui:trustee.title')}
            </button>
          )}
          <button
            type="button"
            className="btn btn--sm btn--cream"
            onClick={() => setSettings(true)}
            data-testid="menu-settings"
          >
            {t('hud:menu.settings')}
          </button>
          <button type="button" className="btn btn--sm btn--cream" onClick={onLeave} data-testid="menu-leave">
            {t('hud:menu.leave')}
          </button>
          {host && !confirmDissolve && (
            <button
              type="button"
              className="btn btn--sm btn--cream"
              onClick={() => setConfirmDissolve(true)}
              data-testid="menu-dissolve"
            >
              {t('lobby:room.dissolve')}
            </button>
          )}
        </div>
        {host && confirmDissolve && (
          <div className={sy.confirmRow} role="alert" data-testid="menu-dissolve-confirm-row">
            <span>{live ? t('ui:menu.dissolveInGame') : t('ui:menu.dissolveAsk')}</span>
            <button
              type="button"
              className={`btn btn--sm ${sy.danger}`}
              onClick={async () => {
                const r = await client.dissolve();
                if (!r.ok) warn(client.errorText(r.error));
              }}
              data-testid="menu-dissolve-confirm"
            >
              {t('ui:menu.dissolveConfirm')}
            </button>
            <button type="button" className="btn btn--sm btn--cream" onClick={() => setConfirmDissolve(false)}>
              {t('ui:saveMenu.cancel')}
            </button>
          </div>
        )}
        {open && <SaveLoadMenu mode="game" isHost={host} defaultName={date ? formatDate(date) : ''} />}
      </Modal>
      <SettingsDialog open={settings} onOpenChange={setSettings} inGame />
      <TrusteeSettingsDialog room={room} />
    </>
  );
}
