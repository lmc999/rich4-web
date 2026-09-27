// w2 审查修正：在开发服（test/w2-dev.sh）上开局后给 0 号挂炸弹、2 号冬眠，打印棋子的名牌 / 引信 / ZZZ 节点状态
import { chromium } from '@playwright/test';

const BASE = process.env.W2_BASE ?? 'http://localhost:5417';
const PASS = process.env.W2_PASS ?? 'w2-pass-4417';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await ctx.request.post(`${BASE}/api/access`, { data: { passcode: PASS } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/?audio=off`);
  await page.getByTestId('home-nickname').fill('測試者');
  await page.getByTestId('home-create').click();
  await page.getByTestId('set-map').selectOption('taiwan');
  await page.getByTestId('set-timer').selectOption('off');
  await page.getByTestId('set-ai-count').selectOption('3');
  await page.getByTestId('create-submit').click();
  await page.waitForURL(/\/r\/\d{6}/);
  await page.getByTestId('char-9').click();
  await page.getByTestId('char-select').click();
  await page.getByTestId('room-start').click();
  await page.getByTestId('classic-stage').waitFor();
  await page.waitForFunction(() => {
    const g = window.__rich4?.store?.game?.getState();
    return !!g && window.__rich4.eventPlayer.idle && g.decision?.kind === 'TURN_MENU';
  }, undefined, { timeout: 120_000 });
  await page.waitForTimeout(1500);
  const out = await page.evaluate(async () => {
    const r = window.__rich4.renderer;
    const a0 = r.board.actor(0);
    await r.assets.sheet('object.bomb');
    a0.setStatus({ ...a0.currentStatus, bomb: 7 });
    await new Promise((res) => setTimeout(res, 300));
    const lbl = (c) => c.label;
    const fuse = a0.root.getChildByLabel('fuse');
    const tag = a0.root.getChildByLabel('tag');
    const body = a0.root.getChildByLabel('body');
    const bomb = body.getChildByLabel('bomb', true);
    const b = (n) => (n ? (({ x, y, width, height }) => ({ x, y, width, height }))(n.getBounds()) : null);
    return {
      kids: a0.root.children.map(lbl),
      visible: [a0.root.visible, body.visible, fuse?.visible, bomb?.visible],
      fusePos: fuse && [fuse.position.x, fuse.position.y, fuse.text],
      bombPos: bomb && [bomb.position.x, bomb.position.y, bomb.texture.frame.width, bomb.texture.frame.height],
      bounds: { fuse: b(fuse), tag: b(tag), bomb: b(bomb) },
      status: a0.currentStatus.bomb,
    };
  });
  console.log(JSON.stringify(out, null, 1));
  await ctx.close();
} finally {
  await browser.close();
}
