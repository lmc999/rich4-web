// 存档与读档（design/client.md §5.7，按 architecture §5.12 只做服务器存档）：
// 对局中房主 game:save；列出 saves:list（非官方存档标注）；大厅中房主 room:loadSave；删除 saves:delete。

import { CHARACTER_KEYS } from '@rich4/shared/engine';
import { SAVE_NAME_MAX, type SaveSummary } from '@rich4/shared/net';
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from 'react';
import { useClient } from '../../app/services';
import { useTx } from '../../i18n/tx';
import { formatDate } from '../../presentation/names';
import { useUiStore } from '../../store/uiStore';
import c from '../common/common.module.css';
import sy from './system.module.css';

export interface SaveLoadMenuProps {
  /** 对局中（可存档）或大厅（可读档） */
  mode: 'game' | 'lobby';
  isHost: boolean;
  /** 默认存档名（例如「1998年3月12日」） */
  defaultName?: string;
}

export function SaveLoadMenu({ mode, isHost, defaultName = '' }: SaveLoadMenuProps): ReactNode {
  const t = useTx();
  const client = useClient();
  const [saves, setSaves] = useState<SaveSummary[] | null>(null);
  const [name, setName] = useState(defaultName);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const r = await client.listSaves();
    setSaves(r.ok ? r.data.saves : []);
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toast = (text: string, kind: 'success' | 'warn' = 'success'): void => {
    useUiStore.getState().toast(text, kind);
  };

  const save = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    const r = await client.save(n);
    setBusy(false);
    if (r.ok) {
      toast(t('hud:saves.saved'));
      void refresh();
    } else toast(client.errorText(r.error), 'warn');
  };

  return (
    <section className={sy.saves} data-testid="save-load">
      {mode === 'game' && isHost && (
        <form className={c.row} onSubmit={(e) => void save(e)}>
          <input
            className="input"
            value={name}
            maxLength={SAVE_NAME_MAX}
            placeholder={t('hud:saves.namePlaceholder')}
            aria-label={t('hud:saves.namePlaceholder')}
            onChange={(e) => setName(e.target.value)}
            data-testid="save-name"
          />
          <button
            type="submit"
            className="btn btn--sm btn--green"
            disabled={busy || !name.trim()}
            data-testid="save-submit"
          >
            {t('hud:saves.save')}
          </button>
        </form>
      )}
      {!isHost && <p className={c.muted}>{t('hud:saves.hostOnly')}</p>}
      <h3>{t('hud:saves.list')}</h3>
      {saves === null && <p className={c.muted}>{t('common.loading')}</p>}
      {saves?.length === 0 && <p className={c.muted}>{t('hud:saves.empty')}</p>}
      <ul className={sy.saveList}>
        {(saves ?? []).map((sv) => (
          <li key={sv.saveId} data-testid={`save-${sv.saveId}`}>
            <div>
              <strong>{sv.name}</strong>
              {!sv.verified && <span className={sy.warnTag}>{t('hud:saves.unofficial')}</span>}
              {!sv.compatible && <span className={sy.warnTag}>{t('hud:saves.incompatible')}</span>}
              {sv.warnings?.includes('tablesHashMismatch') && (
                <span className={sy.warnTag} data-testid={`save-warn-${sv.saveId}`}>
                  {t('hud:saves.tablesMismatch')}
                </span>
              )}
              {sv.kind === 'auto' && <span className={sy.tag}>{t('hud:saves.auto')}</span>}
            </div>
            <div className={c.muted}>
              {t(`lobby:maps.${sv.mapId}`, { defaultValue: sv.mapId })} · {formatDate(sv.date)} ·{' '}
              {t('hud:saves.day', { n: sv.gameDay })} ·{' '}
              {sv.seats
                .map((s) => `${s.nickname}（${t(`characters:${CHARACTER_KEYS[s.characterId]}.name`)}）`)
                .join('、')}
            </div>
            <div className={c.row}>
              {mode === 'lobby' && isHost && sv.compatible && (
                <button
                  type="button"
                  className="btn btn--sm btn--blue"
                  onClick={async () => {
                    const r = await client.loadSave(sv.saveId);
                    toast(r.ok ? t('hud:saves.loaded') : client.errorText(r.error), r.ok ? 'success' : 'warn');
                  }}
                  data-testid={`save-load-${sv.saveId}`}
                >
                  {t('hud:saves.load')}
                </button>
              )}
              <button
                type="button"
                className="btn btn--sm btn--cream"
                onClick={async () => {
                  const r = await client.deleteSave(sv.saveId);
                  if (r.ok) void refresh();
                  else toast(client.errorText(r.error), 'warn');
                }}
                data-testid={`save-delete-${sv.saveId}`}
              >
                {t('hud:saves.delete')}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
