// 原版选人画面 + 联机大厅（original-skin.md §4.3；ui.md §2.3）：房间处于大厅阶段时显示。
// 舞台（640×480）：jump#0 背景风景；jump#4 竖栏（关卡、OK / EXIT、6 个下拉显示当前设置）；12 头像格（jump#4 图0 + Data#2，
// 格 i = 角色 i = 头像帧 i）：单击没被选走的头像即选定该角色（同原版：点头像就是选人），单击被选走的只移动光标看预览；
// 悬停显示名字，自己选中的描金边，被别人选走的置灰并标座位；上方 4 个座位牌；中间走动预览（jump#5+3c+v，按房间的行进方式
// 选步行 / 机车 / 汽车）与 ◀ ▶ 翻看、「选这个」。OK = 开始游戏（房主）/ 准备（其他玩家），按下时光标上的角色还没提交就先提交
// （lobby/characterPick：预览里看到的就是进局的角色，不会被服务器随机换掉；已准备后 ◀ ▶ 或单击被选走的头像把光标移开
// 已提交的角色，就先取消准备，再按准备时提交新角色），EXIT = 离开房间。
// 联机信息放两侧侧栏（窄屏收成抽屉）：左栏房间号与邀请链接、读档横幅、座位（补电脑、踢人…）、房间设置（房主可改）、
// 观战者、存档；右栏聊天。逻辑与 testid 与程序化 LobbyView / CharacterPicker / SeatGrid 相同，只换表现层。
import { CHARACTER_IDS, CHARACTER_KEYS, type CharacterId } from '@rich4/shared/engine';
import type { RoomView } from '@rich4/shared/net';
import clsx from 'clsx';
import { type ReactNode, useEffect, useState } from 'react';
import { useClient } from '../../../app/services';
import { useTx } from '../../../i18n/tx';
import { formatDate } from '../../../presentation/names';
import { canStart, mySeatView } from '../../../store/roomStore';
import { takenCharacters } from '../../lobby/characterPick';
import { InviteLink } from '../../lobby/InviteLink';
import { useRun } from '../../lobby/SeatGrid';
import {
  draftFromSettings,
  draftToPatch,
  fetchMapList,
  type MapListingLite,
  type SettingsDraft,
} from '../../lobby/settingsDraft';
import { useCommitPick, usePickCursor } from '../../lobby/useCharacterPick';
import { ChatPanel } from '../../social/ChatPanel';
import { SpectatorList } from '../../social/SpectatorList';
import { SaveLoadMenu, warningText } from '../../system/SaveLoadMenu';
import { ensureClassicImage, useClassicAssets } from '../assets';
import type { RailRenderInfo } from '../ClassicStage';
import cc from '../classic.module.css';
import { useEnsureSceneSprites } from '../common/sceneAssets';
import { regionStyle } from '../layout';
import { Sprite, useSheetStatus } from '../Sprite';
import { SetupColumn, StageBanner } from './ClassicCreate';
import { ClassicSeatList, FaceThumb } from './ClassicSeats';
import { ensureScreensI18n } from './i18n';
import {
  COLUMN_EXIT,
  COLUMN_OK,
  FACE_SHEET,
  fieldLabelRect,
  fieldRect,
  GRID,
  gridCell,
  LOADING_IMAGE,
  PREVIEW,
  SETUP_BG,
  SETUP_FIELDS,
  SETUP_SHEET,
  type SetupField,
  seatPlate,
  sidewalkKey,
  WALK_FRAME_MS,
  WALK_Y,
  walkerAt,
} from './layout';
import { ClassicScreenFrame, HotButton, SceneImage } from './parts';
import s from './screens.module.css';
import { type FieldKey, fieldSpec, RowField } from './settingsFields';
import { playScreenCue } from './uiSound';

/** 大厅里房主可改的设置（电脑人数由座位的「补电脑」决定，个性按座位改） */
const LOBBY_FIELDS: readonly FieldKey[] = [
  'mapId',
  'initialFund',
  'vehicle',
  'tenure',
  'timeLimitDays',
  'winMultiple',
  'rulePreset',
  'minigames',
  'timerPreset',
  'pacing',
  'visibility',
  'allowSpectators',
];

