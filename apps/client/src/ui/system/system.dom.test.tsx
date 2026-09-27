// 系统菜单一族（design/client.md §5.7、§12.1 dom）：存档读档（列表标记、读档、删除确认、导出下载、导入上传、错误文案）、
// 托管设置对话框、断线遮罩（托管倒计时、恢复提示）、系统菜单（解散确认、托管入口）、观战者 HUD。
import type { SaveSummary } from '@rich4/shared/net';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientProvider } from '../../app/services';
import { tx } from '../../i18n/tx';
import { memoryStorage, TOKEN_KEY } from '../../net/identity';
import type { FetchLike } from '../../net/saveFiles';
import { useConnectionStore } from '../../store/connectionStore';
import { useGameStore } from '../../store/gameStore';
import { useMapStore } from '../../store/mapStore';
import { useRoomStore } from '../../store/roomStore';
import { useUiStore } from '../../store/uiStore';
import { makeTestClient } from '../../test/fakeTransport';
import { ai, human, roomView } from '../../test/roomFixtures';
import { selfPlay } from '../../test/selfPlay';
import { Toasts } from '../hud/Overlays';
import GameScreen from '../screens/GameScreen';
import { ReconnectOverlay } from './ReconnectOverlay';
import { SaveLoadMenu, saveErrorText } from './SaveLoadMenu';
import { SystemMenu } from './SystemMenu';
import {
  openTrusteeSettings,
  snapRatio,
  TrusteeSettingsDialog,
  trusteeFromTraits,
  useTrusteeDialog,
} from './TrusteeSettings';

vi.mock('../screens/BoardCanvas', () => ({
  BoardCanvas: () => <div data-testid="board-host">board</div>,
}));

const TOKEN = 'AAAAAAAAAAAAAAAAAAAAAA';

function renderWith(ui: React.ReactElement) {
  const t = makeTestClient();
  const utils = render(
    <ClientProvider client={t.client}>
      {ui}
      <Toasts />
    </ClientProvider>,
  );
  return { ...utils, ...t };
}

function summary(over: Partial<SaveSummary> & { saveId: string }): SaveSummary {
  return {
    name: '存档',
    kind: 'manual',
    mapId: 'test',
    gameDay: 12,
    date: 20100112,
    seats: [
      { characterId: 9, nickname: '阿明', wasHuman: true },
      { characterId: 4, nickname: 'AI2', wasHuman: false },
    ],
    createdAt: Date.UTC(2026, 8, 27, 4, 5),
    compatible: true,
    verified: true,
    ...over,
  };
}

const SAVES: SaveSummary[] = [
  summary({ saveId: 's-ok', name: '官方存档', createdAt: 3 }),
  summary({ saveId: 's-mod', name: '改过的', verified: false, createdAt: 2 }),
  summary({
    saveId: 's-warn',
    name: '旧版本',
    warnings: ['tablesHashMismatch', 'needsMigration'],
    createdAt: 1,
  }),
  summary({ saveId: 's-bad', name: '不兼容', compatible: false, kind: 'auto', createdAt: 0 }),
];

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

const sp = selfPlay({ seed: 21, steps: 20 });

afterEach(() => {
  vi.restoreAllMocks();
  useTrusteeDialog.getState().setOpen(false);
  useUiStore.getState().clear();
  useGameStore.getState().clear();
  useRoomStore.getState().clear();
  useConnectionStore.getState().reset();
});

