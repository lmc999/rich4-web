import type { SaveSummary } from '@rich4/shared/net';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { memoryLocation } from 'wouter/memory-location';
import { useRoomStore } from '../store/roomStore';
import { useUiStore } from '../store/uiStore';
import { makeTestClient } from '../test/fakeTransport';
import { roomView } from '../test/roomFixtures';
import { App } from './App';
import { ClientProvider } from './services';

// 开发页含 Pixi（jsdom 无 WebGL），路由测试只验证懒加载分发到正确的组件
vi.mock('../dev/MapPreview', () => ({ default: () => <div data-testid="dev-map-mock">map</div> }));
vi.mock('../dev/Gallery', () => ({ default: () => <div data-testid="dev-gallery-mock">gallery</div> }));
vi.mock('../ui/decisions/DevDecisions', () => ({
  default: () => <div data-testid="dev-decisions-mock">decisions</div>,
}));

function renderAt(path: string, setup?: (t: ReturnType<typeof makeTestClient>) => void) {
  const loc = memoryLocation({ path, record: true });
  const t = makeTestClient();
  setup?.(t);
  const utils = render(
    <ClientProvider client={t.client}>
      <App hook={loc.hook} />
    </ClientProvider>,
  );
  return { ...utils, loc, ...t };
}

afterEach(() => {
  useRoomStore.getState().clear();
  useUiStore.getState().clear();
});

const SAVE: SaveSummary = {
  saveId: 'sv-1',
  name: '周末那局',
  kind: 'manual',
  mapId: 'test',
  gameDay: 12,
  date: 20100112,
  seats: [
    { characterId: 9, nickname: '我', wasHuman: true },
    { characterId: 4, nickname: '电脑', wasHuman: false },
  ],
  createdAt: 1,
  compatible: true,
  verified: true,
};

