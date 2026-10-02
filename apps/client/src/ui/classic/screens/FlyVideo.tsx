// 开局飞行动画（原版新游戏分支：开局设置 fcn.00406bb2 → 载入地图 fcn.0040779b → fcn.00415184 播 Fly*.avi → 进棋盘；
// 读档分支 0x401ca2 不经过 0x415184）：
// - 只在原版皮肤的房间页（ClassicRoomScreen）播：本页亲眼看到本局从大厅开局，或单机页刚建房开局（ClassicSolo 留下的记号）；
//   读档开局（开局前大厅里有 loadedSave）、刷新 / 重连 / 中途进房（进页时对局已在进行）、观战、?anim=instant 不播；
//   按「房间码 + 局号（epoch）」记在 sessionStorage，同一局只播一次（读写都容错：隐私模式下至多多播一次）；
// - 条目按地图取（layout.FLY_VIDEO，exe 0x472f78），素材包没有或不可用时不播；
// - 只在本地播放，不阻塞引擎与服务器：播放期间暂缓事件回放（EventPlayer.hold），播完或跳过后再开始播积压的批次；
// - 可跳过（按钮、Esc / Enter / 空格，在捕获阶段接管，不会同时触发对局页的空格掷骰）；轮到本人决策（服务器计时照走）
//   时跳过钮醒目；浏览器不许有声自动播放时静音播放并给出「打开声音」；出错、迟迟不开始、超过时长上限都直接结束；
// - 叠在 Loading（ClassicLoading.GameLoading）之上；期间 uiStore.introPlaying 为 true，音频导演层不放棋盘曲，
//   播完再开始（原版 0x41525d：飞行动画之后从棋盘曲第 0 首开始放）。
// 原版随后的机舱与跳伞（jump#41–43+12i+角色）不在这里。
import type { RoomView } from '@rich4/shared/net';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { appFlags } from '../../../app/flags';
import { useClient } from '../../../app/services';
import { useTx } from '../../../i18n/tx';
import type { PackClient } from '../../../skin/pack/PackClient';
import { currentPackClient } from '../../../skin/skinStore';
import { useGameStore } from '../../../store/gameStore';
import { VideoOverlay, videoUrl } from './IntroVideo';
import { flyVideoKey } from './layout';
import s from './screens.module.css';

/** sessionStorage：已经播过（或正在播）飞行动画的那一局，「房间码:局号」 */
export const FLY_SEEN_KEY = 'rich4.flySeen';
/** sessionStorage：单机页刚建房开局的房间码（ClassicSolo 写，房间页读到后清除） */
export const FLY_FRESH_KEY = 'rich4.flyFresh';
/** 这么久还没开始播放就结束（开局时首位玩家的决策计时在走，比片头短） */
export const FLY_STALL_MS = 5_000;
/** 时长上限 = 条目时长 + 这么多（卡在中途也能结束）；条目没有时长时用 FLY_MAX_MS */
export const FLY_SLACK_MS = 3_000;
export const FLY_MAX_MS = 12_000;

