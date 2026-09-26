/**
 * 集成测试的常用步骤：建房、入座、选角、准备、开局；以及 S2C 深度扫描。
 */
import type { CharacterId, SeatAiConfig, SeatIndex } from '@rich4/shared/engine';
import type { RoomSettingsPatch } from '@rich4/shared/net';
import { type BotClient, type BotOptions, connectBot } from './botClient';

/** 永不下发的键（architecture §5.3、design/net.md §6.2） */
export const FORBIDDEN_KEYS = [
  'secret',
  'rng',
  'flow',
  'counters',
  'newsOrder',
  'fateOrder',
  'newsCursor',
  'fateCursor',
  'aiSeed',
  'debugQueue',
  'timeAnchor',
  'timeAnchors',
] as const;

/** 深度查找对象中出现的指定键，返回路径 */
export function findKeys(x: unknown, keys: readonly string[], path = '$', out: string[] = []): string[] {
  if (Array.isArray(x)) {
    for (const [i, v] of x.entries()) findKeys(v, keys, `${path}[${i}]`, out);
  } else if (x !== null && typeof x === 'object') {
    for (const [k, v] of Object.entries(x)) {
      if (keys.includes(k)) out.push(`${path}.${k}`);
      findKeys(v, keys, `${path}.${k}`, out);
    }
  }
  return out;
}

export interface RoomSetup {
  code: string;
  host: BotClient;
  bots: BotClient[];
}

export interface SetupOptions {
  humans: number;
  ais?: { seat: SeatIndex; ai: SeatAiConfig }[];
  settings?: RoomSettingsPatch;
  botOptions?: (i: number) => BotOptions;
}

/** 建房 → 其余人入座 → 各自选角色 → 准备 → 房主补 AI（不开局） */
export async function setupRoom(url: string, o: SetupOptions): Promise<RoomSetup> {
  const bots: BotClient[] = [];
  for (let i = 0; i < o.humans; i++) {
    bots.push(await connectBot(url, { nickname: `P${i}`, seed: i + 1, ...o.botOptions?.(i) }));
  }
  const host = bots[0]!;
  const c = await host.req('room:create', { settings: o.settings ?? {} });
  if (!c.ok) throw new Error(`room:create failed: ${c.error.code}`);
  const code = c.data.code;
  for (const b of bots.slice(1)) {
    const r = await b.req('room:join', { code, role: 'player' });
    if (!r.ok) throw new Error(`room:join failed: ${r.error.code}`);
  }
  for (let i = 0; i < bots.length; i++) {
    const r = await bots[i]!.req('room:selectCharacter', { characterId: i as CharacterId });
    if (!r.ok) throw new Error(`selectCharacter failed: ${r.error.code}`);
    if (i > 0) await bots[i]!.req('room:setReady', { ready: true });
  }
  for (const a of o.ais ?? []) {
    const r = await host.req('room:setSeatAi', { seat: a.seat, ai: a.ai });
    if (!r.ok) throw new Error(`setSeatAi failed: ${r.error.code}`);
  }
  return { code, host, bots };
}

/** 房主开局并等所有 bot 收到快照 */
export async function startGame(s: RoomSetup, extra: BotClient[] = []): Promise<void> {
  const r = await s.host.req('room:start', {});
  if (!r.ok) throw new Error(`room:start failed: ${r.error.code} ${JSON.stringify(r.error.details ?? {})}`);
  for (const b of [...s.bots, ...extra]) await b.until(() => b.epoch >= 1 && b.view !== undefined, 5000, 'snapshot');
}

export function closeAll(bots: BotClient[]): void {
  for (const b of bots) b.close();
}
