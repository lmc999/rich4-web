// 存档与读档（design/client.md §5.7，按 architecture §5.12 只做服务器存档）：
// - 对局中房主命名存档（game:save）；列出本人参与过的服务器存档（saves:list），显示地图、游戏日期、天数、玩家、存档时间；
// - 大厅中房主读档（room:loadSave），之后座位显示「原：角色 / 昵称，待认领」；
// - 首页（mode='home'）：列出本人拥有的存档，读取时新建私密房间并 room:loadSave，成功后回调房间号进房；
// - 任何 owner 都能删除（saves:delete，二次确认）、导出 .r4save（GET /api/saves/:id/export）、
//   导入文件（POST /api/saves/import）；签名无效标「非官方存档」，兼容性提示逐条显示。
import { CHARACTER_KEYS } from '@rich4/shared/engine';
import type { AppError, SaveSummary, SaveWarning } from '@rich4/shared/net';
import { SAVE_NAME_MAX } from '@rich4/shared/net';
import clsx from 'clsx';
import { type ChangeEvent, type FormEvent, type ReactNode, useCallback, useEffect, useState } from 'react';
import { useClient } from '../../app/services';
import { type LooseT, useTx } from '../../i18n/tx';
import type { GameClient } from '../../net/client';
import {
  downloadText,
  exportSaveText,
  importSaveText,
  readSaveFile,
  SAVE_FILE_EXT,
  type SaveHttpOptions,
} from '../../net/saveFiles';
import { formatDate } from '../../presentation/names';
import { useUiStore } from '../../store/uiStore';
import c from '../common/common.module.css';
import sy from './system.module.css';

export interface SaveLoadMenuProps {
  /** 对局中（可存档）、大厅（房主可读档）或首页（新建私密房间读档） */
  mode: 'game' | 'lobby' | 'home';
  isHost: boolean;
  /** 默认存档名（例如「1998年3月12日」） */
  defaultName?: string;
  /** 测试注入 fetch 等 */
  http?: SaveHttpOptions;
  /** 读档成功回调（大厅收起存档面板；首页带新房间号） */
  onLoaded?(saveId: string, roomCode?: string): void;
  /** 对局中是否显示存档表单（缺省显示；经典外壳的 LOAD 钮只列出存档） */
  saveForm?: boolean;
}

/** 兼容性提示的文案键 */
const WARNING_KEYS: Record<SaveWarning, string> = {
  tablesHashMismatch: 'hud:saves.tablesMismatch',
  needsMigration: 'ui:saveMenu.warn.needsMigration',
  chatTailDropped: 'ui:saveMenu.warn.chatTailDropped',
};

export function warningText(t: LooseT, w: SaveWarning): string {
  return t(WARNING_KEYS[w] ?? 'ui:saveMenu.warn.unknown', { defaultValue: w });
}

/** 存档相关错误的具体文案（进行中对局禁止导出 / 读档、不兼容原因、文件过大、网络） */
export function saveErrorText(t: LooseT, client: GameClient, e: AppError): string {
  const reason = (e.details as { reason?: unknown } | undefined)?.reason;
  if (e.code === 'SAVE_FORBIDDEN' && reason === 'gameInProgress') return t('ui:saveMenu.err.gameInProgress');
  if (e.code === 'SAVE_INCOMPATIBLE') {
    const detail = typeof reason === 'string' ? t(`ui:saveMenu.incompat.${reason}`, { defaultValue: reason }) : '';
    return detail ? t('ui:saveMenu.err.incompatibleWhy', { reason: detail }) : client.errorText(e);
  }
  if (e.code === 'BAD_REQUEST' && reason === 'tooLarge') return t('ui:saveMenu.err.tooLarge');
  if (e.code === 'BAD_REQUEST' && reason === 'emptyBody') return t('ui:saveMenu.err.empty');
  if (e.code === 'BAD_REQUEST' && reason === 'unreadable') return t('ui:saveMenu.err.unreadable');
  if (e.code === 'INTERNAL' && reason === 'network') return t('ui:saveMenu.err.network');
  return client.errorText(e);
}

function realTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function SaveItem({
  sv,
  canLoad,
  highlight,
  onLoad,
  onExport,
  onDelete,
}: {
  sv: SaveSummary;
  canLoad: boolean;
  highlight: boolean;
  onLoad(): Promise<void>;
  onExport(): Promise<void>;
  onDelete(): Promise<void>;
}): ReactNode {
  const t = useTx();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  const id = sv.saveId;
  return (
    <li
      className={clsx(highlight && sy.saveNew)}
      data-testid={`save-${id}`}
      data-verified={sv.verified ? 'true' : 'false'}
      data-name={sv.name}
    >
      <div>
        <strong className={sy.saveName}>{sv.name}</strong>
        {sv.kind === 'auto' && <span className={sy.tag}>{t('hud:saves.auto')}</span>}
        {!sv.verified && (
          <span className={sy.warnTag} data-testid={`save-unofficial-${id}`} title={t('ui:saveMenu.unofficialNote')}>
            {t('hud:saves.unofficial')}
          </span>
        )}
        {!sv.compatible && <span className={sy.warnTag}>{t('hud:saves.incompatible')}</span>}
        {(sv.warnings ?? []).map((w) => (
          <span
            key={w}
            className={sy.warnTag}
            data-testid={w === 'tablesHashMismatch' ? `save-warn-${id}` : `save-warn-${w}-${id}`}
            title={w === 'tablesHashMismatch' ? t('hud:saves.tablesMismatchNote') : undefined}
          >
            {warningText(t, w)}
          </span>
        ))}
      </div>
      <div className={c.muted}>
        {t(`lobby:maps.${sv.mapId}`, { defaultValue: sv.mapId })} · {formatDate(sv.date)} ·{' '}
        {t('hud:saves.day', { n: sv.gameDay })}
      </div>
      <div className={c.muted}>
        {sv.seats
          .map(
            (s) => `${s.wasHuman ? '' : '🤖'}${s.nickname}（${t(`characters:${CHARACTER_KEYS[s.characterId]}.name`)}）`,
          )
          .join('、')}
      </div>
      <div className={c.muted}>{t('ui:saveMenu.savedAt', { time: realTime(sv.createdAt) })}</div>
      <div className={c.row}>
        {canLoad && (
          <button
            type="button"
            className="btn btn--sm btn--blue"
            disabled={busy || !sv.compatible}
            onClick={() => void run(onLoad)}
            data-testid={`save-load-${id}`}
          >
            {t('hud:saves.load')}
          </button>
        )}
        <button
          type="button"
          className="btn btn--sm btn--cream"
          disabled={busy}
          onClick={() => void run(onExport)}
          data-testid={`save-export-${id}`}
        >
          {t('ui:saveMenu.export')}
        </button>
        {confirm ? (
          <>
            <button
              type="button"
              className={clsx('btn btn--sm', sy.danger)}
              disabled={busy}
              onClick={() => void run(onDelete)}
              data-testid={`save-delete-confirm-${id}`}
            >
              {t('ui:saveMenu.deleteConfirm')}
            </button>
            <button type="button" className="btn btn--sm btn--cream" onClick={() => setConfirm(false)}>
              {t('ui:saveMenu.cancel')}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn btn--sm btn--cream"
            disabled={busy}
            onClick={() => setConfirm(true)}
            data-testid={`save-delete-${id}`}
          >
            {t('hud:saves.delete')}
          </button>
        )}
      </div>
    </li>
  );
}

