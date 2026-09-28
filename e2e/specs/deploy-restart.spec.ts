// 部署实例重启恢复（architecture M11 验证 4；design/net.md §8.5）：对着已部署的实例（E2E_BASE_URL）开一局——2 个真人页面
// + 2 个电脑补位（测试图、不限时、紧凑节奏，断线宽限放到最大 120 秒，重启慢也不会先进托管）——两个真人各走两回合后停在
// P1 的回合菜单，记下 epoch、seq、最新权威 view 与 HUD；然后执行 E2E_RESTART_CMD（在仓库根目录用 shell 执行，例如
// `docker compose -f deploy/docker-compose.yml restart app`）重启服务器。断言：
//   1) 两个页面都出现断线遮罩（server:notice{shutdown} 后服务器断开），随后自动重连、遮罩消失并提示「已重新连接」；
//   2) 仍在同一房间、同一座位，房间回到 playing；对局 epoch 加 1、seq 不变，最新 view 与 HUD 与重启前完全一致
//      （恢复出来的是同一状态，只换了 epoch 的快照），聊天记录里有 serverRestored 系统消息；
//   3) 对局继续：P1 仍是回合菜单，掷骰推进，电脑接着打，P2 也能提交决策；两个页面的 HUD 与服务器快照一致；
//   4) 页面没有未捕获异常；console.error 只允许重启期间连不上服务器的网络报错。
// 只在 E2E_BASE_URL 与 E2E_RESTART_CMD 都设置时运行（E2E_RESTART_TIMEOUT_MS 可调命令超时，缺省 180 秒）。
// 重启命令本身失败（非 0 退出、超时被终止）时立即带着它的退出码与输出判失败，不先干等断线遮罩超时；
// 命令成功退出后 30 秒内页面仍没断线，也带着输出判失败（命令多半没有真的重启服务器）。
// 实例开着 RICH4_TEST_MODE=1 时先收走开局随机摆放（clearBoard）并让 P1 第一回合固定买下 L1；没开时全程正常掷骰
// （买地、升级一律确认，其余按默认），用例同样成立。
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { E2E_REMOTE } from '../fixtures/remote';
import {
  acted,
  answer,
  createRoom,
  currentSeq,
  debugAct,
  expect,
  expectNoErrors,
  hudSnapshot,
  joinRoom,
  latestViewJson,
  newPlayer,
  type Player,
  pickCharacter,
  roll,
  roomOf,
  serverSnapshot,
  setReady,
  syncPages,
  test,
  waitIdle,
  waitMyTurn,
  waitSeqAtLeast,
} from '../fixtures/room';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const RESTART_CMD = process.env.E2E_RESTART_CMD?.trim() || null;
const RESTART_TIMEOUT_MS = Number(process.env.E2E_RESTART_TIMEOUT_MS) || 180_000;
/** 重启后等页面恢复（重连退避上限 8 秒，另加服务器恢复房间的时间） */
const RECOVER_MS = 120_000;
/** 推进若干回合的上限（电脑回合按房间节奏播放演出） */
const DRIVE_MS = 240_000;
/** 重启命令成功退出之后，最多再等这么久让页面出现断线遮罩 */
const OVERLAY_AFTER_CMD_MS = 30_000;

/** 重启期间连不上服务器时浏览器打出的网络报错（socket.io 重连失败、反代 502/503/504），与应用无关 */
const RESTART_NOISE = [
  /WebSocket connection to '[^']*\/socket\.io\/[^']*' failed/,
  /Failed to load resource: net::ERR_(CONNECTION_REFUSED|CONNECTION_RESET|CONNECTION_CLOSED|EMPTY_RESPONSE)/,
  /Failed to load resource: the server responded with a status of 50[234]/,
];

test.skip(
  !E2E_REMOTE || !RESTART_CMD,
  '只对着已部署的实例跑：需要 E2E_BASE_URL 与 E2E_RESTART_CMD' +
    '（例如 E2E_RESTART_CMD="docker compose -f deploy/docker-compose.yml restart app"）',
);

interface CmdResult {
  code: number | null;
  signal: string | null;
  /** 输出尾部（stdout 与 stderr 合并） */
  output: string;
  ms: number;
}

