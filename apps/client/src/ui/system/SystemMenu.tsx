// 系统菜单（design/client.md §5.7）：存档读档、暂停 / 继续（房主）、设置、离开房间
import type { RoomView } from '@rich4/shared/net';
import { type ReactNode, useState } from 'react';
import { useClient } from '../../app/services';
import { useTx } from '../../i18n/tx';
import { formatDate } from '../../presentation/names';
import { useGameStore } from '../../store/gameStore';
import { useUiStore } from '../../store/uiStore';
import c from '../common/common.module.css';
import { Modal } from '../components/Modal';
import { SaveLoadMenu } from './SaveLoadMenu';
import { SettingsDialog } from './SettingsDialog';

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
  const host = room.you.isHost;
  const paused = room.phase === 'paused';

  return (
    <>
      <Modal open={open} onOpenChange={onOpenChange} title={t('hud:menu.title')} testId="system-menu" width={520}>
        <div className={c.row} style={{ marginBottom: 12 }}>
          {host && room.phase !== 'ended' && (
            <button
              type="button"
              className="btn btn--sm btn--blue"
              onClick={async () => {
                const r = await client.pause(!paused);
                if (!r.ok) useUiStore.getState().toast(client.errorText(r.error), 'warn');
              }}
              data-testid="menu-pause"
            >
              {paused ? t('hud:menu.resume') : t('hud:menu.pause')}
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
        </div>
        {open && <SaveLoadMenu mode="game" isHost={host} defaultName={date ? formatDate(date) : ''} />}
      </Modal>
      <SettingsDialog open={settings} onOpenChange={setSettings} inGame />
    </>
  );
}
