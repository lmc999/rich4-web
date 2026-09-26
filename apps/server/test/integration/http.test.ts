import { afterEach, describe, expect, it } from 'vitest';
import { startTestServer, type TestServer } from '../helpers/startTestServer';

let srv: TestServer | null = null;

afterEach(async () => {
  await srv?.close();
  srv = null;
});

describe('integration/http', () => {
  it('/healthz 与 /readyz；关闭后 readyz 转 503', async () => {
    srv = await startTestServer();
    const f = srv.app.fastify;
    expect((await f.inject('/healthz')).json()).toMatchObject({ ok: true });
    expect((await f.inject('/readyz')).statusCode).toBe(200);
    expect(srv.app.isReady()).toBe(true);
    await srv.app.close();
    expect(srv.app.isReady()).toBe(false);
    srv = null;
  });

  it('/api/maps 列出 fixture；/api/maps/:id?h= 命中时长缓存，h 不符 404', async () => {
    srv = await startTestServer();
    const f = srv.app.fastify;
    const list = (await f.inject('/api/maps')).json() as {
      defaultMap: string;
      maps: { id: string; mapHash: string; playable: boolean }[];
    };
    expect(list.defaultMap).toBe('test');
    expect(list.maps.map((m) => [m.id, m.playable])).toEqual([
      ['test', true],
      ['test-allkinds', true],
    ]);
    const hash = list.maps[0]!.mapHash;
    const hit = await f.inject(`/api/maps/test?h=${hash}`);
    expect(hit.statusCode).toBe(200);
    expect(hit.headers['cache-control']).toContain('immutable');
    expect(hit.json()).toMatchObject({ id: 'test', schemaVersion: 1, meta: { dataHash: hash } });
    const noHash = await f.inject('/api/maps/test');
    expect(noHash.headers['cache-control']).toBe('no-cache');
    expect((await f.inject({ url: '/api/maps/test', headers: { 'if-none-match': `"${hash}"` } })).statusCode).toBe(304);
    const bad = await f.inject('/api/maps/test?h=deadbeef');
    expect(bad.statusCode).toBe(404);
    expect(bad.json()).toMatchObject({ ok: false, error: { code: 'MAP_UNAVAILABLE' } });
    expect((await f.inject('/api/maps/nope')).statusCode).toBe(404);
  });

  it('/r/:code 注入邀请信息；其他 GET 回退到 SPA；未知 /api 路径返回 JSON 404', async () => {
    srv = await startTestServer();
    const f = srv.app.fastify;
    const invite = await f.inject('/r/482913');
    expect(invite.statusCode).toBe(200);
    expect(invite.body).toContain('房间 482913');
    expect(invite.body).toContain('og:url" content="http://rich4.test/r/482913"');
    const spa = await f.inject('/lobby/whatever');
    expect(spa.statusCode).toBe(200);
    expect(spa.headers['content-type']).toContain('text/html');
    const api = await f.inject('/api/nothing');
    expect(api.statusCode).toBe(404);
    expect(api.json()).toMatchObject({ ok: false });
  });
});
