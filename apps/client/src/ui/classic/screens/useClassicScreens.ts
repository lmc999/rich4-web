// 标题 / 开局 / 大厅画面按皮肤切换（original-skin.md §4.3、A14）：原版皮肤判定只看素材包（不依赖地图）——
// 设置不是「程序化」、门禁已通过（或关闭）、素材包就绪、皮肤判定为 original，且这几屏用到的条目全部可用
// （标题 Data#1、开局部件 jump#4、背景 jump#0、72×72 头像、36 段侧视走动；缺失 / 组缺失 / guess 任一 → 整体回退程序化）。
// - 素材包还在发现中：pending（显示载入画面，不先画程序化首页再切换——E2E 与真人都不会在切换瞬间点到旧画面）；
//   超过 PENDING_MAX_MS 仍未判定 → 程序化。等待的起点是全局的（这一轮发现开始时），之后挂上的路由不再从头等；
//   判定有了结论（或设置改成程序化）后清掉，下一轮发现重新计时；
// - 路由实例里的画面用 usePinnedScreens：离开 pending 后固定——超时判成程序化之后素材包才就绪，不在画面中途换成原版
//   （首页丢输入、单机页二次建房）；皮肤设置或门禁状态变化时重新判定；
// - 门禁开启而未通过：直接程序化，**不**从首页触发门禁页（启动时的 bootstrapAccess 已经负责），通过后重新判定；
// - 判定为原版时把素材包绑定到经典画面的素材仓库（bindClassicAssets，进入对局后 ClassicLayout 绑定同一个包不重复加载）。
import { useEffect, useLayoutEffect, useReducer, useRef } from 'react';
import type { PackClient } from '../../../skin/pack/PackClient';
import { currentPackClient, useSkinStore } from '../../../skin/skinStore';
import type { PackState, SkinPref, SkinResolution } from '../../../skin/types';
import { useSettingsStore } from '../../../store/settingsStore';
import { useAccessStore } from '../../access/accessStore';
import { bindClassicAssets } from '../assets';
import { SCREEN_KEYS } from './layout';

export type ScreensMode = 'pending' | 'classic' | 'procedural';

/** 素材包发现最多等这么久（之后按程序化画面显示） */
export const PENDING_MAX_MS = 6000;

export interface ScreensInput {
  pref: SkinPref;
  access: { mode: string; granted: boolean } | null;
  pack: PackState['status'];
  resolution: Pick<SkinResolution, 'skin'>;
  /** 这几屏的条目全部可用 */
  keysOk: boolean;
  timedOut: boolean;
}

/** 纯函数：当前该显示哪套画面 */
export function decideScreens(i: ScreensInput): ScreensMode {
  if (i.pref === 'procedural') return 'procedural';
  if (i.access && i.access.mode !== 'off' && !i.access.granted) return 'procedural';
  switch (i.pack) {
    case 'ready':
      return i.resolution.skin === 'original' && i.keysOk ? 'classic' : 'procedural';
    case 'absent':
    case 'access-required':
      return 'procedural';
    default:
      return i.timedOut ? 'procedural' : 'pending';
  }
}

/** 这几屏用到的条目是否全部可用（缺失、组缺失或加载失败、置信度 guess 任一 → false） */
export function screenKeysUsable(client: Pick<PackClient, 'usableEntry'> | null, keys = SCREEN_KEYS): boolean {
  if (!client) return false;
  return keys.every((k) => client.usableEntry(k) !== null);
}

/** 这一轮发现开始等待的时刻（全局：各路由共用；有结论后清掉） */
let pendingSince: number | null = null;

/** 测试用：清掉（或设定）这一轮发现的起点 */
export function resetScreensPendingForTest(since: number | null = null): void {
  pendingSince = since;
}

/** 钩子：发现素材包并给出画面模式；原版时绑定经典画面的素材仓库 */
export function useClassicScreens(): ScreensMode {
  const pref = useSettingsStore((s) => s.skin);
  const access = useAccessStore((s) => s.status);
  const pack = useSkinStore((s) => s.pack);
  const resolution = useSkinStore((s) => s.resolution);
  // 素材包、失败组变化时重新检查（usableEntry 读客户端的失败组）
  const keysOk = useSkinStore((s) => s.pack.status === 'ready' && screenKeysUsable(currentPackClient()));
  const [, tick] = useReducer((x: number) => x + 1, 0);
  const gated = access !== null && access.mode !== 'off' && !access.granted;

  // 只在还没发现过素材包时发现（已有结论的不重来：暂时性失败由对局页的 useGameSkin 重试）
  const idle = pack.status === 'idle';
  useEffect(() => {
    if (pref === 'procedural' || gated || !idle) return;
    let stale = false;
    void useAccessStore
      .getState()
      .ensureStatus()
      .then((a) => {
        if (stale || (a && a.mode !== 'off' && !a.granted)) return;
        void useSkinStore.getState().ensurePack();
      });
    return () => {
      stale = true;
    };
  }, [pref, gated, idle]);

  const input = { pref, access, pack: pack.status, resolution, keysOk };
  const waiting = decideScreens({ ...input, timedOut: false }) === 'pending';
  // 等待计时：这一轮发现的起点全局共用；到点时重渲染
  useEffect(() => {
    if (!waiting) {
      pendingSince = null;
      return;
    }
    pendingSince ??= Date.now();
    const left = pendingSince + PENDING_MAX_MS - Date.now();
    if (left <= 0) {
      tick();
      return;
    }
    const id = setTimeout(tick, left);
    return () => clearTimeout(id);
  }, [waiting]);
  const timedOut = waiting && pendingSince !== null && Date.now() - pendingSince >= PENDING_MAX_MS;

  const mode = decideScreens({ ...input, timedOut });
  const packId = pack.status === 'ready' ? pack.manifest.packId : null;

  useLayoutEffect(() => {
    if (mode === 'classic' && packId) bindClassicAssets(currentPackClient(), packId);
  }, [mode, packId]);

  return mode;
}

/**
 * 路由实例里的画面模式：离开 pending 后固定，皮肤设置或门禁状态变化时重新判定。
 * - 固定为程序化后不因素材包晚到（超时之后才就绪）升级成原版：不在画面中途重建（首页丢输入、单机页二次建房）；
 * - 固定为原版后，downgrade 为 true 时仍随判定降级为程序化（素材组加载失败等，画面坏了宁可换）；单机页传 false
 *   （它只是建房期间的 Loading，换画面会再建一次房）。
 */
export function usePinnedScreens(o: { downgrade?: boolean } = {}): ScreensMode {
  const mode = useClassicScreens();
  const pref = useSettingsStore((s) => s.skin);
  const gated = useAccessStore((s) => s.status !== null && s.status.mode !== 'off' && !s.status.granted);
  const key = `${pref}|${gated ? 'gated' : 'open'}`;
  const pin = useRef<{ key: string; mode: Exclude<ScreensMode, 'pending'> } | null>(null);
  if (pin.current !== null && pin.current.key !== key) pin.current = null;
  if (pin.current === null) {
    if (mode !== 'pending') pin.current = { key, mode };
  } else if (pin.current.mode === 'classic' && mode === 'procedural' && (o.downgrade ?? true)) {
    pin.current = { key, mode };
  }
  return pin.current?.mode ?? mode;
}