/** 读档后还没人坐的存档座位（同 LobbyView.unclaimedSeats） */
export function unclaimedSeats(room: RoomView): number[] {
  if (!room.loadedSave) return [];
  return room.seats.filter((st) => st.savedSeat !== undefined && st.occupant === null).map((st) => st.index);
}

export interface ClassicLobbyProps {
  room: RoomView;
  onLeave(): void;
}

export default function ClassicLobby({ room, onLeave }: ClassicLobbyProps): ReactNode {
  ensureScreensI18n();
  const t = useTx();
  return (
    <ClassicScreenFrame
      testId="screen-room"
      label={t('classicScreens:lobby.label')}
      attrs={{ 'data-phase': room.phase, 'data-screen': 'select' }}
      left={(info) => <LobbyLeftRail room={room} info={info} />}
      right={(info) => (
        <div className={clsx(cc.railFill, s.chatRail)} data-wide={info.mode === 'drawer' ? 'true' : 'false'}>
          <ChatPanel room={room} visible={info.visible} />
        </div>
      )}
    >
      <SelectStage room={room} onLeave={onLeave} />
    </ClassicScreenFrame>
  );
}

// ───────────────────────── 舞台 ─────────────────────────

function SelectStage({ room, onLeave }: ClassicLobbyProps): ReactNode {
  const t = useTx();
  const client = useClient();
  const run = useRun();
  const me = room.you.role === 'player' ? room.you.seat : null;
  const mine = me === null ? null : (room.seats[me]?.characterId ?? null);
  const host = room.you.isHost;
  const seat = mySeatView(room);
  const ready = seat?.occupant?.kind === 'human' && seat.occupant.ready;
  const startable = canStart(room) && unclaimedSeats(room).length === 0;
  const locked = room.loadedSave !== undefined;
  const picking = me !== null && !locked;
  const taken = takenCharacters(room);
  const [cursor, setCursor] = usePickCursor(room);
  const commitPick = useCommitPick(room, cursor);
  const [hover, setHover] = useState<CharacterId | null>(null);

  // 开局时叠在对局页上的 Loading 整图（Data#560）在大厅里先下载进浏览器缓存：否则开局那一刻图还没下完，只看到黑底文字
  const packId = useClassicAssets((st) => st.packId);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 换素材包时重新取
  useEffect(() => {
    ensureClassicImage(LOADING_IMAGE);
    const url = useClassicAssets.getState().images[LOADING_IMAGE]?.url;
    if (!url || typeof Image === 'undefined') return;
    const im = new Image();
    im.decoding = 'async';
    im.src = url;
  }, [packId]);

  const choose = (id: CharacterId): void => {
    if (taken.has(id) || id === mine) return;
    playScreenCue('click');
    void run(client.selectCharacter(id));
  };
  const step = (d: number): void => {
    playScreenCue('move');
    setCursor(CHARACTER_IDS[(CHARACTER_IDS.indexOf(cursor) + d + 12) % 12]!);
  };
  const cursorTaken = taken.has(cursor);
  const name = (id: CharacterId): string => t(`characters:${CHARACTER_KEYS[id]}.name`);
  const vehicle = room.settings.game.vehicle;

  useEnsureSceneSprites([SETUP_SHEET, FACE_SHEET, sidewalkKey(cursor, vehicle)]);

  const tip = hover ?? null;
  const tipCell = tip === null ? null : gridCell(tip);

  return (
    <div className={s.fill} data-testid="classic-select">
      <SceneImage imageKey={SETUP_BG} w={640} h={480} testId="setup-bg" />
      <StageBanner mapId={room.settings.game.mapId} />
      {room.seats.map((st) => (
        <SeatPlate key={st.index} room={room} index={st.index} />
      ))}
      <SetupColumn mapId={room.settings.game.mapId} />
      <ColumnValues room={room} />

      <Walker character={cursor} vehicle={vehicle} dim={cursorTaken} />

      {picking ? (
        <section data-testid="character-picker" aria-label={t('lobby:picker.title')}>
          <HotButton
            rect={PREVIEW.prev}
            label={t('lobby:picker.prev')}
            testId="char-prev"
            cue="click"
            onPress={() => step(-1)}
          >
            <span className={clsx(s.previewName, s.outline)} style={{ inset: 0 }} aria-hidden="true">
              ◀
            </span>
          </HotButton>
          <div className={clsx(s.previewName, s.outline)} style={regionStyle(PREVIEW.name)}>
            <span>
              <strong data-testid="char-preview-name">{name(cursor)}</strong>
              <small>{t(`characters:${CHARACTER_KEYS[cursor]}.tag`)}</small>
            </span>
          </div>
          <HotButton
            rect={PREVIEW.next}
            label={t('lobby:picker.next')}
            testId="char-next"
            cue="click"
            onPress={() => step(1)}
          >
            <span className={clsx(s.previewName, s.outline)} style={{ inset: 0 }} aria-hidden="true">
              ▶
            </span>
          </HotButton>
          <button
            type="button"
            className={s.band}
            style={regionStyle(PREVIEW.select)}
            disabled={cursorTaken || cursor === mine}
            onClick={() => choose(cursor)}
            data-testid="char-select"
          >
            <span className={s.bandFace}>
              {cursor === mine
                ? t('lobby:picker.selected')
                : cursorTaken
                  ? t('lobby:picker.taken', { n: (taken.get(cursor) ?? 0) + 1 })
                  : t('lobby:picker.select')}
            </span>
          </button>
        </section>
      ) : (
        <div className={clsx(s.previewName, s.outline)} style={regionStyle({ ...PREVIEW.name, w: 300 })}>
          <span>
            <strong>{name(cursor)}</strong>
            {locked && <small>{t('lobby:saved.characterLocked')}</small>}
          </span>
        </div>
      )}

      <Sprite sheet={SETUP_SHEET} frame={0} x={GRID.x} y={GRID.y} origin="topLeft" testId="setup-grid" />
      {CHARACTER_IDS.map((id) => {
        const by = taken.get(id);
        const cell = gridCell(id);
        const face = (
          <>
            <Sprite
              sheet={FACE_SHEET}
              frame={id}
              x={0}
              y={0}
              origin="topLeft"
              fallback={<span className={s.face}>{name(id)}</span>}
            />
            {by !== undefined && <span className={s.seatTag}>{t('lobby:seat.label', { n: by + 1 })}</span>}
          </>
        );
        if (!picking) {
          return (
            <div
              key={id}
              className={s.cell}
              style={regionStyle(cell)}
              data-taken={by !== undefined ? 'true' : 'false'}
              data-mine={id === mine ? 'true' : 'false'}
              aria-hidden="true"
            >
              {face}
            </div>
          );
        }
        return (
          <button
            key={id}
            type="button"
            className={s.cell}
            style={regionStyle(cell)}
            onClick={() => {
              // 没被别人选走的直接选定（choose 自带点击音；同时提交，已准备也不用取消）；
              // 被选走的只移动光标看预览（已准备时移开已提交的角色会先取消准备，见 useCharacterPick）
              if (by === undefined && id !== mine) {
                setCursor(id, { committing: true });
                choose(id);
              } else {
                setCursor(id);
                playScreenCue('move');
              }
            }}
            onPointerEnter={() => setHover(id)}
            onPointerLeave={() => setHover((h) => (h === id ? null : h))}
            onFocus={() => setHover(id)}
            onBlur={() => setHover((h) => (h === id ? null : h))}
            aria-pressed={id === mine}
            aria-disabled={by !== undefined}
            aria-label={name(id)}
            title={name(id)}
            data-testid={`char-${id}`}
            data-taken={by !== undefined ? 'true' : 'false'}
            data-cursor={id === cursor ? 'true' : 'false'}
            data-mine={id === mine ? 'true' : 'false'}
          >
            {face}
          </button>
        );
      })}
      {tip !== null && tipCell && (
        <span
          className={s.tip}
          style={{ left: tipCell.x + tipCell.w / 2, top: tipCell.y - 18 }}
          data-testid="char-tip"
          aria-hidden="true"
        >
          {name(tip)}
        </span>
      )}

      {me !== null && (
        <>
          {host ? (
            <HotButton
              rect={COLUMN_OK}
              label={t('lobby:room.start')}
              testId="room-start"
              disabled={!startable}
              onPress={() => void commitPick().then((ok) => ok && run(client.startGame()))}
            />
          ) : (
            <HotButton
              rect={COLUMN_OK}
              label={ready ? t('lobby:room.unready') : t('lobby:room.ready')}
              testId="room-ready"
              onPress={() =>
                void (ready ? run(client.setReady(false)) : commitPick().then((ok) => ok && run(client.setReady(true))))
              }
              attrs={{ 'aria-pressed': ready }}
            />
          )}
          {host && !startable && (
            <span
              className={s.okDim}
              style={regionStyle({ x: COLUMN_OK.x, y: COLUMN_OK.y + 9, w: 77, h: 37 })}
              aria-hidden="true"
            />
          )}
          {ready && (
            <Sprite
              sheet={SETUP_SHEET}
              frame={8}
              x={COLUMN_OK.x + 58}
              y={COLUMN_OK.y + 2}
              origin="topLeft"
              testId="room-ready-mark"
              fallback={
                <span
                  className={s.checkFallback}
                  style={regionStyle({ x: COLUMN_OK.x + 58, y: COLUMN_OK.y + 2, w: 24, h: 24 })}
                >
                  ✓
                </span>
              }
            />
          )}
        </>
      )}
      <HotButton rect={COLUMN_EXIT} label={t('lobby:room.leave')} testId="room-leave" cue="back" onPress={onLeave} />
    </div>
  );
}

