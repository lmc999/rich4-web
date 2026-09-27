// 皮肤选择（original-skin.md §3 修正 4/9；design-draft §3.1）：由设置（settingsStore.skin）、素材包状态、当前对局地图
// 与原版棋盘渲染器是否可用四者算出最终皮肤（判定矩阵见 resolve.ts）。
//
// 素材包发现：先 GET /api/access（恒为 200），门禁开启但未通过 → 门禁页；门禁开启且已通过 → 请求 /pack/manifest.json；
// 门禁关闭（mode off）时生产构建不请求 manifest——服务器在启用素材包时必须设门禁（修正 3），mode off 基本意味着
// 没有素材包，这样也避免每局都产生一次 404（浏览器会把它记成控制台错误）。开发构建（vite dev）、URL 带 ?pack=1 或
// localStorage rich4.pack=1 时照常请求（本机 RICH4_ASSETS_ALLOW_UNGATED=1 调试）。若服务器在 /api/access 里给出
// pack 字段（packId 或 null），以它为准。
//
// PackClient（含 shared/assets 的 zod 契约）动态 import，不进首屏；chunk 加载失败时下次调用重新 import。
//
// 失败与恢复：发现过程出错（chunk 加载失败、网络错误）落到 absent(network)，不会停在 loading；暂时性的结果
// （network / http / 门禁状态未知）不缓存，下一次 ensurePack 重新发现。素材文件或音频在 manifest 就绪之后被 401
// （cookie 过期或被吊销）时记下 packAccessDenied，门禁页通过后整体 reloadPack（清掉失败组与各级缓存）。
import type { MapBindingInput } from '@rich4/shared/assets';
import type { AccessStatus } from '@rich4/shared/net';
import { create } from 'zustand';
import { useSettingsStore } from '../store/settingsStore';
import { requireAccess, useAccessStore } from '../ui/access/accessStore';
import { hasBoardFactory, onBoardFactoriesChanged } from './boardRegistry';
import type { PackClient } from './pack/PackClient';
import { resolveSkin } from './resolve';
import type { MapCheck, PackState, SkinKind, SkinResolution } from './types';

// ───────────────────────── PackClient 单例 ─────────────────────────

let clientPromise: Promise<PackClient> | null = null;
let clientNow: PackClient | null = null;
type PackClientModule = typeof import('./pack/PackClient');
const importPackClient = (): Promise<PackClientModule> => import('./pack/PackClient');
let loadPackClientModule: () => Promise<PackClientModule> = importPackClient;

/** 取得（必要时创建）PackClient；401 → 门禁页。动态 import 失败时不缓存失败结果（下次重试） */
export function packClient(): Promise<PackClient> {
  if (!clientPromise) {
    const p = loadPackClientModule().then((m) => {
      clientNow = new m.PackClient({ onAccessRequired: () => notePackAccessDenied() });
      return clientNow;
    });
    clientPromise = p;
    p.catch(() => {
      if (clientPromise === p) clientPromise = null;
    });
  }
  return clientPromise;
}

// ───────────────────────── 素材访问被拒（401） ─────────────────────────

/** manifest 就绪之后素材文件、音频或映射表被 401：门禁页通过后需要整体重新载入素材包 */
let packAccessDenied = false;

/**
 * 素材包的请求被门禁拒绝（manifest、文件、音频、映射表）：记下并显示门禁页（reason 'pack'）。
 * 门禁页通过后由下面的 accessStore 订阅 reloadPack。
 */
export function notePackAccessDenied(): void {
  packAccessDenied = true;
  requireAccess('pack');
}

/** 已创建的 PackClient（同步；未创建为 null） */
export function currentPackClient(): PackClient | null {
  return clientNow;
}

// ───────────────────────── 是否请求 manifest ─────────────────────────

export interface ProbeEnv {
  /** 开发构建（vite dev） */
  dev: boolean;
  /** ?pack=1 或 localStorage rich4.pack=1 */
  forced: boolean;
}

function readForced(): boolean {
  try {
    if (typeof location !== 'undefined' && /(?:^|[?&])pack=1(?:&|$)/.test(location.search)) return true;
    return globalThis.localStorage?.getItem('rich4.pack') === '1';
  } catch {
    return false;
  }
}