describe('SaveLoadMenu', () => {
  let storage: ReturnType<typeof memoryStorage>;
  beforeEach(() => {
    storage = memoryStorage();
    storage.setItem(TOKEN_KEY, TOKEN);
  });

  it('列表：新的在前；非官方、不兼容、自动、兼容性提示逐条标出；大厅房主可读档（不兼容的禁用）', async () => {
    const t2 = makeTestClient();
    t2.transport.respond('saves:list', () => ({ ok: true, data: { saves: [...SAVES].reverse() } }));
    render(
      <ClientProvider client={t2.client}>
        <SaveLoadMenu mode="lobby" isHost />
      </ClientProvider>,
    );
    await screen.findByTestId('save-s-ok');
    const items = within(screen.getByTestId('save-list')).getAllByRole('listitem');
    expect(items.map((li) => li.getAttribute('data-name'))).toEqual(['官方存档', '改过的', '旧版本', '不兼容']);
    expect(screen.getByTestId('save-unofficial-s-mod')).toHaveTextContent('非官方存档');
    expect(screen.queryByTestId('save-unofficial-s-ok')).toBeNull();
    expect(screen.getByTestId('save-warn-s-warn')).toHaveTextContent('数据版本不同');
    expect(screen.getByTestId('save-warn-needsMigration-s-warn')).toHaveTextContent('旧版本存档');
    expect(within(screen.getByTestId('save-s-bad')).getByText('不兼容', { selector: 'span' })).toBeInTheDocument();
    expect(within(screen.getByTestId('save-s-bad')).getByText('自动')).toBeInTheDocument();
    expect(screen.getByTestId('save-s-ok')).toHaveTextContent('阿明（孙小美）、🤖AI2（阿土伯）');
    expect(screen.getByTestId('save-s-ok')).toHaveTextContent('第 12 天');
    expect(screen.getByTestId('save-load-s-bad')).toBeDisabled();
    await userEvent.click(screen.getByTestId('save-load-s-ok'));
    expect(t2.transport.payloads('room:loadSave')).toEqual([{ saveId: 's-ok' }]);
  });

  it('列表加载失败：不显示「暂无存档」，给出原因与重试；重试成功后显示列表', async () => {
    const t2 = makeTestClient();
    let fail = true;
    t2.transport.respond('saves:list', () =>
      fail
        ? { ok: false, error: { code: 'INTERNAL', message: 'x', details: { reason: 'network' } } }
        : { ok: true, data: { saves: [SAVES[0]!] } },
    );
    render(
      <ClientProvider client={t2.client}>
        <SaveLoadMenu mode="lobby" isHost />
      </ClientProvider>,
    );
    expect(await screen.findByTestId('save-list-error')).toHaveTextContent('存档列表加载失败：网络错误，请稍后再试');
    expect(screen.queryByText('还没有存档')).toBeNull();
    expect(useUiStore.getState().toasts.at(-1)?.text).toBe('存档列表加载失败：网络错误，请稍后再试');
    fail = false;
    await userEvent.click(within(screen.getByTestId('save-list-error')).getByRole('button'));
    await screen.findByTestId('save-s-ok');
    expect(screen.queryByTestId('save-list-error')).toBeNull();
  });

  it('saveErrorText：选的文件读不出来有专门文案', () => {
    const { client } = makeTestClient();
    expect(saveErrorText(tx, client, { code: 'BAD_REQUEST', message: 'x', details: { reason: 'unreadable' } })).toBe(
      '无法读取所选文件',
    );
  });

  it('对局中：房主命名存档发 game:save；删除要二次确认；非房主没有存档表单与读档按钮', async () => {
    const t = makeTestClient();
    t.transport.respond('game:save', () => ({ ok: true, data: { saveId: 'new1' } }));
    render(
      <ClientProvider client={t.client}>
        <SaveLoadMenu mode="game" isHost defaultName="2010年1月12日" />
      </ClientProvider>,
    );
    expect(screen.getByTestId('save-name')).toHaveValue('2010年1月12日');
    await userEvent.clear(screen.getByTestId('save-name'));
    await userEvent.type(screen.getByTestId('save-name'), '决战前');
    await userEvent.click(screen.getByTestId('save-submit'));
    expect(t.transport.payloads('game:save')).toEqual([{ name: '决战前' }]);
    expect(useUiStore.getState().toasts.at(-1)?.text).toBe('已存档');
    // 读档按钮只在大厅出现
    expect(screen.queryByTestId('save-load-s-ok')).toBeNull();
  });

  it('删除：先点「删除」再点「确认删除」才发 saves:delete；取消则不发', async () => {
    const t = makeTestClient();
    t.transport.respond('saves:list', () => ({ ok: true, data: { saves: [SAVES[0]!] } }));
    render(
      <ClientProvider client={t.client}>
        <SaveLoadMenu mode="game" isHost={false} />
      </ClientProvider>,
    );
    expect(await screen.findByText('只有房主可以存档和读档')).toBeInTheDocument();
    expect(screen.queryByTestId('save-name')).toBeNull();
    await userEvent.click(await screen.findByTestId('save-delete-s-ok'));
    await userEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(t.transport.payloads('saves:delete')).toHaveLength(0);
    await userEvent.click(screen.getByTestId('save-delete-s-ok'));
    await userEvent.click(screen.getByTestId('save-delete-confirm-s-ok'));
    expect(t.transport.payloads('saves:delete')).toEqual([{ saveId: 's-ok' }]);
  });

  it('导出：带 X-Player-Token 取回 .r4save 文本并触发下载（文件名取 Content-Disposition 的中文名）', async () => {
    const t = makeTestClient();
    t.transport.respond('saves:list', () => ({ ok: true, data: { saves: [SAVES[0]!] } }));
    const fetch = vi.fn<FetchLike>(
      async () =>
        new Response('R4S1.abc.sig', {
          status: 200,
          headers: {
            'Content-Disposition': `attachment; filename="s-ok.r4save"; filename*=UTF-8''${encodeURIComponent('官方存档.r4save')}`,
          },
        }),
    );
    const created: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob) => {
      created.push(b);
      return 'blob:rich4/1';
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn();
    let downloaded = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloaded = this.download;
    });
    render(
      <ClientProvider client={t.client}>
        <SaveLoadMenu mode="lobby" isHost http={{ fetch, storage }} />
      </ClientProvider>,
    );
    await userEvent.click(await screen.findByTestId('save-export-s-ok'));
    await waitFor(() => expect(downloaded).toBe('官方存档.r4save'));
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/saves/s-ok/export');
    expect(init?.headers).toMatchObject({ 'X-Player-Token': TOKEN });
    expect(await created[0]!.text()).toBe('R4S1.abc.sig');
  });

  it('导出被拒（存档所在对局还在进行）：给出具体原因', async () => {
    const t = makeTestClient();
    t.transport.respond('saves:list', () => ({ ok: true, data: { saves: [SAVES[0]!] } }));
    const fetch = vi.fn<FetchLike>(async () =>
      jsonResponse(
        { ok: false, error: { code: 'SAVE_FORBIDDEN', message: 'x', details: { reason: 'gameInProgress' } } },
        409,
      ),
    );
    render(
      <ClientProvider client={t.client}>
        <SaveLoadMenu mode="lobby" isHost http={{ fetch, storage }} />
      </ClientProvider>,
    );
    await userEvent.click(await screen.findByTestId('save-export-s-ok'));
    await waitFor(() =>
      expect(useUiStore.getState().toasts.at(-1)?.text).toBe('这个存档所在的对局还在进行中，请先结束或解散那个房间'),
    );
  });

  it('导入：把文件文本 POST 到 /api/saves/import；签名无效时提示非官方存档并刷新列表', async () => {
    const t = makeTestClient();
    let listed: SaveSummary[] = [];
    t.transport.respond('saves:list', () => ({ ok: true, data: { saves: listed } }));
    const imported = summary({ saveId: 'imp1', name: '朋友的存档', verified: false, createdAt: 9 });
    const fetch = vi.fn<FetchLike>(async () => {
      listed = [imported];
      return jsonResponse({ ok: true, data: imported });
    });
    render(
      <ClientProvider client={t.client}>
        <SaveLoadMenu mode="lobby" isHost http={{ fetch, storage }} />
      </ClientProvider>,
    );
    const file = new File(['R4S1.payload.badsig\n'], '朋友的存档.r4save', { type: 'application/octet-stream' });
    await userEvent.upload(screen.getByTestId('save-import-file'), file);
    expect(await screen.findByTestId('save-unofficial-imp1')).toHaveTextContent('非官方存档');
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/saves/import');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('R4S1.payload.badsig');
    expect(init?.headers).toMatchObject({ 'X-Player-Token': TOKEN });
    expect(useUiStore.getState().toasts.map((x) => x.text)).toContain(
      '已导入「朋友的存档」：签名无效，标记为非官方存档（仍可读取）',
    );
  });

  it('导入：不是 .r4save 的文件不上传；服务器判不兼容时带原因', async () => {
    const t = makeTestClient();
    const fetch = vi.fn<FetchLike>(async () =>
      jsonResponse(
        { ok: false, error: { code: 'SAVE_INCOMPATIBLE', message: 'x', details: { reason: 'badJson' } } },
        422,
      ),
    );
    render(
      <ClientProvider client={t.client}>
        <SaveLoadMenu mode="lobby" isHost http={{ fetch, storage }} />
      </ClientProvider>,
    );
    await userEvent.upload(screen.getByTestId('save-import-file'), new File(['hello'], 'x.r4save'));
    await waitFor(() =>
      expect(useUiStore.getState().toasts.at(-1)?.text).toBe('存档无法读取：不是有效的 .r4save 文件'),
    );
    expect(fetch).not.toHaveBeenCalled();
    await userEvent.upload(screen.getByTestId('save-import-file'), new File(['R4S1.xx.yy'], 'y.r4save'));
    await waitFor(() => expect(useUiStore.getState().toasts.at(-1)?.text).toBe('存档无法读取：文件内容损坏'));
  });
});

