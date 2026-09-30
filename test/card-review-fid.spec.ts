// 审查（原版忠实度，只读）：真实素材包、原版皮肤、original 节奏下实际出卡，记下每个亮卡弹窗的
// 出现 / 背景图到位 / 消失时刻（亮卡时长）、在 640×480 场景坐标里的几何（插画、消息框、文字行）、文字样式，并截舞台。
// 两名真人（P1 出卡，P2 同时观看）：P1 出 均富（无目标）、转向（有目标）、陷害 P2（P2 持免罪 → 被动卡）、梦游 P2（P2 持复仇 → 被动卡）。
// 输出：.cache/card/review-fid/casts.json 与 shots/。配置见 test/card-review-fid.config.ts（连 5741/3741，不启动服务）。
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import {
  acted,
  createRoom,
  debugAct,
  expect,
  newPlayer,
  pickCharacter,
  Q_ANIM,
  setReady,
  startGame,
  test,
  waitIdle,
  waitMyTurn,
} from '../e2e/fixtures/room';

const OUT = '.cache/card/review-fid';
mkdirSync(`${OUT}/shots`, { recursive: true });

async function recordCasts(page: Page): Promise<void> {
  // 跳过片头动画（真实素材包有 start.mp4）
  await page.addInitScript(() => localStorage.setItem('rich4.introSeen', '1'));
  await page.addInitScript(() => {
    const seen: Record<string, unknown>[] = [];
    const idx = new WeakMap<Element, number>();
    (window as unknown as { __casts: unknown[] }).__casts = seen;
    const rel = (el: Element | null, root: Element, s: number) => {
      if (!el) return null;
      const a = el.getBoundingClientRect();
      const b = root.getBoundingClientRect();
      const r = (v: number) => Math.round(v * 10) / 10;
      return { x: r((a.left - b.left) / s), y: r((a.top - b.top) / s), w: r(a.width / s), h: r(a.height / s) };
    };
    const scan = (): void => {
      const now = performance.now();
      const live = new Set<Element>();
      for (const el of document.querySelectorAll('[data-testid="card-cast-popup"]')) {
        live.add(el);
        const root = el.closest('[data-scene="classic"]');
        const art = el.querySelector<HTMLElement>('[data-testid="card-cast-art"]');
        let i = idx.get(el);
        if (i === undefined) {
          i = seen.length;
          idx.set(el, i);
          seen.push({ card: Number((el as HTMLElement).dataset.card), tOpen: now, el });
        }
        const row = seen[i]!;
        if (art?.style.backgroundImage && row.tBg === undefined && root) {
          const s = Number((root as HTMLElement).dataset.scale ?? '1');
          const line = el.querySelector('[data-testid="card-cast-line"]');
          const cs = line ? getComputedStyle(line) : null;
          Object.assign(row, {
            tBg: now,
            classic: !!el.closest('[data-classic="true"]'),
            variant: (el as HTMLElement).dataset.variant,
            mode: (el as HTMLElement).dataset.mode,
            key: art.dataset.assetKey,
            bg: art.style.backgroundImage,
            scale: s,
            art: rel(art, root, s),
            frame: rel(el.querySelector('[data-testid="card-cast-frame"]'), root, s),
            box: rel(el.querySelector('[data-testid="card-cast-box"]'), root, s),
            line: rel(line, root, s),
            target: rel(el.querySelector('[data-testid="card-cast-target"]'), root, s),
            text: line?.textContent,
            targetText: el.querySelector('[data-testid="card-cast-target"]')?.textContent ?? null,
            font: cs && {
              size: cs.fontSize,
              weight: cs.fontWeight,
              family: cs.fontFamily,
              color: cs.color,
              shadow: cs.textShadow,
              lineHeight: cs.lineHeight,
              stroke: (cs as unknown as Record<string, string>).webkitTextStroke,
            },
            skippable: el.closest('[data-skippable]')?.getAttribute('data-skippable'),
          });
        }
      }
      for (const row of seen) {
        if (row.tClose === undefined && !live.has(row.el as Element)) row.tClose = now;
      }
    };
    new MutationObserver(scan).observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'data-src'],
    });
  });
}

async function castsOf(page: Page): Promise<Record<string, unknown>[]> {
  return page.evaluate(() =>
    (window as unknown as { __casts: Record<string, unknown>[] }).__casts.map(({ el: _el, ...r }) => ({
      ...r,
      showMs: r.tClose !== undefined ? Math.round((r.tClose as number) - (r.tOpen as number)) : null,
    })),
  );
}

async function slotOf(page: Page, card: number): Promise<number> {
  return page.evaluate((c) => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const d = (window as any).__rich4.store.game.getState().decision;
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    return d.options.cards.find((r: any) => r.card === c).slot as number;
  }, card);
}