/** 在仓库根目录用 shell 执行重启命令；超时则终止 */
function runRestart(cmd: string, timeoutMs: number): Promise<CmdResult> {
  return new Promise((done) => {
    const t0 = Date.now();
    let output = '';
    let settled = false;
    const finish = (code: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done({ code, signal, output, ms: Date.now() - t0 });
    };
    const child = spawn(cmd, { cwd: repoRoot, shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    const keep = (d: Buffer): void => {
      output = (output + d.toString('utf8')).slice(-8000);
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const timer = setTimeout(() => {
      output += `\n[e2e] 重启命令超过 ${timeoutMs}ms，终止`;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.on('error', (err) => {
      output += `\n[e2e] ${String(err)}`;
      finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}

interface RestartRecord {
  /** 连接状态的变化序列 */
  statuses: string[];
  /** 断线遮罩出现过 */
  overlay: boolean;
  /** 出现过的 toast 文本 */
  toasts: string[];
}

/** 在页面里记录此后的连接状态变化、断线遮罩与 toast（重启很快时遮罩与提示可能一闪而过，事后再断言） */
async function recordRestart(page: Page): Promise<void> {
  await page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const w = window as any;
    const h = w.__rich4;
    const rec = { statuses: [] as string[], overlay: false, toasts: [] as string[] };
    w.__restartRec = rec;
    h.store.connection.subscribe((s: { status: string }, prev: { status: string }) => {
      if (s.status !== prev.status) rec.statuses.push(s.status);
    });
    h.store.ui.subscribe((s: { toasts: { text: string }[] }, prev: { toasts: { text: string }[] }) => {
      for (const t of s.toasts) if (!prev.toasts.includes(t)) rec.toasts.push(t.text);
    });
    const seen = (): void => {
      if (document.querySelector('[data-testid="reconnect-overlay"]')) rec.overlay = true;
    };
    new MutationObserver(seen).observe(document.body, { childList: true, subtree: true });
  });
}

async function restartRecord(page: Page): Promise<RestartRecord> {
  // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
  return page.evaluate(() => (window as any).__restartRec as RestartRecord);
}

function describeCmd(r: CmdResult): string {
  return `E2E_RESTART_CMD 用时 ${r.ms}ms，exit ${r.code}，signal ${r.signal}，输出：\n${r.output}`;
}

/**
 * 等所有页面都出现断线遮罩，同时盯着后台的重启命令：命令先以非 0 退出（或超时被终止、根本起不来）时立即带着
 * 它的退出码与输出判失败；命令成功退出后 OVERLAY_AFTER_CMD_MS 内仍没断线，同样带着输出判失败。返回命令的结果。
 */
async function awaitRestart(pages: readonly Page[], restart: Promise<CmdResult>): Promise<CmdResult> {
  let done: { r: CmdResult; at: number } | null = null;
  void restart.then((r) => {
    done = { r, at: Date.now() };
  });
  for (;;) {
    const seen = await Promise.all(pages.map(async (p) => (await restartRecord(p)).overlay));
    if (seen.every(Boolean)) return restart;
    const d = done as { r: CmdResult; at: number } | null;
    if (d && d.r.code !== 0) throw new Error(`重启命令失败，页面没有断线。${describeCmd(d.r)}`);
    if (d && Date.now() - d.at > OVERLAY_AFTER_CMD_MS) {
      throw new Error(
        `重启命令已成功退出，但之后 ${OVERLAY_AFTER_CMD_MS / 1000} 秒内页面没有出现断线遮罩` +
          `（断线情况 ${JSON.stringify(seen)}；命令真的重启了服务器吗？）。${describeCmd(d.r)}`,
      );
    }
    await pages[0]!.waitForTimeout(250);
  }
}

async function epochOf(page: Page): Promise<number | null> {
  // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
  return page.evaluate(() => (window as any).__rich4.store.game.getState().epoch as number | null);
}

/** 本页轮到本人、可以操作的决策 kind（动画空闲、未在提交中）；没有则 null */
async function readyDecision(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const h = (window as any).__rich4;
    const g = h?.store?.game?.getState();
    return h?.eventPlayer.idle && g?.submitting === null ? (g.decision?.kind ?? null) : null;
  });
}

/** 用 debug:act 探测实例是否开着测试模式：顺带收走开局随机摆放；没注册时请求超时（5 秒），返回 false */
async function probeDebug(page: Page): Promise<boolean> {
  const s0 = await currentSeq(page);
  const r = await page.evaluate(
    () =>
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      (window as any).__rich4.client.transport.request(
        'debug:act',
        { op: { op: 'clearBoard' } },
        { timeoutMs: 5000 },
      ) as Promise<{ ok: boolean }>,
  );
  if (!r.ok) return false;
  await waitSeqAtLeast(page, s0 + 1);
  return true;
}

interface Seat {
  player: Player;
  seat: number;
  /** 已经掷过几次骰 */
  rolls: number;
}

/**
 * 处理本页当前的决策：回合菜单 → 掷骰（mayRoll 为假时不动；fixed 时先传送到 4 号格、强制 1 点，停到 5 号格 L1）；
 * 买地 / 升级 → 确认；其他 → 按默认。返回是否做了操作。
 */
async function step(s: Seat, mayRoll: boolean, fixed: boolean): Promise<boolean> {
  const page = s.player.page;
  const k = await readyDecision(page);
  if (!k) return false;
  if (k === 'TURN_MENU') {
    if (!mayRoll) return false;
    if (fixed) {
      await acted(page, () => debugAct(page, { op: 'teleport', seat: s.seat, node: 4, prev: 3 }));
      await acted(page, () => debugAct(page, { op: 'forceNext', purpose: 'dice', values: [1] }));
      await waitMyTurn(page);
    }
    await acted(page, () => roll(page));
    s.rolls++;
  } else {
    await acted(page, () => answer(page, 'confirm'));
  }
  await waitIdle(page);
  return true;
}

/**
 * 两个真人轮流应答，直到双方都掷满 rolls 次骰、且又轮到 P1 的回合菜单（此时服务器在等 P1，不限时的房间里状态静止）。
 * P2 的回合菜单总是掷骰（P1 被关押跳过回合时也不会卡住）；P1 掷满之后不再掷，停在回合菜单上。
 */
async function driveRounds(a: Seat, b: Seat, rolls: number, fixedFirst: boolean): Promise<void> {
  const until = Date.now() + DRIVE_MS;
  for (;;) {
    const bothDone = a.rolls >= rolls && b.rolls >= rolls;
    if (bothDone && (await readyDecision(a.player.page)) === 'TURN_MENU') return;
    if (Date.now() > until) {
      throw new Error(`推进回合超时：P1 掷骰 ${a.rolls} 次、P2 掷骰 ${b.rolls} 次，目标各 ${rolls} 次`);
    }
    const didA = await step(a, !bothDone, fixedFirst && a.rolls === 0);
    const didB = await step(b, true, false);
    if (!didA && !didB) await a.player.page.waitForTimeout(250);
  }
}

test('重启服务器：页面自动重连，同一房间对局继续，数值与重启前一致', async ({ browser }) => {
  test.setTimeout(600_000);
  const pa = await newPlayer(browser, 'R1');
  const pb = await newPlayer(browser, 'R2');
  const players = [pa, pb];
  const pages = players.map((p) => p.page);
  const [a, b] = pages as [Page, Page];
  try {
    // 2 个真人、2 个电脑补位（建房表单把电脑放在 1、2 号座位），P2 坐剩下的 3 号
    const code = await createRoom(a, { map: 'test', timer: 'off', aiCount: 2, pacing: 'compact' });
    const r = await a.evaluate(
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      () => (window as any).__rich4.client.updateSettings({ reconnectGraceSec: 120 }) as Promise<{ ok: boolean }>,
    );
    expect(r.ok).toBe(true);
    await joinRoom(b, code);
    await pickCharacter(a, 9);
    await pickCharacter(b, 4);
    await setReady(b);
    await expect(a.getByTestId('room-start')).toBeEnabled();
    await a.getByTestId('room-start').click();
    for (const p of pages) {
      await expect(p.getByTestId('screen-game')).toBeVisible();
      await waitIdle(p);
    }
    const seatA = (await roomOf(a))?.you.seat;
    const seatB = (await roomOf(b))?.you.seat;
    expect(seatA).toBe(0);
    expect(typeof seatB).toBe('number');
    const debug = await probeDebug(a);
    test.info().annotations.push({ type: 'debug:act', description: debug ? '可用（测试模式）' : '不可用，正常掷骰' });
    const sa: Seat = { player: pa, seat: seatA!, rolls: 0 };
    const sb: Seat = { player: pb, seat: seatB!, rolls: 0 };

    // 两个真人各走两回合，停在 P1 的第三个回合菜单
    await driveRounds(sa, sb, 2, debug);
    await syncPages(pages);
    const before = {
      epoch: await epochOf(a),
      seq: await currentSeq(a),
      views: await Promise.all(pages.map((p) => latestViewJson(p))),
      huds: await Promise.all(pages.map((p) => hudSnapshot(p))),
      server: await serverSnapshot(a),
    };
    expect(before.epoch).not.toBeNull();
    expect(await epochOf(b)).toBe(before.epoch);
    expect(before.huds[1]).toEqual(before.huds[0]);
    expect(before.huds[0]).toEqual(before.server);
    // P1 第一回合固定买下 L1，之后可能经卡片、拍卖等易手（曾偶发见到归 P2）：只要求盘面上确有地产归属，
    // 保证重启前后比对的不是空盘
    if (debug) expect(Object.values(before.server.lots).some((l) => l.owner !== '')).toBe(true);

    // 重启：命令在后台跑，页面上应当先出现断线遮罩（命令先失败时立即判失败，见 awaitRestart）
    for (const p of pages) await recordRestart(p);
    const res = await awaitRestart(pages, runRestart(RESTART_CMD!, RESTART_TIMEOUT_MS));
    test.info().annotations.push({ type: 'restart', description: `${res.ms}ms exit=${res.code}` });
    expect(res.code, describeCmd(res)).toBe(0);

    // 自动恢复：遮罩消失、拿到新 epoch 的快照、房间回到 playing（房间丢了——room:resume 得到 ROOM_NOT_FOUND、
    // 页面回到首页——立即判失败，不干等超时）
    for (const p of pages) {
      await expect(p.getByTestId('reconnect-overlay')).toHaveCount(0, { timeout: RECOVER_MS });
      const outcome = await p.waitForFunction(
        (e) => {
          // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
          const h = (window as any).__rich4;
          if (h.store.room.getState().room === null) return 'roomLost';
          return h.store.game.getState().epoch > e && h.eventPlayer.idle ? 'resumed' : null;
        },
        before.epoch!,
        { timeout: RECOVER_MS },
      );
      expect(await outcome.jsonValue(), '重启后房间还在（没有被送回首页）').toBe('resumed');
      await expect.poll(async () => (await roomOf(p))?.phase, { timeout: RECOVER_MS }).toBe('playing');
    }
    for (const [i, p] of pages.entries()) {
      const rec = await restartRecord(p);
      expect(rec.statuses, `${players[i]!.nickname} 连接状态`).toContain('reconnecting');
      expect(rec.statuses.at(-1)).toBe('open');
      // 原版皮肤下是繁体：已重新连接 / 已重新連線
      const restored = rec.toasts.some((t) => /已重新(连接|連線)/.test(t));
      expect(restored, JSON.stringify(rec.toasts)).toBe(true);
      // 同一房间、同一座位
      expect(new URL(p.url()).pathname).toBe(`/r/${code}`);
      const room = await roomOf(p);
      expect(room?.code).toBe(code);
      expect(room?.you).toMatchObject({ role: 'player', seat: [seatA, seatB][i] });
      // epoch 加 1、seq 不变，数值与重启前一致
      expect(await epochOf(p)).toBe(before.epoch! + 1);
      expect(await currentSeq(p)).toBe(before.seq);
      expect(await latestViewJson(p)).toBe(before.views[i]);
      expect(await hudSnapshot(p)).toEqual(before.huds[i]);
      await expect
        .poll(() =>
          p.evaluate(() =>
            // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
            ((window as any).__rich4.store.chat.getState().messages as { system?: { key: string } }[]).some(
              (m) => m.system?.key === 'serverRestored',
            ),
          ),
        )
        .toBe(true);
    }
    expect(await serverSnapshot(a)).toEqual(before.server);

    // 对局继续：P1 仍是回合菜单，两个真人再各走一回合（电脑在中间接着打）
    await waitMyTurn(a, RECOVER_MS);
    await driveRounds(sa, sb, 3, false);
    const seq = await syncPages(pages);
    expect(seq).toBeGreaterThan(before.seq);
    for (const p of pages) expect(await epochOf(p)).toBe(before.epoch! + 1);
    const huds = await Promise.all(pages.map((p) => hudSnapshot(p)));
    expect(huds[1]).toEqual(huds[0]);
    expect(huds[0]).toEqual(await serverSnapshot(a));

    // 未捕获异常一条都不许有；console.error 只放过重启期间的网络报错
    for (const p of players) {
      const uncaught = p.errors.filter((e) => e.startsWith('pageerror:'));
      expect(uncaught, p.nickname).toEqual([]);
    }
    expectNoErrors(players, RESTART_NOISE);
  } finally {
    for (const p of players) await p.context.close();
  }
});