let probeEnv: () => ProbeEnv = () => ({ dev: import.meta.env.DEV === true, forced: readForced() });

/** 是否应请求 /pack/manifest.json（状态未知 = 接口不可用或网络错误） */
export function shouldProbePack(status: AccessStatus | null, env: ProbeEnv): boolean {
  const pack = status ? (status as AccessStatus & { pack?: unknown }).pack : undefined;
  if (pack !== undefined) return pack !== null && pack !== false;
  if (status && status.mode !== 'off') return true;
  return env.dev || env.forced;
}

// ───────────────────────── store ─────────────────────────

export interface SkinState {
  pack: PackState;
  /** 当前对局的地图（不在对局中为 null） */
  activeMap: MapBindingInput | null;
  mapCheck: MapCheck | null;
  failedGroups: readonly string[];
  /** 原版棋盘创建失败（本局改用程序化） */
  boardFailed: boolean;
  /** BoardCanvas 实际创建的棋盘 */
  boardInUse: SkinKind | null;
  resolution: SkinResolution;
  /** 发现素材包（整个页面只做一次；门禁通过后 reloadPack 重来） */
  ensurePack(): Promise<PackState>;
  reloadPack(): Promise<PackState>;
  setActiveMap(map: MapBindingInput | null): void;
  reportBoard(kind: SkinKind | null, failed?: boolean): void;
  markGroupFailed(group: string): void;
}

const IDLE: PackState = { status: 'idle' };

function compute(
  s: Pick<SkinState, 'pack' | 'activeMap' | 'mapCheck' | 'failedGroups' | 'boardFailed'>,
): SkinResolution {
  return resolveSkin({
    pref: useSettingsStore.getState().skin,
    pack: s.pack,
    map: s.mapCheck,
    mapPending: s.activeMap !== null && s.pack.status === 'ready' && s.mapCheck === null,
    failedGroups: s.failedGroups,
    boardRenderer: hasBoardFactory('original'),
    boardFailed: s.boardFailed,
  });
}

function checkActiveMap(pack: PackState, map: MapBindingInput | null): MapCheck | null {
  if (!map || pack.status !== 'ready') return null;
  const c = currentPackClient();
  return c ? c.checkMap(map) : null;
}

let discovery: Promise<PackState> | null = null;
const warmed = new Set<string>();

/** 暂时性的发现结果（网络、HTTP 错误、门禁状态未知）：不缓存，下次 ensurePack 重试 */
function transientPack(s: PackState): boolean {
  return s.status === 'absent' && (s.reason === 'network' || s.reason === 'http' || s.detail === 'accessUnknown');
}

/**
 * 原版皮肤就绪后预取当前地图的组（图集与地图皮肤 JSON，逐个校验）：组缺失或加载失败 → 记为失败组，
 * 判定随之回退程序化棋盘（修正 6：CI 的合成素材包也走这条路径）。判定每次变化（素材包、地图、设置）后都调用。
 */
function warmUp(): void {
  const { resolution, mapCheck } = useSkinStore.getState();
  const client = currentPackClient();
  if (!client || resolution.skin !== 'original' || mapCheck?.status !== 'ok' || !mapCheck.group) return;
  const group = mapCheck.group;
  const key = `${resolution.packId}|${group}`;
  if (warmed.has(key)) return;
  warmed.add(key);
  client.loadGroup(group).catch((e: unknown) => {
    console.warn(`[skin] 素材组 ${group} 加载失败，回退程序化棋盘`, e);
    useSkinStore.getState().markGroupFailed(group);
  });
}