/** 竖栏 6 个下拉框：显示房间当前设置（大厅里在左栏修改） */
function ColumnValues({ room }: { room: RoomView }): ReactNode {
  const t = useTx();
  const g = room.settings.game;
  const ais = room.seats.filter((st) => st.occupant?.kind === 'ai').length;
  const value = (f: SetupField): string => {
    switch (f) {
      case 'aiCount':
        return t('lobby:settings.aiCountValue', { n: ais });
      case 'initialFund':
        return t('lobby:settings.fundValue', { n: g.initialFund / 10000 });
      case 'vehicle':
        return t(`lobby:vehicle.${g.vehicle}`);
      case 'tenure':
        return t(`lobby:tenure.${g.tenure}`);
      case 'timeLimitDays':
        return t(`lobby:timeLimit.${g.timeLimitDays}`);
      case 'winMultiple':
        return g.winMultiple === 0 ? t('lobby:win.none') : t('lobby:win.multiple', { n: g.winMultiple });
    }
  };
  const label = (f: SetupField): string =>
    f === 'aiCount'
      ? t('classicScreens:setup.aiCount')
      : t(
          `lobby:settings.${{ initialFund: 'fund', vehicle: 'vehicle', tenure: 'tenure', timeLimitDays: 'timeLimit', winMultiple: 'win' }[f]}`,
        );
  return (
    <div data-testid="setup-values" title={t('classicScreens:setup.values')}>
      {SETUP_FIELDS.map(({ field, box }) => (
        <div key={field}>
          <span className={clsx(s.boxLabel, s.outline)} style={regionStyle(fieldLabelRect(box))}>
            {label(field)}
          </span>
          <span className={s.boxValue} style={regionStyle(fieldRect(box))} data-testid={`setup-value-${field}`}>
            {value(field)}
          </span>
        </div>
      ))}
    </div>
  );
}

