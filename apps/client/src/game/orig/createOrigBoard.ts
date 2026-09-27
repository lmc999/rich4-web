// 原版棋盘工厂（skin/BoardSurface 的 BoardFactory；由 skin/renderers.ts 懒加载后注册为 'original'）：
// 取地图皮肤（PackClient 已按 zod 与交叉引用校验）→ 核对绑定 → 建 OrigRenderer → 设 insets → 载入地图
// （地图组与棋盘通用组的精灵、地面切块；失败则 reject，由 skin/boards.createBoard 回退程序化）→ 建控制器。
import { checkMapSkinBinding, type MapSkinV1 } from '@rich4/shared/assets';
import {
  type BoardFactory,
  boardAbortError,
  type CreateBoardOptions,
  type CreatedBoard,
} from '../../skin/BoardSurface';
import { FlicPlayer } from '../../skin/flic/FlicPlayer';
import type { OrigPackSource } from './OrigAssets';
import { OrigBoardController, type ParachuteSource } from './OrigBoardController';
import { OrigRenderer } from './OrigRenderer';

/** 工厂需要的素材包能力（PackClient 满足） */
export interface OrigBoardPack extends OrigPackSource {
  loadMapSkin(mapId: string, signal?: AbortSignal): Promise<MapSkinV1>;
}

export class OrigBoardUnavailable extends Error {
  override name = 'OrigBoardUnavailable';
}

/** 棋盘伞：char.<c>.parachute（原版 Data#518–529，440×440 FLIC） */
function parachuteSource(pack: OrigPackSource, clock: CreateBoardOptions['clock']): ParachuteSource | undefined {
  const load = pack.loadFlic?.bind(pack);
  if (!load) return undefined;
  return async (character, signal) => {
    const key = `char.${character}.parachute`;
    const e = pack.usableEntry(key);
    if (e?.type !== 'flic') return null;
    const { entry, flc } = await load(key, signal);
    return new FlicPlayer(flc, { clock, opaque: entry.transparency === 'opaque', label: key });
  };
}

export async function createOrigBoard(o: CreateBoardOptions, pack: OrigBoardPack): Promise<CreatedBoard> {
  if (!pack.manifest) throw new OrigBoardUnavailable('素材包未就绪');
  const skin = await pack.loadMapSkin(o.def.id, o.signal);
  const mismatch = checkMapSkinBinding({ mapId: skin.mapId, binding: skin.binding }, o.def);
  if (mismatch.length > 0)
    throw new OrigBoardUnavailable(`地图皮肤与地图不匹配：${mismatch.map((m) => m.code).join(', ')}`);
  if (o.signal?.aborted) throw boardAbortError();
  const r = await OrigRenderer.create({
    host: o.host,
    pack,
    skin,
    clock: o.clock,
    quality: o.quality,
    ...(o.label ? { label: o.label } : {}),
    ...(o.onTap ? { onTap: o.onTap } : {}),
    ...(o.onDoubleTap ? { onDoubleTap: o.onDoubleTap } : {}),
    ...(o.onContextLost ? { onContextLost: o.onContextLost } : {}),
  });
  if (o.signal?.aborted) {
    r.destroy();
    throw boardAbortError();
  }
  try {
    r.camera.setInsets(o.insets);
    await r.loadMap(o.def);
  } catch (e) {
    r.destroy();
    throw e;
  }
  if (o.signal?.aborted) {
    r.destroy();
    throw boardAbortError();
  }
  const para = parachuteSource(pack, o.clock);
  const controller = new OrigBoardController(r, { ...o.controller, ...(para ? { parachute: para } : {}) });
  return { surface: r, controller };
}

/** 绑定素材包来源后的工厂（skin/renderers.ts 注册用） */
export function origBoardFactory(getPack: () => Promise<OrigBoardPack>): BoardFactory {
  return async (o) => createOrigBoard(o, await getPack());
}
