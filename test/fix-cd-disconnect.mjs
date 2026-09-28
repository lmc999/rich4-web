// 调试（复审修复第 5 条）：断线时中央倒计时要立即消失、不再响提示音。原版皮肤 + 真实素材包 + 台湾图、计时 fast。
// 轮到本人的回合菜单剩约 12.5 秒时停掉本机服务器（找监听 3801 端口的进程 kill），12 秒后读测试钩子与画面：
// 连接状态、倒计时元素、断线后新增的提示音请求与音频引擎放出的 countdown 音效、重连遮罩文字；截图写到 .cache/pc/fix/disconnect/。
// 先按 test/fix-cd-shots.mjs 的说明起 3801 / 5801 两个服务；跑完服务器已被停掉，需要重新起。
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.FIX_BASE ?? 'http://localhost:5801';
const PORT = process.env.FIX_PORT ?? '3801';
const OUT = '.cache/pc/fix/disconnect';
mkdirSync(OUT, { recursive: true });
const LOG = [];
const log = (s) => {
  const line = `[${new Date().toISOString().slice(11, 23)}] ${s}`;
  console.log(line);
  LOG.push(line);
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
await ctx.addInitScript(() => localStorage.setItem('rich4.introSeen', '1'));
const pa = await ctx.newPage();
const errors = [];
pa.on('pageerror', (e) => errors.push(e.message));

await pa.goto(`${BASE}/?test=1`);
await pa.getByTestId('home-nickname').fill('測試甲');
await pa.getByTestId('home-nickname').blur();
await pa.getByTestId('home-create').click();
await pa.getByTestId('set-map').selectOption('taiwan');
await pa.getByTestId('set-timer').selectOption('fast');
await pa.getByTestId('set-pacing').selectOption('compact');
await pa.getByTestId('set-ai-count').selectOption('1');
await pa.getByTestId('create-submit').click();
await pa.waitForURL(/\/r\/\d{6}/);
await pa.getByTestId('char-2').click();
await pa.getByTestId('room-start').click();
await pa.getByTestId('screen-game').waitFor({ timeout: 60_000 });
// 点一下舞台解锁音频
await pa.mouse.click(960, 540);

const snap = () =>
  pa.evaluate(() => {
    const h = window.__rich4;
    const g = h.store.game.getState();
    const d = g.decision;
    const off = h.store.connection.getState().clockOffsetMs ?? 0;
    const cd = document.querySelector('[data-testid="decision-countdown"]');
    return {
      status: h.store.connection.getState().status,
      decision: d ? { kind: d.kind, id: d.decisionId, left: d.deadlineAt ? d.deadlineAt - (Date.now() + off) : null } : null,
      submitting: g.submitting,
      idle: h.eventPlayer?.idle ?? false,
      countdown: cd ? { secs: cd.getAttribute('data-secs'), urgent: cd.getAttribute('data-urgent') } : null,
      beeps: (h.countdown?.beeps ?? []).map((b) => `${b.secs}:${b.level}`),
      sfx: (h.audio?.log ?? [])
        .filter((e) => e.kind === 'sfx' && e.key?.startsWith('zzfx.countdown'))
        .map((e) => `${e.op}:${e.key}`),
      overlay: document.querySelector('[data-testid="reconnect-overlay"]')?.textContent ?? null,
    };
  });

// 等本人的回合菜单
for (let i = 0; i < 600; i++) {
  const s = await snap();
  if (s.idle && s.decision?.kind === 'TURN_MENU' && s.submitting === null && s.decision.left !== null) break;
  await pa.waitForTimeout(200);
}
for (;;) {
  const s = await snap();
  if (s.decision?.left !== null && s.decision.left <= 12_500) break;
  await pa.waitForTimeout(100);
}
const before = await snap();
log(`before kill: ${JSON.stringify(before)}`);
await pa.screenshot({ path: `${OUT}/01-before.png` });
const pids = execSync(`lsof -tiTCP:${PORT} -sTCP:LISTEN || true`).toString().trim().split(/\s+/).filter(Boolean);
log(`kill server pids ${pids.join(',')}`);
for (const p of pids) process.kill(Number(p), 'SIGKILL');
await pa.waitForTimeout(1500);
const at1 = await snap();
log(`+1.5s: ${JSON.stringify(at1)}`);
await pa.waitForTimeout(10_500);
const after = await snap();
log(`+12s: ${JSON.stringify(after)}`);
await pa.screenshot({ path: `${OUT}/02-disconnected.png` });
const newBeeps = after.beeps.slice(before.beeps.length);
const newSfx = after.sfx.slice(before.sfx.length);
const result = {
  statusAfter: after.status,
  countdownAfter: after.countdown,
  countdownAt1_5s: at1.countdown,
  beepsBefore: before.beeps,
  beepsAfterKill: newBeeps,
  sfxAfterKill: newSfx,
  overlay: after.overlay,
  errors,
};
log(`result: ${JSON.stringify(result)}`);
writeFileSync(`${OUT}/result.json`, `${JSON.stringify(result, null, 2)}\n`);
writeFileSync(`${OUT}/log.txt`, `${LOG.join('\n')}\n`);
await browser.close();