/** 画面上方的座位牌（只显示） */
function SeatPlate({ room, index }: { room: RoomView; index: number }): ReactNode {
  const t = useTx();
  const st = room.seats[index];
  if (!st) return null;
  const o = st.occupant;
  const mine = room.you.role === 'player' && room.you.seat === index;
  const who = o === null ? t('lobby:seat.empty') : o.kind === 'human' ? o.nickname : t('lobby:seat.ai');
  const status =
    o === null
      ? st.savedSeat
        ? t('lobby:saved.unclaimed')
        : ''
      : o.kind === 'ai'
        ? t(`lobby:aiPreset.${o.ai.preset}`)
        : !o.connected
          ? t('lobby:seat.offline')
          : st.isHost
            ? t('lobby:seat.host')
            : o.ready
              ? t('lobby:seat.ready')
              : t('lobby:seat.notReady');
  return (
    <div
      className={s.plateSeat}
      style={regionStyle(seatPlate(index))}
      data-testid={`classic-seat-${index}`}
      data-kind={o ? o.kind : 'empty'}
      data-mine={mine ? 'true' : 'false'}
      aria-hidden="true"
    >
      <FaceThumb character={st.characterId} size={44} />
      <div>
        <div className={clsx(s.plateName, s.outline)}>
          {t('lobby:seat.label', { n: index + 1 })} {who}
        </div>
        <div className={s.plateSub}>{status}</div>
      </div>
    </div>
  );
}

