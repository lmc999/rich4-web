import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { memoryLocation } from 'wouter/memory-location';
import { App } from './App';

// 开发页含 Pixi（jsdom 无 WebGL），路由测试只验证懒加载分发到正确的组件
vi.mock('../dev/MapPreview', () => ({ default: () => <div data-testid="dev-map-mock">map</div> }));
vi.mock('../dev/Gallery', () => ({ default: () => <div data-testid="dev-gallery-mock">gallery</div> }));

function renderAt(path: string) {
  const loc = memoryLocation({ path, record: true });
  const utils = render(<App hook={loc.hook} />);
  return { ...utils, loc };
}

describe('路由与占位页', () => {
  it('/ 首页：标题、单机入口、开发页入口；建房与加入暂不可用', () => {
    renderAt('/');
    expect(screen.getByTestId('screen-home')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('大富翁4 联机版');
    expect(screen.getByRole('button', { name: '创建房间' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '输入房间号加入' })).toBeDisabled();
    expect(screen.getByRole('link', { name: '单机对战电脑' })).toHaveAttribute('href', '/solo');
    expect(screen.getByRole('link', { name: '地图预览' })).toHaveAttribute('href', '/dev/map');
    expect(screen.getByRole('link', { name: '美术画廊' })).toHaveAttribute('href', '/dev/gallery');
  });

  it('/r/:code 房间占位页显示房间号（大写）', () => {
    renderAt('/r/abc123');
    expect(screen.getByTestId('screen-room')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('房间 ABC123');
  });

  it('/solo 单机占位页可回到首页', async () => {
    const { loc } = renderAt('/solo');
    expect(screen.getByTestId('screen-solo')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: '回到首页' }));
    expect(loc.history?.at(-1)).toBe('/');
    expect(await screen.findByTestId('screen-home')).toBeInTheDocument();
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
});