function session(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function seenId(code: string, epoch: number): string {
  return `${code}:${epoch}`;
}

export function flySeen(code: string, epoch: number): boolean {
  try {
    return session()?.getItem(FLY_SEEN_KEY) === seenId(code, epoch);
  } catch {
    return false;
  }
}

export function markFlySeen(code: string, epoch: number): void {
  try {
    session()?.setItem(FLY_SEEN_KEY, seenId(code, epoch));
  } catch {
    // 隐私模式：同一局刷新后不会再播（进页时对局已在进行），至多多播一次
  }
}

/** 单机页：刚建房开局，进入房间页时要播飞行动画 */
export function markSoloFresh(code: string): void {
  try {
    session()?.setItem(FLY_FRESH_KEY, code);
  } catch {
    // 记不下就不播
  }
}

/** 房间页：是不是单机页刚开的这一局（读到后清除） */
export function takeSoloFresh(code: string): boolean {
  try {
    const s = session();
    if (s?.getItem(FLY_FRESH_KEY) !== code) return false;
    s.removeItem(FLY_FRESH_KEY);
    return true;
  } catch {
    return false;
  }
}

export interface FlyDecisionInput {
  /** ?anim=instant */
  instant: boolean;
  spectator: boolean;
  /** 该图的飞行动画地址（条目不可用为 null） */
  url: string | null;
  /** 这一局已经播过 */
  seen: boolean;
  /** 本页怎么看到这一局开始的：大厅 → 对局、单机页刚开局；null = 进页时对局已在进行（刷新、重连、中途进房） */
  start: 'lobby' | 'solo' | null;
  /** 开局前的大厅里读了存档（读档继续的局） */
  fromSave: boolean;
  /** 对局视图的已过天数（还没收到快照为 null） */
  elapsedDays: number | null;
}

/** 这一局要不要播飞行动画（原版只在新游戏分支播） */
export function shouldPlayFly(i: FlyDecisionInput): boolean {
  if (i.instant || i.spectator || i.url === null || i.seen || i.fromSave || i.start === null) return false;
  return i.elapsedDays === null || i.elapsedDays === 0;
}

/** 飞行动画的地址与时长上限（条目不可用为 null） */
export function flyMedia(
  client: Pick<PackClient, 'usableEntry' | 'fileUrl'> | null,
  mapId: string,
  canPlay?: (mime: string) => string,
): { url: string; maxMs: number } | null {
  const key = flyVideoKey(mapId);
  if (!key || !client) return null;
  const url = videoUrl(client, key, canPlay);
  if (!url) return null;
  const e = client.usableEntry(key);
  const dur = e?.type === 'video' && e.durationMs > 0 ? e.durationMs : null;
  return { url, maxMs: dur === null ? FLY_MAX_MS : dur + FLY_SLACK_MS };
}

export interface FlyPlan {
  code: string;
  epoch: number;
  mapId: string;
  url: string;
  maxMs: number;
}

/**
 * 房间页用：跟踪本页看到的房间阶段，本局开始时决定要不要播飞行动画（每局只决定一次）。
 * 返回要播的计划与「播完」回调
 */
export function useFlyPlan(code: string, room: RoomView | null): [FlyPlan | null, () => void] {
  const [plan, setPlan] = useState<FlyPlan | null>(null);
  /** 本页最近一次看到的房间阶段与读档状态（换了房间号就不算） */
  const last = useRef<{ code: string; phase: RoomView['phase']; fromSave: boolean } | null>(null);
  /** 已经做过决定的那一局（房间号:局号） */
  const decided = useRef<string | null>(null);
  const mine = room !== null && room.code === code ? room : null;
  const phase = mine?.phase ?? null;
  const epoch = mine?.epoch ?? null;
  const lobbySave = mine?.loadedSave !== undefined;

  // biome-ignore lint/correctness/useExhaustiveDependencies: 只随阶段、局号与读档状态变化判断（房间状态的其他字段频繁更新）
  useEffect(() => {
    if (!mine || phase === null || epoch === null) return;
    const prev = last.current?.code === code ? last.current : null;
    last.current = { code, phase, fromSave: phase === 'lobby' ? lobbySave : (prev?.fromSave ?? false) };
    if (phase !== 'playing' && phase !== 'paused') return;
    if (decided.current === seenId(code, epoch)) return;
    decided.current = seenId(code, epoch);
    const start = prev?.phase === 'lobby' ? 'lobby' : takeSoloFresh(code) ? 'solo' : null;
    const g = useGameStore.getState();
    const media = flyMedia(currentPackClient(), mine.settings.game.mapId);
    const play = shouldPlayFly({
      instant: appFlags().animInstant,
      spectator: mine.you.role === 'spectator',
      url: media?.url ?? null,
      seen: flySeen(code, epoch),
      start,
      fromSave: prev?.phase === 'lobby' && prev.fromSave,
      elapsedDays: g.epoch === epoch && g.view ? g.view.clock.elapsedDays : null,
    });
    if (!play || !media) return;
    markFlySeen(code, epoch);
    setPlan({ code, epoch, mapId: mine.settings.game.mapId, ...media });
  }, [code, phase, epoch, lobbySave]);

  return [plan, () => setPlan(null)];
}

export interface FlyVideoProps {
  url: string;
  maxMs: number;
  onDone(): void;
}

/** 飞行动画层：播放期间暂缓事件回放；轮到本人决策时跳过钮醒目 */
export function FlyVideo({ url, maxMs, onDone }: FlyVideoProps): ReactNode {
  const t = useTx();
  const client = useClient();
  const myTurn = useGameStore((st) => st.decision !== null);
  // 挂载即暂缓，卸载（播完、跳过、离开房间）即解除
  useEffect(() => client.player.hold(), [client]);
  return (
    <VideoOverlay
      url={url}
      onDone={onDone}
      testId="fly"
      label={t('classicScreens:fly.label')}
      skipLabel={t(myTurn ? 'classicScreens:fly.skipTurn' : 'classicScreens:fly.skip')}
      unmuteLabel={t('classicScreens:intro.unmute')}
      urgent={myTurn}
      stallMs={FLY_STALL_MS}
      maxMs={maxMs}
      captureKeys
      className={s.fly}
    />
  );
}
