// 音频接线（原版皮肤 A9 × A5；由 app/audio.ts 懒加载）：
// - 引擎：createAudioSystem 绑定 settingsStore（五路音量、静音、角色语音、后台静音），首次手势解锁；
// - 事件：GameClient.setAudio 接上导演层——每个事件 handler 开始时按 soundMap 放音效 / 语音（语音用 ctx.at 的
//   {epoch, seq, eventIndex} 确定性选择），事件场景曲在 handler 结束时收起；演出中止（reset / skipAll / 离开房间）时 reset；
//   没播放就提交的事件（后台标签页、instant）经 observe 收起以它为终点的场景曲（拍卖曲）；
// - 素材包：皮肤判定为原版且素材包就绪时，音频来源换成素材包（PackClient 的 manifest + 带哈希路径 → URL，映射表逐张校验），
//   否则只用 ZzFX 程序化音效（无语音、无音乐）；映射表或音频文件被 401（cookie 过期、被吊销）时 notePackAccessDenied：
//   显示门禁页，通过后 skinStore 整体重载素材包，这里随之重新 applyPack（清空失败记为 null 的音频缓存）；
// - 场景曲：房间 / 对局 / 结算与当前场所（本人的决策，或他人公开的场所决策）、今日节日 → director.setUi；
//   原版片头播放期间（uiStore.introPlaying）标题画面不放标题曲；
// - 测试钩子：window.__rich4.audio（state、log、music()、clearLog()）。
import type { PackManifestV1 } from '@rich4/shared/assets';
import type { MapIndex } from '@rich4/shared/data';
import type { BailOptions, DecisionKind, MinigameOptions, SeatIndex } from '@rich4/shared/engine';
import type { RoomView, YourDecision } from '@rich4/shared/net';
import type { GameView, PendingView } from '@rich4/shared/view';
import {
  type AudioSystem,
  type AudioUiState,
  type AudioVenue,
  audioCtxOf,
  browserAudioEnv,
  createAudioSystem,
  holidaySceneOf,
  venueScene,
} from '../audio';
import { testHooks } from '../dev/testHooks';
import type { GameClient } from '../net/client';
import { currentPackClient, notePackAccessDenied, type SkinState, useSkinStore } from '../skin/skinStore';
import { useGameStore } from '../store/gameStore';
import { mySeat, useRoomStore } from '../store/roomStore';
import { useSettingsStore } from '../store/settingsStore';
import { useUiStore } from '../store/uiStore';
import { testHooksEnabled } from './flags';

// ───────────────────────── UI 状态 → 场景（纯函数） ─────────────────────────

/**
 * 他人的决策里全场可见的场所（原版所有人同屏看场所屏）。监狱 / 医院（BAIL）与小游戏需要决策私有的 options
 * 才分得清，只按本人的决策处理。
 */
const PUBLIC_VENUES: ReadonlySet<DecisionKind> = new Set<DecisionKind>([
  'BANK_ATM',
  'BANK_COUNTER',
  'SHOP',
  'LOTTERY',
  'MAGIC_CAST',
  'AUCTION_BID',
]);

export interface AudioUiInput {
  room: RoomView | null;
  view: GameView | null;
  decision: YourDecision | null;
  pending: readonly PendingView[];
  /** 收到 game:over */
  over: boolean;
  map: MapIndex | null;
  /** 原版片头正在播放（标题画面上）：不放标题曲，片头结束后再放 */
  intro?: boolean;
}

/** 当前场所：本人的决策优先（带监狱 / 医院与小游戏种类），否则取他人公开的场所决策 */
export function venueOf(
  decision: YourDecision | null,
  pending: readonly PendingView[],
  me: SeatIndex | null,
): AudioVenue | null {
  if (decision) {
    const v: AudioVenue = { kind: decision.kind };
    if (decision.kind === 'BAIL') v.where = (decision.options as BailOptions).where;
    if (decision.kind === 'MINIGAME') v.minigameId = (decision.options as MinigameOptions).minigameId;
    if (venueScene(v) !== null) return v;
  }
  for (const p of pending) {
    if (p.seat !== me && PUBLIC_VENUES.has(p.kind)) return { kind: p.kind };
  }
  return null;
}

/** 房间与对局状态 → 导演层的 UI 状态 */
export function audioUiStateOf(i: AudioUiInput): AudioUiState {
  const room = i.room;
  if (!room) return i.intro ? { screen: 'none' } : { screen: 'title' };
  if (room.phase === 'lobby') return { screen: 'lobby' };
  if (room.phase === 'ended' || i.over) return { screen: 'gameOver' };
  if (!i.view) return { screen: 'game', venue: null, holiday: null };
  return {
    screen: 'game',
    venue: venueOf(i.decision, i.pending, mySeat(room)),
    holiday: holidaySceneOf(i.view, i.map),
  };
}