describe('TrusteeSettingsDialog', () => {
  const playing = roomView({
    phase: 'playing',
    seats: [human(0, '我', { isYou: true, host: true }), ai(1), human(2, '小红'), ai(3)],
  });
  const view = sp.batches[3]!.view;

  beforeEach(() => {
    act(() => useGameStore.getState().resetTo({ epoch: 1, seq: 1, view, pending: [], decision: null }));
  });

  it('比例对齐到 10 的倍数；初值取本人 aiTraits', () => {
    expect(snapRatio(33)).toBe(30);
    expect(snapRatio(-5)).toBe(0);
    expect(snapRatio(250)).toBe(100);
    const me = view.players.find((p) => p.seat === 0)!;
    expect(trusteeFromTraits(me.aiTraits).personality).toBe(me.aiTraits.personality);
  });

  it('改个性、用卡、比例后「开始托管」发 game:autopilot{on:true, settings}', async () => {
    const { transport } = renderWith(<TrusteeSettingsDialog room={playing} />);
    act(() => openTrusteeSettings());
    const dlg = await screen.findByTestId('trustee-dialog');
    expect(within(dlg).getByTestId('trustee-status')).toHaveTextContent('未托管');
    await userEvent.click(within(dlg).getByTestId('trustee-personality-2'));
    const cards = within(dlg).getByTestId('trustee-cards') as HTMLInputElement;
    const wasCards = cards.checked;
    await userEvent.click(cards);
    fireEvent.change(within(dlg).getByTestId('trustee-cash'), { target: { value: '50' } });
    fireEvent.change(within(dlg).getByTestId('trustee-stock'), { target: { value: '100' } });
    expect(within(dlg).getByTestId('trustee-cash-value')).toHaveTextContent('50%');
    await userEvent.click(within(dlg).getByTestId('trustee-on'));
    const sent = transport.payloads('game:autopilot');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      on: true,
      settings: { personality: 2, useCards: !wasCards, cashRatio: 50, stockRatio: 100 },
    });
    await waitFor(() => expect(screen.queryByTestId('trustee-dialog')).toBeNull());
  });

  it('托管中：显示原因，可「解除托管」（不带设置）或「保存设置」（保持托管）', async () => {
    const auto = {
      ...playing,
      seats: [{ ...playing.seats[0], control: 'autopilot:afk' as const }, ...playing.seats.slice(1)],
    } as typeof playing;
    const { transport } = renderWith(<TrusteeSettingsDialog room={auto} />);
    act(() => openTrusteeSettings());
    expect(await screen.findByTestId('trustee-status')).toHaveTextContent('托管中（连续超时）');
    await userEvent.click(screen.getByTestId('trustee-save'));
    expect(transport.payloads('game:autopilot')[0]).toMatchObject({ on: true, settings: expect.any(Object) });
    act(() => openTrusteeSettings());
    await userEvent.click(await screen.findByTestId('trustee-off'));
    expect(transport.payloads('game:autopilot')[1]).toEqual({ on: false });
  });

  it('观战者与大厅里不渲染', () => {
    const spec = roomView({ phase: 'playing', you: { role: 'spectator', id: 'x', isHost: false } });
    renderWith(<TrusteeSettingsDialog room={spec} />);
    act(() => openTrusteeSettings());
    expect(screen.queryByTestId('trustee-dialog')).toBeNull();
  });
});

