/**
 * 压测支撑（M11 验证 5）：测试模式放宽同 IP 的并发连接数与建房额度（app.ts 的 TEST_MODE_IP_RELAX），非测试模式保持生产额度；
 * botClient 的压测选项（history=false、onReq）。
 */
import { CREATE_ROOM_PER_IP_PER_MIN, MAX_CONNECTIONS_PER_IP, type Result } from '@rich4/shared/net';
import { afterEach, describe, expect, it } from 'vitest';
import { type BotClient, connectBot } from '../helpers/botClient';
import { closeAll } from '../helpers/scenario';
import { startTestServer, type TestServer } from '../helpers/startTestServer';

let srv: TestServer | null = null;
const bots: BotClient[] = [];

afterEach(async () => {
  closeAll(bots.splice(0));
  await srv?.close();
  srv = null;
});

async function connectMany(n: number): Promise<BotClient[]> {
  const out: BotClient[] = [];
  for (let i = 0; i < n; i++) {
    const b = await connectBot(srv!.url, { nickname: `c${i}` });
    bots.push(b);
    out.push(b);
  }
  return out;
}

async function createCodes(bs: BotClient[]): Promise<string[]> {
  const codes: string[] = [];
  for (const b of bs) {
    const r = await b.req('room:create', {});
    codes.push(r.ok ? 'ok' : r.error.code);
  }
  return codes;
}

describe('integration/load-limits', () => {
  it('测试模式：同一 IP 超过 30 个并发连接、每分钟建房超过 5 次都放行（join 失败额度仍按生产，见 room-guards）', async () => {
    srv = await startTestServer();
    const bs = await connectMany(MAX_CONNECTIONS_PER_IP + 5);
    expect(srv.app.io.engine.clientsCount).toBe(MAX_CONNECTIONS_PER_IP + 5);
    const codes = await createCodes(bs.slice(0, CREATE_ROOM_PER_IP_PER_MIN + 3));
    expect(codes).toEqual(Array(CREATE_ROOM_PER_IP_PER_MIN + 3).fill('ok'));
    expect(srv.app.rooms.size).toBe(CREATE_ROOM_PER_IP_PER_MIN + 3);
  });

  it('非测试模式：同一 IP 第 31 个连接 SERVER_BUSY，第 6 次建房 RATE_LIMITED（生产额度不变）', async () => {
    srv = await startTestServer({ testMode: false });
    const bs = await connectMany(MAX_CONNECTIONS_PER_IP);
    await expect(connectBot(srv.url, { nickname: 'over' })).rejects.toMatchObject({
      data: { code: 'SERVER_BUSY' },
    });
    const codes = await createCodes(bs.slice(0, CREATE_ROOM_PER_IP_PER_MIN + 1));
    expect(codes).toEqual([...Array(CREATE_ROOM_PER_IP_PER_MIN).fill('ok'), 'RATE_LIMITED']);
    // 断开一个后又能连上（计数随断开释放）
    bs[0]!.close();
    await new Promise((r) => setTimeout(r, 100));
    bots.push(await connectBot(srv.url, { nickname: 'again' }));
  });

  it('botClient 压测选项：history=false 只计数不留历史；onReq 回报每个请求的 ack 往返与结果', async () => {
    srv = await startTestServer();
    const seen: { event: string; ms: number; r: Result<unknown> | null }[] = [];
    const b = await connectBot(srv.url, {
      nickname: 'lt',
      history: false,
      onReq: (event, ms, r) => seen.push({ event, ms, r }),
    });
    bots.push(b);
    const c = await b.req('room:create', {});
    expect(c.ok).toBe(true);
    expect(await b.req('room:setReady', { ready: true })).toEqual({ ok: true });
    await b.until(() => b.room !== undefined, 2000, 'room:state');
    expect(b.receivedCount).toBeGreaterThan(0);
    expect(b.received).toEqual([]);
    expect(seen.map((x) => x.event)).toEqual(['room:create', 'room:setReady']);
    expect(seen[0]!.r).toMatchObject({ ok: true });
    for (const x of seen) expect(x.ms).toBeGreaterThanOrEqual(0);
    // 缺省仍保留历史（现有测试依赖 received）
    const h = await connectBot(srv.url, { nickname: 'h' });
    bots.push(h);
    await h.req('room:join', { code: c.ok ? c.data.code : '', role: 'spectator' });
    await h.until(() => h.room !== undefined, 2000, 'room:state');
    expect(h.received.length).toBe(h.receivedCount);
  });
});