/** 侧视走动预览：在风景上来回走（向左时水平翻转）；动画减弱时停在中间 */
function Walker({
  character,
  vehicle,
  dim,
}: {
  character: CharacterId;
  vehicle: RoomView['settings']['game']['vehicle'];
  dim: boolean;
}): ReactNode {
  const t = useTx();
  const key = sidewalkKey(character, vehicle);
  const frames = useClassicAssets((st) => st.sprites[key]?.frames.length ?? 0);
  const status = useSheetStatus(key);
  const [now, setNow] = useState(0);
  const reduce = useReducedMotionPref();

  useEffect(() => {
    if (reduce || frames === 0) return;
    const t0 = performance.now();
    const id = setInterval(() => setNow(performance.now() - t0), WALK_FRAME_MS);
    return () => clearInterval(id);
  }, [reduce, frames]);

  if (status !== 'ready') return null;
  const w = reduce ? { x: 225, frame: 0, facingLeft: false } : walkerAt(now, frames, vehicle);
  return (
    <div
      className={s.walker}
      style={{ opacity: dim ? 0.5 : 1 }}
      role="img"
      aria-label={t('classicScreens:lobby.walker', { name: t(`characters:${CHARACTER_KEYS[character]}.name`) })}
      data-testid="char-walker"
      data-sheet={key}
      data-facing={w.facingLeft ? 'left' : 'right'}
    >
      <Sprite sheet={key} frame={w.frame} x={w.x} y={WALK_Y} />
    </div>
  );
}

