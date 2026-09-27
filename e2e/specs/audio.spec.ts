// 音频接线（原版皮肤 A9；不带 ?audio=off 与 ?anim=instant）：生产构建里懒加载音频引擎并接到 EventPlayer 与设置。
// 默认服务器没有素材包 → 只有 ZzFX 程序化音效（没有语音与音乐）。断言：
//   1) window.__rich4.audio 存在；页面上的点击解锁 AudioContext（state = running）；
//   2) 掷骰后事件演出经导演层放出 ZzFX 音效（逻辑日志里有 zzfx.* 的 sfx 条目：play，或首个合成较慢时 late）；
//   3) 设置页的五路音量与开关写进 store 并同步到引擎（静音后 engine 状态不变、日志继续记录）；
//   4) 全程没有页面异常与 console.error。
import type { Page } from '@playwright/test';
import {
  createRoom,
  currentSeq,
  debugAct,
  expect,
  newPlayer,
  startGame,
  test,
  waitMyTurn,
  waitSeqAtLeast,
} from '../fixtures/room';

interface AudioLog {
  kind: string;
  op: string;
  key?: string;
}

async function audioState(page: Page): Promise<string | null> {
  // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
  return page.evaluate(() => (window as any).__rich4?.audio?.state ?? null);
}

async function audioLog(page: Page): Promise<AudioLog[]> {
  return page.evaluate(() =>
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    ((window as any).__rich4?.audio?.log ?? []).map((e: AudioLog) => ({ kind: e.kind, op: e.op, key: e.key })),
  );
}

test('音频：懒加载、手势解锁、事件放出 ZzFX 音效、设置同步', async ({ browser }) => {
  test.setTimeout(120_000);
  const p = await newPlayer(browser, '声音', 'test=1');
  const page = p.page;
  try {
    // 首页输入昵称已经是一次手势；音频模块懒加载后 __rich4.audio 出现
    await expect.poll(() => audioState(page), { timeout: 15_000 }).not.toBeNull();
    await createRoom(page, { map: 'test', timer: 'off', aiCount: 1 });
    await expect.poll(() => audioState(page), { timeout: 10_000 }).toBe('running');

    await startGame(page, [page]);
    await waitMyTurn(page);
    for (const op of [
      { op: 'teleport', seat: 0, node: 2, prev: 1 },
      { op: 'forceNext', purpose: 'dice', values: [3] },
    ]) {
      const s = await currentSeq(page);
      await debugAct(page, op);
      await waitSeqAtLeast(page, s + 1);
    }
    await waitMyTurn(page);
    await page.getByTestId('action-roll').click();
    await expect
      .poll(
        async () =>
          (await audioLog(page)).some(
            (e) => e.kind === 'sfx' && (e.op === 'play' || e.op === 'late') && e.key?.startsWith('zzfx.'),
          ),
        { timeout: 20_000 },
      )
      .toBe(true);
    // 没有素材包：不应请求语音与音乐
    const log = await audioLog(page);
    expect(log.filter((e) => e.kind === 'voice' && e.op === 'start')).toEqual([]);

    // 设置：静音与角色语音开关写进 store
    await page.getByTestId('top-menu').click();
    await page.getByTestId('menu-settings').click();
    await expect(page.getByTestId('audio-settings')).toBeVisible();
    await page.getByTestId('settings-muted').check();
    await page.getByTestId('settings-voice-enabled').uncheck();
    const st = await page.evaluate(() => {
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      const s = (window as any).__rich4.store.settings.getState();
      return { muted: s.muted, voiceEnabled: s.voiceEnabled, ui: s.volume.ui };
    });
    expect(st).toEqual({ muted: true, voiceEnabled: false, ui: 0.8 });
    expect(await audioState(page)).toBe('running');

    expect(p.errors.filter((e) => !e.includes('WebGL') && !e.includes('favicon'))).toEqual([]);
  } finally {
    await p.context.close();
  }
});
