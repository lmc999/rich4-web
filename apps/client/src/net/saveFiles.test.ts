// 存档导入导出的 HTTP 封装：请求形状、错误归类、文件名解析、大小与格式预检
import { SAVE_IMPORT_MAX_BYTES } from '@rich4/shared/net';
import { describe, expect, it, vi } from 'vitest';
import { memoryStorage, TOKEN_KEY } from './identity';
import { exportSaveText, type FetchLike, filenameFromDisposition, importSaveText, readSaveFile } from './saveFiles';

const TOKEN = 'BBBBBBBBBBBBBBBBBBBBBB';

function storage() {
  const s = memoryStorage();
  s.setItem(TOKEN_KEY, TOKEN);
  return s;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('filenameFromDisposition', () => {
  it('优先 RFC 5987 的 filename*，其次 filename，最后回退', () => {
    expect(
      filenameFromDisposition(
        `attachment; filename="a.r4save"; filename*=UTF-8''${encodeURIComponent('存档 1.r4save')}`,
        'x',
      ),
    ).toBe('存档 1.r4save');
    expect(filenameFromDisposition('attachment; filename="plain.r4save"', 'x')).toBe('plain.r4save');
    expect(filenameFromDisposition('attachment; filename=bare.r4save', 'x')).toBe('bare.r4save');
    expect(filenameFromDisposition(null, 'fallback.r4save')).toBe('fallback.r4save');
    expect(filenameFromDisposition("attachment; filename*=UTF-8''%E0%A4%A", 'fb')).toBe('fb');
  });
});

describe('exportSaveText', () => {
  it('GET /api/saves/:id/export，带 X-Player-Token；成功返回文本与文件名', async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response('R4S1.a.b', { status: 200 }));
    const r = await exportSaveText('id/1', { fetch, storage: storage(), base: 'http://h' });
    expect(r).toEqual({ ok: true, data: { text: 'R4S1.a.b', filename: 'id/1.r4save' } });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('http://h/api/saves/id%2F1/export');
    expect(init?.headers).toEqual({ 'X-Player-Token': TOKEN });
  });

  it('读响应体时网络中断：返回 INTERNAL{network}，不抛出', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.error(new TypeError('network error'));
      },
    });
    const r = await exportSaveText('x', { storage: storage(), fetch: async () => new Response(body, { status: 200 }) });
    expect(r.ok || r.error).toMatchObject({ code: 'INTERNAL', details: { reason: 'network' } });
  });

  it('错误响应按 {ok:false,error} 解析；非 JSON 的 404 归为 SAVE_NOT_FOUND；网络失败归为 INTERNAL{network}', async () => {
    const forbidden = await exportSaveText('x', {
      storage: storage(),
      fetch: async () =>
        json(
          { ok: false, error: { code: 'SAVE_FORBIDDEN', message: 'm', details: { reason: 'gameInProgress' } } },
          409,
        ),
    });
    expect(forbidden.ok || forbidden.error).toMatchObject({
      code: 'SAVE_FORBIDDEN',
      details: { reason: 'gameInProgress' },
    });
    const nf = await exportSaveText('x', {
      storage: storage(),
      fetch: async () => new Response('nope', { status: 404 }),
    });
    expect(nf.ok || nf.error.code).toBe('SAVE_NOT_FOUND');
    const net = await exportSaveText('x', {
      storage: storage(),
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    expect(net.ok || net.error).toMatchObject({ code: 'INTERNAL', details: { reason: 'network' } });
  });
});

describe('importSaveText', () => {
  it('POST text/plain（去掉首尾空白），返回服务器给的摘要', async () => {
    const summary = { saveId: 's1', name: 'n', verified: false };
    const fetch = vi.fn<FetchLike>(async () => json({ ok: true, data: summary }));
    const r = await importSaveText('  R4S1.p.s\n', { fetch, storage: storage() });
    expect(r).toEqual({ ok: true, data: summary });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/saves/import');
    expect(init).toMatchObject({
      method: 'POST',
      body: 'R4S1.p.s',
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Player-Token': TOKEN },
    });
  });

  it('本地预检：空文件、超过 2MB、不是 R4S1 文本都不上传', async () => {
    const fetch = vi.fn<FetchLike>();
    const empty = await importSaveText('   ', { fetch, storage: storage() });
    expect(empty.ok || empty.error).toMatchObject({ code: 'BAD_REQUEST', details: { reason: 'emptyBody' } });
    const big = await importSaveText(`R4S1.${'a'.repeat(SAVE_IMPORT_MAX_BYTES)}.s`, { fetch, storage: storage() });
    expect(big.ok || big.error).toMatchObject({ code: 'BAD_REQUEST', details: { reason: 'tooLarge' } });
    const other = await importSaveText('{"format":"rich4-save"}', { fetch, storage: storage() });
    expect(other.ok || other.error).toMatchObject({ code: 'SAVE_INCOMPATIBLE', details: { reason: 'badEncoding' } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('服务器判不兼容：带原因返回', async () => {
    const r = await importSaveText('R4S1.x.y', {
      storage: storage(),
      fetch: async () =>
        json({ ok: false, error: { code: 'SAVE_INCOMPATIBLE', message: 'm', details: { reason: 'badJson' } } }, 422),
    });
    expect(r.ok || r.error).toMatchObject({ code: 'SAVE_INCOMPATIBLE', details: { reason: 'badJson' } });
  });
});

describe('readSaveFile', () => {
  it('读文本；超过上限不读', async () => {
    expect(await readSaveFile(new Blob(['R4S1.a.b']))).toEqual({ ok: true, data: 'R4S1.a.b' });
    const huge = { size: SAVE_IMPORT_MAX_BYTES + 1, text: vi.fn() } as unknown as Blob;
    const r = await readSaveFile(huge);
    expect(r.ok || r.error).toMatchObject({ code: 'BAD_REQUEST', details: { reason: 'tooLarge' } });
    expect((huge as unknown as { text: ReturnType<typeof vi.fn> }).text).not.toHaveBeenCalled();
  });
});