export const useSkinStore = create<SkinState>()((set, get) => {
  /** 更新输入并重算判定 */
  const update = (patch: Partial<Pick<SkinState, 'pack' | 'activeMap' | 'failedGroups' | 'boardFailed'>>): void => {
    const cur = get();
    const next = { ...cur, ...patch };
    const mapCheck = checkActiveMap(next.pack, next.activeMap);
    set({ ...patch, mapCheck, resolution: compute({ ...next, mapCheck }) });
    warmUp();
  };

  const discover = async (force: boolean): Promise<PackState> => {
    update({ pack: { status: 'loading' } });
    let pack: PackState;
    try {
      const access = await (force ? useAccessStore.getState().refresh() : useAccessStore.getState().ensureStatus());
      if (access && access.mode !== 'off' && !access.granted) {
        pack = { status: 'access-required' };
        requireAccess('pack');
      } else if (!shouldProbePack(access, probeEnv())) {
        pack = { status: 'absent', reason: 'not-found', detail: access ? 'accessOff' : 'accessUnknown' };
      } else {
        const client = await packClient();
        pack = await client.loadManifest({ force });
      }
    } catch (e) {
      // chunk 加载失败（部署后旧页面的哈希 chunk 404、网络抖动）等：不能停在 loading（对局页会一直等棋盘）
      console.warn('[skin] 素材包发现失败，回退程序化', e);
      pack = { status: 'absent', reason: 'network', detail: e instanceof Error ? e.message : String(e) };
    }
    update({ pack, failedGroups: [...(currentPackClient()?.failedGroups ?? [])] });
    return pack;
  };

  return {
    pack: IDLE,
    activeMap: null,
    mapCheck: null,
    failedGroups: [],
    boardFailed: false,
    boardInUse: null,
    resolution: compute({ pack: IDLE, activeMap: null, mapCheck: null, failedGroups: [], boardFailed: false }),
    ensurePack: () => {
      if (!discovery) {
        const p = discover(false);
        discovery = p;
        void p.then((s) => {
          if (discovery === p && transientPack(s)) discovery = null;
        });
      }
      return discovery;
    },
    reloadPack: () => {
      warmed.clear();
      packAccessDenied = false;
      const p = discover(true);
      discovery = p;
      void p.then((s) => {
        if (discovery === p && transientPack(s)) discovery = null;
      });
      return p;
    },
    setActiveMap: (map) => {
      if (get().activeMap === map) return;
      update({ activeMap: map, boardFailed: false });
    },
    reportBoard: (kind, failed) => {
      set({ boardInUse: kind });
      if (failed !== undefined && failed !== get().boardFailed) update({ boardFailed: failed });
    },
    markGroupFailed: (group) => {
      if (get().failedGroups.includes(group)) return;
      update({ failedGroups: [...get().failedGroups, group] });
    },
  };
});

/** 重新判定（设置变化、原版渲染器注册时）；判定为原版时预取并校验当前地图组（与 update 相同） */
function recompute(): void {
  const s = useSkinStore.getState();
  useSkinStore.setState({ resolution: compute(s) });
  warmUp();
}

useSettingsStore.subscribe((s, prev) => {
  if (s.skin !== prev.skin) recompute();
});
onBoardFactoriesChanged(recompute);
// 门禁通过后（口令或邀请授权）重新发现素材包：状态从未通过变为通过，或门禁页在已通过的状态下收起
// （/api/access 说已通过、manifest 却 401 的情况：cookie 刚过期或被吊销）。manifest 已就绪、之后素材文件或音频
// 被 401（packAccessDenied）的情况同样整体重载：清掉失败组、位图与音频缓存，恢复原版皮肤与繁体
useAccessStore.subscribe((s, prev) => {
  if (s.status?.granted !== true) return;
  if (useSkinStore.getState().pack.status !== 'access-required' && !packAccessDenied) return;
  const becameGranted = prev.status?.granted !== true;
  const gateClosed = prev.required !== null && s.required === null;
  if (becameGranted || gateClosed) void useSkinStore.getState().reloadPack();
});

// ───────────────────────── 测试 ─────────────────────────

/** 测试：替换 PackClient（或它的动态 import）与探测环境，并清空状态 */
export function resetSkinStoreForTest(
  o: { client?: PackClient | null; env?: ProbeEnv; importClient?: () => Promise<PackClientModule> } = {},
): void {
  clientNow = o.client ?? null;
  clientPromise = o.client ? Promise.resolve(o.client) : null;
  loadPackClientModule = o.importClient ?? importPackClient;
  if (o.env) {
    const env = o.env;
    probeEnv = () => env;
  }
  discovery = null;
  warmed.clear();
  packAccessDenied = false;
  useSkinStore.setState({
    pack: IDLE,
    activeMap: null,
    mapCheck: null,
    failedGroups: [],
    boardFailed: false,
    boardInUse: null,
    resolution: compute({ pack: IDLE, activeMap: null, mapCheck: null, failedGroups: [], boardFailed: false }),
  });
}