function uiKey(s: AudioUiState): string {
  const v = s.venue;
  return [s.screen, v ? `${v.kind}/${v.where ?? ''}/${v.minigameId ?? ''}` : '-', s.holiday ?? '-'].join('|');
}

/** 音频用哪个素材包：皮肤判定为原版且素材包就绪时用它，否则 null（ZzFX 回退） */
export function packForAudio(s: Pick<SkinState, 'pack' | 'resolution'>): PackManifestV1 | null {
  return s.pack.status === 'ready' && s.resolution.skin === 'original' ? s.pack.manifest : null;
}

// ───────────────────────── 接线 ─────────────────────────

export interface WireAudioOptions {
  /** 测试注入（缺省新建一套并绑定 settingsStore） */
  system?: AudioSystem;
  /** 映射表下载（缺省 fetch；401 → 门禁页） */
  fetchJson?(url: string): Promise<unknown>;
}

async function fetchPackJson(url: string): Promise<unknown> {
  const r = await fetch(url, { credentials: 'same-origin' });
  if (r.status === 401) notePackAccessDenied();
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<unknown>;
}

/** 素材包音频文件被门禁拒绝（401）：显示门禁页，通过后整体重载素材包 */
export function onAudioHttpError(status: number): void {
  if (status === 401) notePackAccessDenied();
}

let wired: { system: AudioSystem; off(): void } | null = null;

/** 当前接好的音频系统（没有为 null） */
export function wiredAudio(): AudioSystem | null {
  return wired?.system ?? null;
}

/** 把音频接到 GameClient 与各 store；返回撤销函数（幂等：已接好时直接返回现有的撤销） */
export function wireAudio(client: GameClient, o: WireAudioOptions = {}): () => void {
  if (wired) return wired.off;
  const system =
    o.system ??
    createAudioSystem({ settings: useSettingsStore, env: browserAudioEnv({ onHttpError: onAudioHttpError }) });
  const fetchJson = o.fetchJson ?? fetchPackJson;
  const offs: (() => void)[] = [];

  client.setAudio({
    onEvent: (e, ctx) => {
      const a = system.director.onEvent(e, audioCtxOf(ctx));
      return () => a.end();
    },
    port: system.port(),
    reset: () => system.director.reset(),
    observe: (e) => system.director.observe(e),
  });
  offs.push(() => client.setAudio(null));

  // 素材包（同一份 manifest 只应用一次；切换期间的旧请求由 AudioSystem 按代次丢弃）
  let applied: PackManifestV1 | null = null;
  const syncPack = (): void => {
    const want = packForAudio(useSkinStore.getState());
    if (want === applied) return;
    applied = want;
    const urlOf = currentPackClient()?.urlOf;
    void system
      .applyPack(want, { ...(urlOf ? { urlOf } : {}), fetchJson })
      .then(() => {
        if (system.packIssues.length > 0) console.warn('[audio] 素材包映射表有问题，相关声音走回退', system.packIssues);
      })
      .catch((e: unknown) => console.warn('[audio] 应用素材包失败', e));
  };
  offs.push(useSkinStore.subscribe(syncPack));
  syncPack();

  // 场景曲（房间、对局、场所、节日）
  let lastUi = '';
  const syncUi = (): void => {
    const g = useGameStore.getState();
    const ui = audioUiStateOf({
      room: useRoomStore.getState().room,
      view: g.view,
      decision: g.decision,
      pending: g.pending,
      over: g.over !== null,
      map: client.currentMap,
      intro: useUiStore.getState().introPlaying,
    });
    const k = uiKey(ui);
    if (k === lastUi) return;
    lastUi = k;
    system.director.setUi(ui);
  };
  offs.push(useRoomStore.subscribe(syncUi), useGameStore.subscribe(syncUi), useUiStore.subscribe(syncUi));
  syncUi();

  const h = testHooksEnabled() ? testHooks() : null;
  if (h) {
    h.audio = system.hooks();
    offs.push(() => {
      if (h.audio && wired?.system === system) h.audio = null;
    });
  }

  const off = (): void => {
    for (const f of offs.splice(0)) f();
    if (wired?.system === system) wired = null;
    if (!o.system) system.dispose();
  };
  wired = { system, off };
  return off;
}
