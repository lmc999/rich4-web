// client-browser：决策层在手机横屏（844×390）下的排版（architecture §20.6 遗留的观感问题）——
// 小游戏开场对话框内容多于可用高度时，内容区是真正的滚动容器（Chromium 的 <fieldset> 作 flex 项被压缩时不会滚动、
// 内容画到底栏下面），底栏完整、不压住内容；滚到底能看到最后一行键值；对话框不高出决策层（不挡顶栏菜单）。
// 桌面尺寸下对话框按内容高度显示、不出滚动条。
// 对话框模块动态导入：与生产构建一样，对话框 chunk 的 CSS 排在 HUD 的 CSS 之后（同优先级时后者生效）。
import '../theme/tokens.css';
import '../theme/global.css';
import { DECISION_KINDS } from '@rich4/shared/engine';
import { type ComponentType, createElement, type ReactElement, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { initI18n } from '../../i18n';
import { demoDecisions, demoMap, demoOptions, demoView, makeDecision } from '../decisions/devFixtures';
import type { DecisionProps } from '../decisions/types';
import h from './hud.module.css';

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let MinigameIntro: ComponentType<DecisionProps<'MINIGAME'>>;
let DecisionHost: ComponentType<DecisionProps>;

beforeAll(async () => {
  initI18n('original');
  MinigameIntro = (await import('../decisions/MinigameIntro')).default;
  DecisionHost = (await import('../decisions/DecisionHost')).DecisionHost;
});

afterEach(() => {
  root?.unmount();
  root = null;
  host?.remove();
  host = null;
});

function mountLayer(child: ReactElement): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  root.render(
    createElement(
      'main',
      { className: h.game },
      createElement('div', { className: h.decisionLayer, 'data-testid': 'decision-layer' }, child),
    ),
  );
  return host;
}

async function frames(n = 3): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(() => r(null)));
}

/** 等对话框的入场动画（motion 弹簧，略有过冲）停下：transform 复位且外框位置连续几次采样不变 */
async function settled(el: HTMLElement): Promise<void> {
  let last = '';
  let same = 0;
  for (let i = 0; i < 300 && same < 4; i++) {
    await frames(2);
    const r = el.getBoundingClientRect();
    const k = `${r.top.toFixed(2)},${r.height.toFixed(2)},${r.width.toFixed(2)}`;
    const tf = el.style.transform;
    const rest = tf === '' || tf === 'none';
    same = k === last && rest ? same + 1 : 0;
    last = k;
  }
}

const rect = (el: Element): DOMRect => el.getBoundingClientRect();

async function renderIntro(minigameId: 'penguin' | 'balloon' | 'xicong'): Promise<{
  layer: HTMLElement;
  frame: HTMLElement;
  body: HTMLElement;
  foot: HTMLElement;
}> {
  const map = demoMap();
  const view = demoView(map);
  const now = Date.now();
  const decision = makeDecision(
    'MINIGAME',
    { ...demoOptions(view, 0).MINIGAME, minigameId },
    { now, timeoutMs: 30_000, minigame: { startsAt: now + 20_000, sessionId: `layout-${minigameId}` } },
  );
  const props: DecisionProps<'MINIGAME'> = {
    decision,
    isMine: true,
    view,
    map,
    submit: () => undefined,
    now: () => Date.now(),
  };
  const el = mountLayer(createElement(Suspense, null, createElement(MinigameIntro, props)));
  await expect.poll(() => el.querySelector('[data-testid="decision-MINIGAME"]')).not.toBeNull();
  const frame = el.querySelector('[data-testid="decision-MINIGAME"]') as HTMLElement;
  await settled(frame);
  const [body, foot] = [...frame.querySelectorAll(':scope > fieldset')] as HTMLElement[];
  return { layer: el.querySelector('[data-testid="decision-layer"]')!, frame, body: body!, foot: foot! };
}