describe('路由', () => {
  it('/ 首页：标题、昵称、建房、加入、单机、设置、开发页入口', () => {
    renderAt('/');
    expect(screen.getByTestId('screen-home')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('大富翁4 联机版');
    expect(screen.getByTestId('home-nickname')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '创建房间' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '输入房间号加入' })).toBeEnabled();
    expect(screen.getByRole('link', { name: '单机对战电脑' })).toHaveAttribute('href', '/solo');
    expect(screen.getByRole('link', { name: '地图预览' })).toHaveAttribute('href', '/dev/map');
    expect(screen.getByRole('link', { name: '美术画廊' })).toHaveAttribute('href', '/dev/gallery');
    expect(screen.getByRole('link', { name: '对话框样板' })).toHaveAttribute('href', '/dev/decisions');
  });

  it('输入房间号加入：校验 6 位数字后跳到 /r/:code；观战带 ?watch=1', async () => {
    const { loc } = renderAt('/');
    await userEvent.click(screen.getByTestId('home-join-open'));
    await userEvent.type(screen.getByTestId('home-join-code'), '12a34');
    await userEvent.click(screen.getByTestId('home-join'));
    expect(screen.getByTestId('home-error')).toHaveTextContent('6 位数字');
    await userEvent.type(screen.getByTestId('home-join-code'), '56');
    await userEvent.click(screen.getByTestId('home-watch'));
    expect(loc.history?.at(-1)).toBe('/r/123456?watch=1');
  });

  it('首页「读取存档」：列出本人的存档（可导入）；读取时新建私密房间 → room:loadSave → 保持私密 → 进入该房间', async () => {
    const { loc, transport } = renderAt('/', (t) =>
      t.transport.respond('saves:list', () => ({ ok: true, data: { saves: [SAVE] } })),
    );
    const open = screen.getByTestId('home-load-open');
    expect(open).toHaveTextContent('读取存档');
    await userEvent.click(open);
    const panel = await screen.findByTestId('home-saves');
    expect(within(panel).getByTestId('save-import')).toBeInTheDocument();
    const item = await within(panel).findByTestId('save-sv-1');
    expect(item).toHaveTextContent('周末那局');
    // 首页没有存档表单
    expect(within(panel).queryByTestId('save-name')).toBeNull();
    await userEvent.click(within(item).getByTestId('save-load-sv-1'));
    await waitFor(() => expect(loc.history?.at(-1)).toBe('/r/123456'));
    const order = transport.sent.map((x) => x.event).filter((e) => e.startsWith('room:'));
    expect(order.slice(0, 3)).toEqual(['room:create', 'room:loadSave', 'room:updateSettings']);
    expect(transport.payloads('room:create')).toEqual([{ settings: { visibility: 'private' } }]);
    expect(transport.payloads('room:loadSave')).toEqual([{ saveId: 'sv-1' }]);
    expect(transport.payloads('room:updateSettings')).toEqual([{ patch: { visibility: 'private' } }]);
  });

  it('首页读档失败（对局还在进行）：离开临时房间、留在首页并提示原因', async () => {
    const { loc, transport } = renderAt('/', (t) => {
      t.transport.respond('saves:list', () => ({ ok: true, data: { saves: [SAVE] } }));
      t.transport.respond('room:loadSave', () => ({
        ok: false,
        error: { code: 'SAVE_FORBIDDEN', message: 'x', details: { reason: 'gameInProgress' } },
      }));
    });
    await userEvent.click(screen.getByTestId('home-load-open'));
    await userEvent.click(await screen.findByTestId('save-load-sv-1'));
    expect(await screen.findByText('这个存档所在的对局还在进行中，请先结束或解散那个房间')).toBeInTheDocument();
    expect(transport.payloads('room:leave')).toHaveLength(1);
    expect(transport.payloads('room:updateSettings')).toEqual([]);
    expect(loc.history?.at(-1)).toBe('/');
    expect(screen.getByTestId('screen-home')).toBeInTheDocument();
  });

  it('首页「读取存档」要先填昵称', async () => {
    renderAt('/');
    await userEvent.clear(screen.getByTestId('home-nickname'));
    await userEvent.click(screen.getByTestId('home-load-open'));
    expect(screen.getByTestId('home-error')).toHaveTextContent('请先填写昵称');
    expect(screen.queryByTestId('home-saves')).toBeNull();
  });

  it('/r/:code 进房：发 room:join，收到 room:state 后显示房间大厅', async () => {
    const { transport } = renderAt('/r/654321');
    await waitFor(() => expect(transport.payloads('room:join')).toEqual([{ code: '654321', role: 'player' }]));
    transport.push('room:state', roomView({ code: '654321' }));
    expect(await screen.findByTestId('screen-room')).toHaveAttribute('data-phase', 'lobby');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('房间 654321');
  });

  it('/r/:code 房间不存在：显示错误并可回首页', async () => {
    renderAt('/r/111111', (t) =>
      t.transport.respond('room:join', () => ({ ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'x' } })),
    );
    expect(await screen.findByTestId('room-error')).toHaveTextContent('房间不存在或已关闭');
  });

  it('/r/:code 房间号非法', async () => {
    renderAt('/r/abc');
    expect(await screen.findByTestId('room-error')).toHaveTextContent('房间号无效');
  });

  it('/solo：建私密房、补 3 个电脑、开局后进入 /r/<code>', async () => {
    const { loc, transport } = renderAt('/solo');
    await waitFor(() => expect(loc.history?.at(-1)).toBe('/r/123456'));
    expect(transport.payloads('room:setSeatAi')).toHaveLength(3);
    expect(transport.payloads('room:start')).toHaveLength(1);
  });

  it('未知路径显示 404', () => {
    renderAt('/nope/here');
    expect(screen.getByTestId('screen-not-found')).toBeInTheDocument();
    expect(screen.getByText('地址 /nope/here 不存在。')).toBeInTheDocument();
  });

  it('/dev/map 与 /dev/gallery 懒加载到开发页', async () => {
    renderAt('/dev/map');
    expect(await screen.findByTestId('dev-map-mock')).toBeInTheDocument();
  });

  it('/dev/gallery', async () => {
    renderAt('/dev/gallery');
    expect(await screen.findByTestId('dev-gallery-mock')).toBeInTheDocument();
  });

  it('/dev/decisions 懒加载到对话框样板页', async () => {
    renderAt('/dev/decisions');
    expect(await screen.findByTestId('dev-decisions-mock')).toBeInTheDocument();
  });
});
