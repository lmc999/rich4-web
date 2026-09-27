// 原版场景的素材按需加载（design-draft §4.3）：外壳启动时只预取工具列、资料栏等（classic/assets 的 CLASSIC_SPRITES），
// 场景用到的精灵（YES/NO、计算器、讲话头像、场所底图…）在场景出现前按逻辑键取，写进同一个 useClassicAssets 仓库
// （Sprite 组件照常读取）。条目缺失 / 组缺失 / 置信度 guess / 加载失败 → 记为 null，由决策宿主整体回退到程序化对话框。
import type { AtlasV1 } from '@rich4/shared/assets';
import { useEffect } from 'react';
import type { PackClient } from '../../../skin/pack/PackClient';
import { currentPackClient } from '../../../skin/skinStore';
import { ensureClassicImage, ensureClassicMask, type SpriteSheet, sheetFromAtlases, useClassicAssets } from '../assets';

/** 当前素材包客户端（经典布局绑定了素材包时） */
export function scenePackClient(): PackClient | null {
  return useClassicAssets.getState().packId === null ? null : currentPackClient();
}

const inflight = new Map<string, Promise<SpriteSheet | null>>();

async function loadSheet(client: PackClient, key: string): Promise<SpriteSheet | null> {
  const e = client.usableEntry(key);
  if (e?.type !== 'sprite') return null;
  const pages: { atlas: AtlasV1; url: string }[] = [];
  for (const lp of e.atlas) {
    const atlas = await client.loadAtlas(lp);
    const url = client.atlasImageUrl(lp, atlas);
    if (url) pages.push({ atlas, url });
  }
  const sheet = sheetFromAtlases(key, e, pages);
  return sheet.frames.some((f) => f !== null) ? sheet : null;
}

/**
 * 取精灵表（已在仓库里就直接返回；同一素材包内并发调用共用一次加载）。
 * client 缺省为当前素材包客户端；没有素材包 → null。
 */
export function ensureSceneSprite(
  key: string,
  client: PackClient | null = currentPackClient(),
): Promise<SpriteSheet | null> {
  const s = useClassicAssets.getState();
  if (Object.hasOwn(s.sprites, key)) return Promise.resolve(s.sprites[key] ?? null);
  const packId = s.packId;
  if (packId === null || client === null) return Promise.resolve(null);
  const id = `${packId}\n${key}`;
  const cur = inflight.get(id);
  if (cur) return cur;
  const p = loadSheet(client, key)
    .catch((e: unknown) => {
      console.warn(`[classic] 场景素材 ${key} 不可用，改用程序化对话框`, e);
      return null;
    })
    .then((sheet) => {
      inflight.delete(id);
      const st = useClassicAssets.getState();
      if (st.packId === packId && !Object.hasOwn(st.sprites, key)) {
        useClassicAssets.setState({ sprites: { ...st.sprites, [key]: sheet } });
      }
      return sheet;
    });
  inflight.set(id, p);
  return p;
}

export type SceneKeysStatus = 'ready' | 'missing' | 'loading';

/**
 * 同步判断一组逻辑键是否可用：任一条目不可用（缺失、组缺失、guess）或精灵加载失败 → missing；
 * 精灵还没进仓库 → loading；全部就绪 → ready。掩膜与整图不阻塞（掩膜加载失败时热区按矩形命中）。
 */
export function sceneKeysStatus(keys: readonly string[], client: PackClient | null): SceneKeysStatus {
  if (!client || useClassicAssets.getState().packId === null) return 'missing';
  const sprites = useClassicAssets.getState().sprites;
  let loading = false;
  for (const key of keys) {
    const e = client.usableEntry(key);
    if (!e) return 'missing';
    if (e.type !== 'sprite') continue;
    if (!Object.hasOwn(sprites, key)) loading = true;
    else if (sprites[key] === null) return 'missing';
  }
  return loading ? 'loading' : 'ready';
}

/**
 * 准备一组逻辑键：精灵加载进仓库、掩膜与整图开始加载；返回是否全部可用（任一不可用 → false，调用方整体回退）。
 */
export async function prepareSceneKeys(keys: readonly string[], client: PackClient | null): Promise<boolean> {
  if (!client || useClassicAssets.getState().packId === null) return false;
  const waits: Promise<SpriteSheet | null>[] = [];
  for (const key of keys) {
    const e = client.usableEntry(key);
    if (!e) return false;
    if (e.type === 'sprite') waits.push(ensureSceneSprite(key, client));
    else if (e.type === 'mask') ensureClassicMask(key);
    else if (e.type === 'image') ensureClassicImage(key);
  }
  const sheets = await Promise.all(waits);
  return sheets.every((s) => s !== null);
}

/** 钩子：确保这些精灵表开始加载（已在仓库里的不重复加载；没有素材包时什么也不做） */
export function useEnsureSceneSprites(keys: readonly string[]): void {
  const packId = useClassicAssets((s) => s.packId);
  const joined = keys.join('\n');
  useEffect(() => {
    if (packId === null) return;
    for (const key of joined.split('\n')) if (key) void ensureSceneSprite(key);
  }, [joined, packId]);
}

/** 测试：清掉进行中的加载 */
export function resetSceneAssetsForTest(): void {
  inflight.clear();
}