/** 本页第 index 个亮卡（从 0 数）背景图到位后约 delay ms 截整页 */
async function shootCast(page: Page, name: string, index: number, delay: number): Promise<void> {
  await page.waitForFunction(
    (i) => {
      const c = (window as unknown as { __casts: { tBg?: number }[] }).__casts;
      return c.length > i && c[i]!.tBg !== undefined;
    },
    index,
    { timeout: 90_000 },
  );
  await page.waitForTimeout(delay);
  await page.screenshot({ path: `${OUT}/shots/${name}.png` });
}

const castCount = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { __casts: unknown[] }).__casts.length);

/** 出一张卡；popups = 这次会出现几个亮卡（出卡 1 个，触发被动卡再加 1 个） */
async function useCard(
  A: Page,
  others: Page[],
  card: number,
  pick: string | null,
  tag: string,
  popups = 1,
): Promise<void> {
  await waitMyTurn(A);
  await expect(A.locator('[data-scene][data-testid$="-exit"]')).toHaveCount(0);
  await A.getByTestId('action-cards').click();
  const menu = A.locator('[data-testid="decision-TURN_MENU"][data-scene="classic"]');
  await expect(menu).toHaveAttribute('data-tab', 'cards');
  const cell = menu.getByTestId(`inv-card-${await slotOf(A, card)}`);
  await expect(cell).toBeEnabled();
  await cell.click();
  const picker = menu.getByTestId('target-picker');
  await expect(picker).toBeVisible();
  // 选目标面板（原版此时已亮过卡；网页版在 CARD_USED 才亮）
  await A.screenshot({ path: `${OUT}/shots/${tag}-picker-P1.png` });
  if (pick) await picker.getByTestId(pick).click();
  const pages = [A, ...others];
  const base = await Promise.all(pages.map(castCount));
  const shots: Promise<void>[] = [];
  pages.forEach((p, i) => {
    for (let j = 0; j < popups; j++) shots.push(shootCast(p, `${tag}-${j}-P${i + 1}-t400`, base[i]! + j, 400));
  });
  await A.getByTestId('target-confirm').click();
  await Promise.all(shots);
  for (const p of pages) await waitIdle(p);
}

test('审查：原版亮卡的时长、几何、文字（真实素材包）', async ({ browser }) => {
  const a = await newPlayer(browser, 'P1', Q_ANIM, { setup: async (pg) => recordCasts(pg) });
  const b = await newPlayer(browser, 'P2', Q_ANIM, { setup: async (pg) => recordCasts(pg) });
  const [A, B] = [a.page, b.page];
  const log: Record<string, unknown> = {};
  try {
    const code = await createRoom(A, { map: 'taiwan', timer: 'off', pacing: 'original' });
    await B.goto(`/r/${code}?${Q_ANIM}`);
    await expect(B.getByTestId('screen-room')).toBeVisible();
    await pickCharacter(A, 9);
    await pickCharacter(B, 4);
    await setReady(B);
    await startGame(A, [A, B]);
    log.skin = await A.evaluate(() => {
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      const s = (window as any).__rich4?.skin;
      return { boardInUse: s?.boardInUse, applied: s?.applied, lang: s?.lang };
    });
    log.pacing = await A.evaluate(
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      () => (window as any).__rich4.store.room?.getState?.().room?.settings?.pacing ?? null,
    );
    await waitMyTurn(A);
    await acted(A, () => debugAct(A, { op: 'teleport', seat: 0, node: 40, prev: 39 }));
    await acted(A, () => debugAct(A, { op: 'teleport', seat: 1, node: 41, prev: 40 }));
    await acted(A, () => debugAct(A, { op: 'give', seat: 0, cards: [1, 6, 17, 16], items: [] }));
    await acted(A, () => debugAct(A, { op: 'give', seat: 1, cards: [21], items: [] }));
    await waitIdle(B);

    await useCard(A, [B], 1, null, '01-card1');
    await useCard(A, [B], 6, 'target-actor-seat-1', '02-card6');
    await useCard(A, [B], 17, 'target-actor-seat-1', '03-card17-pardon21', 2);
    await acted(A, () => debugAct(A, { op: 'give', seat: 1, cards: [18], items: [] }));
    await waitIdle(B);
    await useCard(A, [B], 16, 'target-actor-seat-1', '04-card16-revenge18', 2);
  } finally {
    log.P1 = await castsOf(A).catch((e) => String(e));
    log.P2 = await castsOf(B).catch((e) => String(e));
    writeFileSync(`${OUT}/casts.json`, JSON.stringify(log, null, 1));
    for (const p of [a, b]) await p.context.close();
  }
});