describe('决策层 · 手机横屏 844×390', () => {
  for (const minigameId of ['penguin', 'balloon', 'xicong'] as const) {
    it(`小游戏开场（${minigameId}）：内容区可滚动，底栏完整且不压住内容`, async () => {
      await page.viewport(844, 390);
      const { layer, frame, body, foot } = await renderIntro(minigameId);
      const L = rect(layer);
      const F = rect(frame);
      const B = rect(body);
      const T = rect(foot);
      const info = JSON.stringify({ L, F, B, T, scroll: body.scrollHeight, client: body.clientHeight });
      // 对话框在决策层之内
      expect(F.top, info).toBeGreaterThanOrEqual(L.top - 0.5);
      expect(F.bottom, info).toBeLessThanOrEqual(L.bottom + 0.5);
      // 底栏完整：在对话框里，按钮都在底栏框内
      expect(T.bottom, info).toBeLessThanOrEqual(F.bottom + 0.5);
      for (const b of foot.querySelectorAll('button')) {
        expect(rect(b).top, info).toBeGreaterThanOrEqual(T.top - 0.5);
        expect(rect(b).bottom, info).toBeLessThanOrEqual(T.bottom + 0.5);
      }
      // 内容区在底栏之上；内容比可用高度多，确实可以滚动
      expect(B.bottom, info).toBeLessThanOrEqual(T.top + 0.5);
      expect(body.scrollHeight, info).toBeGreaterThan(body.clientHeight);
      // 未滚动时，底栏上方点到的是底栏自己（内容没有画到底栏下面透出来）；内容区外的最后一行被裁掉
      const lastRow = [...body.querySelectorAll('dl dt, dl dd')].at(-1)!;
      const probe = document.elementFromPoint(T.left + 24, T.top + 6);
      expect(foot.contains(probe), info).toBe(true);
      // 滚到底：最后一行键值完整露在内容区里、在底栏之上
      body.scrollTop = body.scrollHeight;
      await frames();
      expect(body.scrollTop, info).toBeGreaterThan(0);
      const R = rect(lastRow);
      expect(R.bottom, info).toBeLessThanOrEqual(rect(body).bottom + 0.5);
      expect(R.bottom, info).toBeLessThanOrEqual(rect(foot).top + 0.5);
      expect(document.elementFromPoint(R.left + 4, R.top + R.height / 2)).toBe(lastRow.firstChild?.parentElement);
    });
  }

  it('全部 23 种决策对话框：外框在决策层内，底栏完整、在内容区之下', async () => {
    await page.viewport(844, 390);
    const map = demoMap();
    const view = demoView(map);
    const all = demoDecisions(view, { now: Date.now(), timeoutMs: 30_000 });
    for (const kind of DECISION_KINDS) {
      const el = mountLayer(
        createElement(DecisionHost, {
          decision: all[kind],
          isMine: true,
          view,
          map,
          submit: () => undefined,
          now: () => Date.now(),
        } as unknown as DecisionProps),
      );
      await expect.poll(() => el.querySelector(`[data-testid="decision-${kind}"]`), { timeout: 5000 }).not.toBeNull();
      const frame = el.querySelector(`[data-testid="decision-${kind}"]`) as HTMLElement;
      await settled(frame);
      const L = rect(el.querySelector('[data-testid="decision-layer"]')!);
      const F = rect(frame);
      const sets = [...frame.querySelectorAll(':scope > fieldset')] as HTMLElement[];
      const info = `${kind} ${JSON.stringify({ L, F, sets: sets.map((x) => rect(x)) })}`;
      expect(F.top, info).toBeGreaterThanOrEqual(L.top - 0.5);
      expect(F.bottom, info).toBeLessThanOrEqual(L.bottom + 0.5);
      const [body, foot] = sets;
      expect(body, info).toBeDefined();
      // 内容区高度确定：要么放得下，要么是真正的滚动容器（能滚动）
      if (body!.scrollHeight > body!.clientHeight + 1) {
        body!.scrollTop = 10;
        await frames();
        expect(body!.scrollTop, info).toBeGreaterThan(0);
        body!.scrollTop = 0;
      }
      expect(rect(body!).bottom, info).toBeLessThanOrEqual(F.bottom + 0.5);
      if (foot) {
        expect(rect(foot).top, info).toBeGreaterThanOrEqual(rect(body!).bottom - 0.5);
        expect(rect(foot).bottom, info).toBeLessThanOrEqual(F.bottom + 0.5);
      }
      root?.unmount();
      root = null;
      host?.remove();
      host = null;
    }
  }, 60_000);

  it('桌面 1280×800：对话框按内容高度显示，内容区不出滚动条', async () => {
    await page.viewport(1280, 800);
    const { body, foot, frame } = await renderIntro('xicong');
    expect(body.scrollHeight).toBeLessThanOrEqual(body.clientHeight + 1);
    expect(rect(foot).bottom).toBeLessThanOrEqual(rect(frame).bottom + 0.5);
  });
});
