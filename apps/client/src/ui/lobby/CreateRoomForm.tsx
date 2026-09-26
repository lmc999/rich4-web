// 建房表单（design/client.md §5.5）：提交 room:create，然后按「电脑补位」给 1..N 号座位补电脑，回调房间号。
import type { SeatIndex } from '@rich4/shared/engine';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { useClient } from '../../app/services';
import { useTx } from '../../i18n/tx';
import c from '../common/common.module.css';
import l from './lobby.module.css';
import { RoomSettingsFields } from './RoomSettingsFields';
import { applyQuickPreset, defaultDraft, draftToPatch, fetchMapList, type MapListingLite } from './settingsDraft';

export interface CreateRoomFormProps {
  onCreated(code: string): void;
}

export function CreateRoomForm({ onCreated }: CreateRoomFormProps): ReactNode {
  const t = useTx();
  const client = useClient();
  const [draft, setDraft] = useState(() => defaultDraft('taiwan'));
  const [maps, setMaps] = useState<MapListingLite[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    void fetchMapList().then((r) => {
      if (stale) return;
      setMaps(r.maps);
      setDraft((d) => (r.maps.some((m) => m.id === d.mapId) ? d : { ...d, mapId: r.defaultMap }));
    });
    return () => {
      stale = true;
    };
  }, []);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await client.createRoom(draftToPatch(draft));
    if (!r.ok) {
      setBusy(false);
      setError(client.errorText(r.error));
      return;
    }
    for (let i = 1; i <= draft.aiCount; i++) {
      const a = await client.setSeatAi(i as SeatIndex, { preset: draft.aiPreset });
      if (!a.ok) {
        setError(client.errorText(a.error));
        break;
      }
    }
    setBusy(false);
    onCreated(r.data.code);
  };

  return (
    <form className={`panel ${l.createForm}`} onSubmit={submit} data-testid="create-form">
      <h2>{t('lobby:create.title')}</h2>
      <RoomSettingsFields draft={draft} onChange={setDraft} maps={maps} withAi disabled={busy} />
      <div className={c.row} style={{ justifyContent: 'center', marginTop: 12 }}>
        <button
          type="button"
          className="btn btn--sm btn--cream"
          onClick={() => setDraft(applyQuickPreset(draft))}
          data-testid="create-quick"
        >
          {t('lobby:create.quick')}
        </button>
        <button type="submit" className="btn btn--green" disabled={busy} data-testid="create-submit">
          {busy ? t('lobby:create.creating') : t('lobby:create.submit')}
        </button>
      </div>
      {error && (
        <p className={c.error} role="alert" data-testid="create-error">
          {error}
        </p>
      )}
    </form>
  );
}
