// client-browser：真实 WebGL 下的 GameRenderer 冒烟（design/client.md §12.1 第 3 类）
import { buildTestMapAllKinds } from '@rich4/shared/data';
import type { WebGLRenderer } from 'pixi.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameRenderer } from './GameRenderer';
import { CHARACTERS } from './procedural/character/defs';
import { characterSvg } from './procedural/character/svg';

let host: HTMLDivElement;
let r: GameRenderer | null = null;
let consoleError: ReturnType<typeof vi.spyOn>;

const nextFrame = (): Promise<void> => new Promise((res) => requestAnimationFrame(() => res()));

/** 等待一次 DOM 事件，超时返回 false */
function waitEvent(target: EventTarget, name: string, ms: number): Promise<boolean> {
  return new Promise((res) => {
    const timer = setTimeout(() => res(false), ms);
    target.addEventListener(
      name,
      () => {
        clearTimeout(timer);
        res(true);
      },
      { once: true },
    );
  });
}

/** 读回画面像素，统计不同颜色数（空画面只有背景色） */
function distinctColors(g: GameRenderer): number {
  const { pixels } = g.app.renderer.extract.pixels({ target: g.app.stage });
  const seen = new Set<number>();
  for (let i = 0; i < pixels.length; i += 4 * 37) {
    seen.add((pixels[i]! << 16) | (pixels[i + 1]! << 8) | pixels[i + 2]!);
    if (seen.size > 64) break;
  }
  return seen.size;
}

beforeEach(() => {
  host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:0;top:0;width:960px;height:640px';
  document.body.appendChild(host);
  consoleError = vi.spyOn(console, 'error');
});

afterEach(() => {
  r?.destroy();
  r = null;
  host.remove();
  consoleError.mockRestore();
});

describe('GameRenderer（Chromium + WebGL）', () => {
  it('加载 test-allkinds：分层对象数正确、渲染出非空画面、无报错', async () => {
    r = await GameRenderer.create({ host, quality: 'mid' });
    expect(r.app.renderer.name).toBe('webgl');
    await r.loadMap(buildTestMapAllKinds());
    expect(r.board.stats()).toMatchObject({
      tiles: 26,
      lots: 5,
      facilities: 1,
      companies: 3,
      landmarks: 2,
      viaCells: 2,
      decorations: 6,
      brokenRoadSteps: 0,
    });
    // objects 层：5 住宅 + 1 设施 + 3 企业 + 2 地标 + 6 装饰
    expect(r.sceneStats().objects).toBe(17);
    expect(r.sceneStats().ground).toBeGreaterThan(0);
    expect(r.cache.size).toBeGreaterThan(0);
    r.app.render();
    await nextFrame();
    expect(distinctColors(r)).toBeGreaterThan(8);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('地块状态、角色图集与行走（含 via 连接格）', async () => {
    r = await GameRenderer.create({ host });
    await r.loadMap(buildTestMapAllKinds());
    for (const id of r.board.landLotIds()) r.board.setLotState(id, { owner: 1, level: 5 });
    r.board.setLotState('F1', { owner: 2, level: 4, facility: 'hotel' });
    const frames = await r.loadCharacter('sunXiaomei');
    const actor = r.board.addActor(0, frames, '孙小美', 21);
    r.setInstant(true);
    await actor.walk([21, 22, 23, 24, 25]);
    expect(actor.tile).toBe(25);
    r.app.render();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('4 向旋转后拾取仍命中同一格', async () => {
    r = await GameRenderer.create({ host });
    await r.loadMap(buildTestMapAllKinds());
    for (let i = 0; i < 4; i++) {
      r.rotate(1);
      r.app.render();
      const p = r.camera.worldToScreen(r.board.tileScreenPos(24));
      expect(r.pickScreen(p)?.tile).toBe(24);
    }
    expect(r.rotation).toBe(0);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('宿主晚于 window resize 才变尺寸（React 提交晚于 Pixi 读尺寸那一帧）：画布、屏幕与镜头视窗仍跟着宿主', async () => {
    const g = await GameRenderer.create({ host, quality: 'low' });
    r = g;
    // 先发 window resize，让 Pixi 在下一帧读到旧的宿主尺寸，之后宿主才变
    window.dispatchEvent(new Event('resize'));
    await nextFrame();
    host.style.width = '500px';
    host.style.height = '300px';
    await vi.waitFor(() => expect(g.app.screen).toMatchObject({ width: 500, height: 300 }));
    const b = g.app.canvas.getBoundingClientRect();
    expect([b.width, b.height]).toEqual([500, 300]);
    expect(g.camera.effectiveViewport()).toMatchObject({ w: 500, h: 300 });
    // 销毁后不再观察宿主（宿主再变尺寸不报错）
    g.destroy();
    r = null;
    host.style.width = '400px';
    for (let i = 0; i < 3; i++) await nextFrame();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('WebGL 上下文丢失并恢复后重建纹理，画面仍非空', async (ctx) => {
    r = await GameRenderer.create({ host });
    await r.loadMap(buildTestMapAllKinds());
    const renderer = r;
    const canvas = renderer.app.canvas;
    const gl = (renderer.app.renderer as WebGLRenderer).gl;
    const ext = gl.getExtension('WEBGL_lose_context');
    if (!ext) return ctx.skip('WEBGL_lose_context 不可用');
    const lost = waitEvent(canvas, 'webglcontextlost', 3000);
    ext.loseContext();
    if (!(await lost)) return ctx.skip('本浏览器不派发 webglcontextlost');
    const restored = waitEvent(canvas, 'webglcontextrestored', 3000);
    ext.restoreContext();
    // 部分无头 GPU 后端（SwiftShader）不派发恢复事件：此时无法验证重建路径
    if (!(await restored)) return ctx.skip('本浏览器不派发 webglcontextrestored');
    for (let i = 0; i < 3; i++) await nextFrame();
    renderer.app.render();
    expect(distinctColors(renderer)).toBeGreaterThan(8);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('SVG 角色在浏览器里可解码', async () => {
    for (const c of CHARACTERS) {
      const img = new Image();
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(characterSvg(c, 'cheer', 'front'))}`;
      await img.decode();
      expect(img.naturalWidth).toBe(128);
      expect(img.naturalHeight).toBe(160);
    }
  });
});
