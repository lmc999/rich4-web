// client-browser：原版新闻板 / 命运板盖着工具列（440×480 贴舞台 (0,0)，工具列 REGION.toolbar 0,0,440,40）。场景是只读的
// （pointer-events: none），板面要自己接住指针（PopupScene 的 shield），否则真实浏览器的命中测试会把点在板子顶部的点击
// 交给板子下面看不见的工具列钮（查询 → 资产表、说明 → 说明框、托管 → 直接切换托管）。这里用真实鼠标点击与按键验证：
// 1) 有 shield：点 (260,20)（「查询」所在）只跳过板子，工具列钮收不到；按 M 不触发经典快捷键；
// 2) 对照（没有 shield 的只读场景）：同一下点击落到工具列钮上——这就是修复前命运板的样子。
// 图形全是现场画的色块（不含任何原版素材）。
import { createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { initI18n } from '../../../i18n';
import { useClassicHotkeys } from '../keyboard';
import { PopupScene, type SceneRect } from './PopupScene';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeAll(() => {
  initI18n('original');
});

afterEach(() => {
  root?.unmount();
  root = null;
  host?.remove();
  host = null;
});

const BOARD: SceneRect = { x: 0, y: 0, w: 440, h: 480 };

interface Rig {
  toolbar: HTMLButtonElement;
  onTool: ReturnType<typeof vi.fn>;
  onSkip: ReturnType<typeof vi.fn>;
  bigMap: ReturnType<typeof vi.fn>;
}

/** 经典快捷键（与 ClassicLayout 同一个 hook） */
function Hotkeys({ bigMap }: { bigMap: () => void }): ReactNode {
  useClassicHotkeys({ roll: () => {}, cycleDice: () => {}, rotate: () => {}, bigMap });
  return null;
}

/** 舞台替身：640×480，(0,0,440,40) 是「工具列」钮（z 40，同经典布局），上面叠一个只读的板子场景（SCENE_Z 48） */
async function mount(shield: SceneRect | undefined, anyInputSkips = true): Promise<Rig> {
  host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:0;top:0;width:640px;height:480px;background:#204060';
  document.body.appendChild(host);
  const onTool = vi.fn();
  const onSkip = vi.fn();
  const bigMap = vi.fn();
  root = createRoot(host);
  root.render(
    createElement(
      'div',
      { style: { position: 'absolute', inset: 0 } },
      createElement(
        'button',
        {
          type: 'button',
          'data-testid': 'fake-toolbar',
          onClick: onTool,
          style: { position: 'absolute', left: 0, top: 0, width: 440, height: 40, zIndex: 40 },
        },
        'toolbar',
      ),
      createElement(Hotkeys, { bigMap }),
      createElement(
        PopupScene,
        { kind: 'fate', label: 'fate', minMs: 0, onSkip, anyInputSkips, shield },
        createElement('section', {
          style: { position: 'absolute', left: 0, top: 0, width: 440, height: 480, background: '#7030a0' },
        }),
      ),
    ),
  );
  await vi.waitFor(() => {
    if (!host?.querySelector('[data-scene="classic"]')) throw new Error('场景未挂载');
  });
  const toolbar = host.querySelector<HTMLButtonElement>('[data-testid="fake-toolbar"]')!;
  return { toolbar, onTool, onSkip, bigMap };
}

describe('板面接住指针（真实命中测试）', () => {
  it('命运板：点板子顶部（工具列「查询」的位置）只跳过板子，工具列钮收不到；按 M 不切大地图', async () => {
    const r = await mount(BOARD);
    const hit = document.elementFromPoint(260, 20);
    expect(hit?.getAttribute('data-testid')).toBe('popup-shield');
    // force：不做可操作性检查，按坐标真实点下去（落在谁身上由浏览器决定）
    await userEvent.click(r.toolbar, { force: true, position: { x: 260, y: 20 } } as never);
    expect(r.onTool).not.toHaveBeenCalled();
    expect(r.onSkip).toHaveBeenCalledTimes(1);
    // 右键同样只跳过
    await userEvent.click(r.toolbar, { force: true, button: 'right', position: { x: 100, y: 20 } } as never);
    expect(r.onTool).not.toHaveBeenCalled();
    expect(r.onSkip).toHaveBeenCalledTimes(2);
    // 键盘：M 放开时跳过，但不触发经典快捷键（焦点不在按钮上，按钮上的按键本来就不算快捷键）
    (document.activeElement as HTMLElement | null)?.blur();
    await userEvent.keyboard('m');
    expect(r.bigMap).not.toHaveBeenCalled();
    expect(r.onSkip).toHaveBeenCalledTimes(3);
  });

  it('新闻板（没有 anyInputSkips）：点板子不往下传，可跳过时点板子等于点跳过钮', async () => {
    const r = await mount(BOARD, false);
    await vi.waitFor(() => {
      if (!host?.querySelector('[data-testid="popup-skip"]')) throw new Error('跳过钮未出现');
    });
    await userEvent.click(r.toolbar, { force: true, position: { x: 260, y: 20 } } as never);
    expect(r.onTool).not.toHaveBeenCalled();
    expect(r.onSkip).toHaveBeenCalledTimes(1);
  });

  it('对照：没有 shield 的只读场景，同一下点击落到工具列钮上（修复前的命运板）', async () => {
    const r = await mount(undefined);
    expect(document.elementFromPoint(260, 20)).toBe(r.toolbar);
    await userEvent.click(r.toolbar, { force: true, position: { x: 260, y: 20 } } as never);
    expect(r.onTool).toHaveBeenCalledTimes(1);
    (document.activeElement as HTMLElement | null)?.blur();
    await userEvent.keyboard('m');
    expect(r.bigMap).toHaveBeenCalledTimes(1);
  });
});
