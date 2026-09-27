// 从素材包取 FLIC 条目并建好播放器：透明规则按条目（index0 / opaque，原版 Panel#16、#20、jump#42 为 opaque），
// 可截取区间（trim）与摆放方式在 flic-map 里，由调用方（A8 OrigStage）传给 playFit。
import type { FlicEntry } from '@rich4/shared/assets';
import type { PackClient } from '../pack/PackClient';
import { FlicPlayer, type FlicPlayerOptions } from './FlicPlayer';

export async function loadFlicPlayer(
  client: PackClient,
  key: string,
  o: Omit<FlicPlayerOptions, 'opaque' | 'label'> & { signal?: AbortSignal },
): Promise<{ entry: FlicEntry; player: FlicPlayer }> {
  const { entry, flc } = await client.loadFlic(key, o.signal);
  const { signal: _signal, ...opts } = o;
  return { entry, player: new FlicPlayer(flc, { ...opts, opaque: entry.transparency === 'opaque', label: key }) };
}
