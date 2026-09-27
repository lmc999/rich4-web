// 小游戏按皮肤选视图（原版皮肤 A13）：当前皮肤判定为原版、素材包就绪时返回素材包客户端，否则 null（程序化视图）。
// 与对局页同一个判定（skinStore.resolution.skin）：设置为程序化、素材包缺失、门禁未通过、地图不匹配时都走程序化。
import { currentPackClient, useSkinStore } from '../../skin/skinStore';
import type { MgPackSource } from './keys';

export function currentOrigPack(): MgPackSource | null {
  const s = useSkinStore.getState();
  if (s.resolution.skin !== 'original' || s.pack.status !== 'ready') return null;
  const c = currentPackClient();
  return c?.manifest ? c : null;
}