function useReducedMotionPref(): boolean {
  const [r, setR] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = (): void => setR(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return r;
}

// ───────────────────────── 左栏 ─────────────────────────

function LobbyLeftRail({ room, info }: { room: RoomView; info: RailRenderInfo }): ReactNode {
  const t = useTx();
  const client = useClient();
  const run = useRun();
  const host = room.you.isHost;
  const unclaimed = unclaimedSeats(room);
  const startable = canStart(room) && unclaimed.length === 0;
  const [savesOpen, setSavesOpen] = useState(false);
  const wide = info.mode === 'drawer';
  return (
    <div className={s.railBox} data-wide={wide ? 'true' : 'false'}>
      <section className={cc.box}>
        <h3>{t('lobby:room.title', { code: room.code })}</h3>
        <InviteLink code={room.code} allowWatch={room.settings.allowSpectators} />
        {room.you.role === 'spectator' && <strong>👁 {t('lobby:room.spectating')}</strong>}
      </section>
      <LoadedSaveBanner room={room} />
      <section className={cc.box}>
        <h3>{t('classic:rail.seats')}</h3>
        <ClassicSeatList room={room} />
        {host && !startable && (
          <p className={s.seatStatus} data-testid="start-hint">
            {unclaimed.length > 0
              ? t('lobby:saved.startHint', { seats: unclaimed.map((i) => `${i + 1}P`).join('、') })
              : t('lobby:room.startHint')}
          </p>
        )}
        <div className={s.railBtns}>
          {room.you.role === 'player' && room.settings.allowSpectators && (
            <button
              type="button"
              className={s.railBtn}
              onClick={() => void run(client.toSpectator())}
              data-testid="room-to-spectator"
            >
              {t('lobby:room.toSpectator')}
            </button>
          )}
          {host && (
            <button
              type="button"
              className={s.railBtn}
              onClick={() => void run(client.dissolve())}
              data-testid="room-dissolve"
            >
              {t('lobby:room.dissolve')}
            </button>
          )}
        </div>
      </section>
      <section className={cc.box}>
        <h3>{t('lobby:room.settings')}</h3>
        <LobbySettings room={room} />
      </section>
      <section className={cc.box}>
        <SpectatorList room={room} />
      </section>
      {host && (
        <details
          className={clsx(cc.box, s.savesBox)}
          data-testid="lobby-saves"
          open={savesOpen}
          onToggle={(e) => setSavesOpen(e.currentTarget.open)}
        >
          <summary data-testid="lobby-saves-toggle">{t('lobby:room.loadSave')}</summary>
          {savesOpen && (
            <div>
              <SaveLoadMenu mode="lobby" isHost={host} onLoaded={() => setSavesOpen(false)} />
            </div>
          )}
        </details>
      )}
    </div>
  );
}

/** 房间设置：房主直接修改（改一项发一次 room:updateSettings）；其他人与读档后只读 */
function LobbySettings({ room }: { room: RoomView }): ReactNode {
  const t = useTx();
  const client = useClient();
  const run = useRun();
  const editable = room.you.isHost && room.loadedSave === undefined;
  const [draft, setDraft] = useState<SettingsDraft>(() => draftFromSettings(room.settings));
  const [maps, setMaps] = useState<MapListingLite[]>([]);

  useEffect(() => {
    setDraft(draftFromSettings(room.settings));
  }, [room.settings]);

  useEffect(() => {
    if (!editable) return;
    let stale = false;
    void fetchMapList().then((r) => !stale && setMaps(r.maps));
    return () => {
      stale = true;
    };
  }, [editable]);

  const change = async (d: SettingsDraft): Promise<void> => {
    setDraft(d);
    if (!(await run(client.updateSettings(draftToPatch(d))))) setDraft(draftFromSettings(room.settings));
  };

  return (
    <div className={clsx(s.railSettings)} data-testid="room-settings">
      {LOBBY_FIELDS.map((k) => (
        <RowField
          key={k}
          spec={fieldSpec(k, t, draft.mapId, maps)}
          draft={draft}
          onChange={(d) => void change(d)}
          disabled={!editable}
        />
      ))}
    </div>
  );
}

/** 读档横幅：存档名、游戏日期、天数；非官方存档与兼容性提示（testid 同 LobbyView） */
function LoadedSaveBanner({ room }: { room: RoomView }): ReactNode {
  const t = useTx();
  const ls = room.loadedSave;
  if (!ls) return null;
  return (
    <section className={cc.box} role="status" data-testid="loaded-save" data-save={ls.saveId}>
      <span>
        💾 {t('lobby:saved.banner', { name: ls.name, date: ls.date ? formatDate(ls.date) : '', day: ls.gameDay })}
      </span>
      {!ls.verified && (
        <span className={s.warnTag} data-testid="loaded-unofficial" title={t('ui:saveMenu.unofficialNote')}>
          {t('hud:saves.unofficial')}
        </span>
      )}
      {(ls.warnings ?? []).map((w) => (
        <span key={w} className={s.warnTag} data-testid={`loaded-warn-${w}`}>
          {warningText(t, w)}
        </span>
      ))}
      <p className={s.seatStatus}>{t('lobby:saved.hint')}</p>
    </section>
  );
}