export function SaveLoadMenu({
  mode,
  isHost,
  defaultName = '',
  http,
  onLoaded,
  saveForm = true,
}: SaveLoadMenuProps): ReactNode {
  const t = useTx();
  const client = useClient();
  const [saves, setSaves] = useState<SaveSummary[] | null>(null);
  /** 列表加载失败的原因（不要显示成「暂无存档」，免得以为存档没了） */
  const [listError, setListError] = useState<string | null>(null);
  const [name, setName] = useState(defaultName);
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const r = await client.listSaves();
    if (r.ok) {
      setSaves([...r.data.saves].sort((a, b) => b.createdAt - a.createdAt));
      setListError(null);
      return;
    }
    const text = t('ui:saveMenu.err.listFailed', { reason: saveErrorText(t, client, r.error) });
    setListError(text);
    useUiStore.getState().toast(text, 'warn', 5000);
  }, [client, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toast = (text: string, kind: 'success' | 'warn' | 'info' = 'success'): void => {
    useUiStore.getState().toast(text, kind, kind === 'warn' ? 5000 : undefined);
  };
  const fail = (e: AppError): void => toast(saveErrorText(t, client, e), 'warn');

  const save = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    const r = await client.save(n);
    setBusy(false);
    if (r.ok) {
      toast(t('hud:saves.saved'));
      setFresh(r.data.saveId);
      void refresh();
    } else fail(r.error);
  };

  const importFile = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const input = e.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    setBusy(true);
    try {
      const text = await readSaveFile(file);
      if (!text.ok) return fail(text.error);
      const r = await importSaveText(text.data, http);
      if (!r.ok) return fail(r.error);
      setFresh(r.data.saveId);
      if (r.data.verified) toast(t('ui:saveMenu.imported', { name: r.data.name }));
      else toast(t('ui:saveMenu.importedUnofficial', { name: r.data.name }), 'warn');
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const exportOne = async (sv: SaveSummary): Promise<void> => {
    const r = await exportSaveText(sv.saveId, http);
    if (!r.ok) return fail(r.error);
    const filename = r.data.filename.endsWith(SAVE_FILE_EXT) ? r.data.filename : `${sv.name}${SAVE_FILE_EXT}`;
    if (downloadText(r.data.text, filename)) toast(t('ui:saveMenu.exported', { name: sv.name }), 'info');
  };

  const loadOne = async (sv: SaveSummary): Promise<void> => {
    if (mode === 'home') return loadIntoNewRoom(sv);
    const r = await client.loadSave(sv.saveId);
    if (!r.ok) return fail(r.error);
    toast(t('hud:saves.loaded'));
    onLoaded?.(sv.saveId);
  };

  /** 首页读档：新建私密房间 → room:loadSave；读档失败（例如对局还在进行）时离开这个临时房间 */
  const loadIntoNewRoom = async (sv: SaveSummary): Promise<void> => {
    const created = await client.createRoom({ visibility: 'private' });
    if (!created.ok) return fail(created.error);
    const r = await client.loadSave(sv.saveId);
    if (!r.ok) {
      await client.leaveRoom();
      return fail(r.error);
    }
    // 读档时房间设置整体取存档（含公开性）：从首页读档的房间保持私密，邀请链接发给原来的玩家
    const v = await client.updateSettings({ visibility: 'private' });
    if (!v.ok) toast(client.errorText(v.error), 'warn');
    toast(t('ui:saveMenu.loadedNewRoom', { code: created.data.code }));
    onLoaded?.(sv.saveId, created.data.code);
  };

  const deleteOne = async (sv: SaveSummary): Promise<void> => {
    const r = await client.deleteSave(sv.saveId);
    if (r.ok) await refresh();
    else fail(r.error);
  };

  return (
    <section className={sy.saves} data-testid="save-load" data-mode={mode}>
      {mode === 'game' && isHost && saveForm && (
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
      {!isHost && saveForm && <p className={c.muted}>{t('hud:saves.hostOnly')}</p>}
      <div className={sy.saveHead}>
        <h3>{t('hud:saves.list')}</h3>
        <label className={clsx('btn btn--sm btn--cream', busy && sy.disabled)} data-testid="save-import">
          📂 {t('ui:saveMenu.import')}
          <input
            type="file"
            accept={`${SAVE_FILE_EXT},text/plain,application/octet-stream`}
            className={sy.fileInput}
            disabled={busy}
            onChange={(e) => void importFile(e)}
            data-testid="save-import-file"
          />
        </label>
      </div>
      {listError !== null && (
        <p className={c.muted} role="alert" data-testid="save-list-error">
          {listError}{' '}
          <button type="button" className="btn btn--sm btn--cream" onClick={() => void refresh()}>
            {t('common.retry')}
          </button>
        </p>
      )}
      {saves === null && listError === null && <p className={c.muted}>{t('common.loading')}</p>}
      {listError === null && saves?.length === 0 && <p className={c.muted}>{t('hud:saves.empty')}</p>}
      <ul className={sy.saveList} data-testid="save-list">
        {(saves ?? []).map((sv) => (
          <SaveItem
            key={sv.saveId}
            sv={sv}
            canLoad={mode === 'home' || (mode === 'lobby' && isHost)}
            highlight={fresh === sv.saveId}
            onLoad={() => loadOne(sv)}
            onExport={() => exportOne(sv)}
            onDelete={() => deleteOne(sv)}
          />
        ))}
      </ul>
    </section>
  );
}
