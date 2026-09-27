// 小游戏原版视图的素材条目与可用性判定（原版皮肤 A13）。不引入 Pixi：宿主在打开时同步判定（决定提前显示的时间），
// 视图模块按需懒加载。
// 回退规则与原版场景一致：必需条目任一缺失、所属组失败或置信度 guess → 整局回退程序化视图（不拼接）；
// 可选条目（气球准星、喜从天降爆炸、企鹅命中掩膜）缺失时只少这一项表现。
import type { AssetEntry, FlicEntry, PackManifestV1 } from '@rich4/shared/assets';
import type { MinigameId } from '@rich4/shared/minigames';
import type { OrigPackSource } from '../../game/orig/OrigAssets';
import type { FlcFile } from '../../skin/flic/FlcDecoder';
import { XICONG_BOOM_KEY } from './frames';

/** 入场「READY GO」FLC（Panel#78，640×480，20 帧 × 114 ms） */
export const READY_KEY = 'mg.ready';
/** HUD 液晶数字与结算大号数字（Panel#79） */
export const HUD_KEY = 'mg.common.hud';

const COMMON: readonly string[] = [HUD_KEY, READY_KEY];

const PENGUIN: readonly string[] = [
  'mg.penguin.screen',
  ...Array.from({ length: 9 }, (_, i) => `mg.penguin.${82 + i}`),
];
const BALLOON: readonly string[] = ['mg.balloon.screen'];
const XICONG: readonly string[] = ['mg.xicong.bg', ...Array.from({ length: 7 }, (_, i) => `mg.xicong.${93 + i}`)];

export function xicongCharKey(characterId: number): string {
  return `mg.xicong.char.${characterId}`;
}

/** 必需条目（喜从天降另需玩家角色的接物姿态；角色未知时不能用原版视图） */
export function origRequiredKeys(id: MinigameId, characterId: number | null): string[] | null {
  switch (id) {
    case 'penguin':
      return [...COMMON, ...PENGUIN];
    case 'balloon':
      return [...COMMON, ...BALLOON];
    case 'xicong':
      return characterId === null || characterId < 0 || characterId > 11
        ? null
        : [...COMMON, ...XICONG, xicongCharKey(characterId)];
  }
}

/** 可选条目 */
export const ORIG_OPTIONAL: Readonly<Record<MinigameId, readonly string[]>> = {
  penguin: ['mg.penguin.mask'],
  balloon: ['ui.cursor'],
  xicong: [XICONG_BOOM_KEY],
};

/** 原版视图需要的素材包能力（PackClient 满足；测试可换替身） */
export interface MgPackSource extends OrigPackSource {
  loadFlic(key: string, signal?: AbortSignal): Promise<{ entry: FlicEntry; flc: FlcFile }>;
}

/** 条目可用（存在、组未失败、非 guess） */
export function entryUsable(pack: Pick<OrigPackSource, 'usableEntry'>, key: string): AssetEntry | null {
  return pack.usableEntry(key);
}

/** 必需条目全部可用时返回清单，否则 null（整局回退） */
export function origPlan(
  pack: Pick<OrigPackSource, 'manifest' | 'usableEntry'> | null,
  id: MinigameId,
  characterId: number | null,
): { keys: string[] } | null {
  if (!pack?.manifest) return null;
  const keys = origRequiredKeys(id, characterId);
  if (!keys) return null;
  for (const k of keys) if (!pack.usableEntry(k)) return null;
  return { keys };
}

/** 入场 FLC 的时长（ms；条目不可用为 0） */
export function readyDurationMs(pack: Pick<OrigPackSource, 'usableEntry'> | null): number {
  const e = pack?.usableEntry(READY_KEY);
  return e?.type === 'flic' ? e.durationMs : 0;
}

// ───────────────────────── 音频 ─────────────────────────

/**
 * 各游戏的原版音效（audio_video.md §2.2 的音效集；调用点语义按 v2.06 exe 核对）：
 * - 企鹅 {11 走路（原版循环）、12 到达开挖、15 挖到炸弹、16 金币、17 红/蓝宝石、18 钻石、13 高分姿势、14 低分姿势}；
 * - 气球 {19 升起、20 打空、21 打中}；喜从天降 {22 炸弹投下、15 被炸}（23 财神走动与 24 炸弹引信是原版循环音，不放）；
 * - 共用 {25 结算}。
 */
export const MG_SFX_SETS: Readonly<Record<MinigameId, readonly number[]>> = {
  penguin: [11, 12, 13, 14, 15, 16, 17, 18, 25],
  balloon: [19, 20, 21, 25],
  xicong: [15, 22, 25],
};

/** 企鹅揭晓音效：埋藏类型 → 音效号（exe 0x472ee1 表：金币 16、红蓝宝石 17、钻石 18；炸弹 15） */
export const PENGUIN_REVEAL_SFX: readonly number[] = [0, 15, 16, 17, 17, 18];

/** 素材包没有该音效时的 ZzFX 预设（合成包、无音频的素材包） */
export const SFX_FALLBACK: Readonly<Record<number, string>> = {
  11: 'step',
  12: 'hammer',
  13: 'fanfare',
  14: 'sad',
  15: 'boom',
  16: 'coin',
  17: 'coin',
  18: 'ding',
  19: 'whoosh',
  20: 'click',
  21: 'stamp',
  22: 'whoosh',
  25: 'fanfare',
};

export function sfxKey(n: number): string {
  return `sfx.${String(n).padStart(3, '0')}`;
}

/** 原版音效键；素材包里没有时换成 ZzFX 回退键（null = 不出声） */
export function resolveSfx(manifest: PackManifestV1 | null, n: number): string | null {
  const key = sfxKey(n);
  if (manifest && Object.hasOwn(manifest.entries, key) && manifest.entries[key]!.type === 'audio') return key;
  const z = SFX_FALLBACK[n];
  return z ? `zzfx.${z}` : null;
}