describe('SystemMenu', () => {
  it('房主：解散要二次确认；玩家有托管设置入口', async () => {
    const room = roomView({ phase: 'playing' });
    const { transport } = renderWith(<SystemMenu room={room} open onOpenChange={() => {}} onLeave={() => {}} />);
    await userEvent.click(screen.getByTestId('menu-dissolve'));
    expect(screen.getByTestId('menu-dissolve-confirm-row')).toHaveTextContent('对局会先自动存档');
    expect(transport.payloads('room:dissolve')).toHaveLength(0);
    await userEvent.click(screen.getByTestId('menu-dissolve-confirm'));
    expect(transport.payloads('room:dissolve')).toHaveLength(1);
    // 托管设置叠在系统菜单上打开
    await userEvent.click(screen.getByTestId('menu-trustee'));
    expect(await screen.findByTestId('trustee-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('system-menu')).toBeInTheDocument();
  });

  it('观战者：没有暂停、解散与托管入口', () => {
    const room = roomView({ phase: 'playing', you: { role: 'spectator', id: 'x', isHost: false } });
    renderWith(<SystemMenu room={room} open onOpenChange={() => {}} onLeave={() => {}} />);
    expect(screen.queryByTestId('menu-pause')).toBeNull();
    expect(screen.queryByTestId('menu-dissolve')).toBeNull();
    expect(screen.queryByTestId('menu-trustee')).toBeNull();
    expect(screen.getByTestId('menu-leave')).toBeInTheDocument();
  });
});

describe('ReconnectOverlay 托管倒计时与恢复提示', () => {
  it('对局中的玩家：断线 1 秒后显示剩余秒数，超过宽限显示已托管；恢复后 toast', async () => {
    const base = roomView({ phase: 'playing' });
    act(() => useRoomStore.getState().setRoom({ ...base, settings: { ...base.settings, reconnectGraceSec: 5 } }));
    renderWith(<ReconnectOverlay />);
    act(() => useConnectionStore.getState().setStatus('reconnecting', 1));
    const grace = await screen.findByTestId('reconnect-grace', {}, { timeout: 2000 });
    expect(Number(grace.getAttribute('data-left'))).toBeGreaterThanOrEqual(3);
    expect(grace).toHaveTextContent('秒后由电脑托管你的角色');
    act(() => useConnectionStore.setState({ since: Date.now() - 6000 }));
    await waitFor(() => expect(screen.getByTestId('reconnect-grace')).toHaveTextContent('已由电脑托管'), {
      timeout: 1500,
    });
    act(() => useConnectionStore.getState().setStatus('open', 0));
    await waitFor(() => expect(screen.queryByTestId('reconnect-overlay')).toBeNull());
    expect(screen.getByTestId('toasts')).toHaveTextContent('已重新连接，对局已同步');
  });

  it('短暂抖动（不到 1 秒）不出遮罩也不提示恢复', async () => {
    renderWith(<ReconnectOverlay />);
    act(() => useConnectionStore.getState().setStatus('reconnecting', 1));
    await new Promise((r) => setTimeout(r, 300));
    act(() => useConnectionStore.getState().setStatus('open', 0));
    await new Promise((r) => setTimeout(r, 900));
    expect(screen.queryByTestId('reconnect-overlay')).toBeNull();
    expect(useUiStore.getState().toasts).toHaveLength(0);
  });
});

describe('观战者 HUD', () => {
  it('右上角「观战中」，没有掷骰、托管、卡片等操作按钮', async () => {
    useMapStore.getState().clear();
    const b = sp.batches[5]!;
    act(() =>
      useGameStore.getState().resetTo({ epoch: 1, seq: b.seq, view: b.view, pending: b.pending, decision: null }),
    );
    const room = roomView({
      phase: 'playing',
      seats: [human(0, '甲', { host: true }), ai(1), human(2, '乙'), ai(3)],
      spectators: [{ id: 'sp', nickname: '看客' }],
      you: { role: 'spectator', id: 'sp', isHost: false },
    });
    renderWith(<GameScreen room={room} onLeave={() => {}} />);
    expect(within(screen.getByTestId('top-bar')).getByText(/观战中/)).toBeInTheDocument();
    for (const id of [
      'action-roll',
      'action-autopilot',
      'action-cards',
      'action-items',
      'action-stock',
      'action-info',
    ]) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
    expect(screen.getByTestId('action-pad')).toHaveAttribute('data-role', 'spectator');
    await userEvent.click(screen.getByTestId('top-menu'));
    expect(await screen.findByTestId('system-menu')).toBeInTheDocument();
    expect(screen.queryByTestId('menu-trustee')).toBeNull();
  });
});

describe('M5 动态文案键', () => {
  it('不兼容原因、兼容性提示、托管个性、观战聊天范围、快捷语齐全', async () => {
    const i18next = (await import('i18next')).default;
    const reasons = [
      'badEncoding',
      'badJson',
      'tooLarge',
      'badFormat',
      'newerFormat',
      'newerState',
      'mapHashMismatch',
      'migrationFailed',
      'invalidState',
      'mapRefMismatch',
      'seatMismatch',
    ];
    for (const r of reasons) expect(i18next.exists(`ui:saveMenu.incompat.${r}`), r).toBe(true);
    for (const w of ['needsMigration', 'chatTailDropped'])
      expect(i18next.exists(`ui:saveMenu.warn.${w}`), w).toBe(true);
    expect(i18next.exists('hud:saves.tablesMismatch')).toBe(true);
    for (const p of [0, 1, 2]) expect(i18next.exists(`ui:trustee.personalities.${p}`), String(p)).toBe(true);
    for (const m of ['all', 'spectators', 'off'])
      expect(i18next.exists(`ui:social.spectatorChatMode.${m}`), m).toBe(true);
    for (let i = 0; i < 8; i++) expect(i18next.exists(`ui:social.quickPhrases.${i}`), String(i)).toBe(true);
  });
});
