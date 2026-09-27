// 存档读档（design/client.md §12.2 用例 7；architecture M5 验证 2–3；net.md §8.3–8.4）：
// 1) 4 名玩家走完一轮（P1、P3 各买一块地）后，轮到 P1 时房主命名存档；记下 4 个页面的 HUD 与权威 view；
// 2) 其他人离开房间，房主解散房间（对局中解散会先自动存档）——原房间还在对局时服务器禁止另开房间读同一存档；
// 3) 房主新建房间：导出 .r4save（下载）→ 再导入同一文件（仍是官方存档）→ 导入篡改过的文件（标「非官方存档」）；
//    读取篡改存档时大厅横幅也标「非官方存档」；再改读导入的官方存档；
// 4) P2 以玩家身份进房自动回到原座位；P3 以观战身份进房后认领原座位；P4 没来，房主补电脑；
// 5) 开局后 P1..P3 的 HUD 数值与权威 view 与存档前完全一致（状态没有被改动）。
import { readFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Page } from '@playwright/test';
import {
  createRoom,
  expect,
  expectNoErrors,
  type HudSnapshot,
  hudSnapshot,
  joinRoom,
  latestViewJson,
  openMenu,
  pickReadyStart,
  playTurn,
  setReady,
  syncPages,
  test,
  waitIdle,
  waitMyTurn,
} from '../fixtures/room';

const SAVE_NAME = 'E2E 第二轮';
const TAMPERED_NAME = '被改过的存档';

/** 篡改导出文本：解开 gzip(JSON) 改掉存档名再压回去，签名段保持原样（于是验签失败） */
function tamper(text: string): string {
  const [prefix, payload, sig] = text.trim().split('.');
  const json = JSON.parse(gunzipSync(Buffer.from(payload!, 'base64url')).toString('utf8')) as { name: string };
  json.name = TAMPERED_NAME;
  const blob = gzipSync(Buffer.from(JSON.stringify(json), 'utf8'));
  return `${prefix}.${blob.toString('base64url')}.${sig}`;
}

/** 存档列表里名字为 name 的条目 id（按列表顺序，新的在前） */
async function saveIds(page: Page, name: string): Promise<string[]> {
  return page
    .locator(`[data-testid="save-list"] > li[data-name="${name}"]`)
    .evaluateAll((els) => els.map((e) => (e.getAttribute('data-testid') ?? '').slice('save-'.length)));
}

async function importText(page: Page, filename: string, text: string): Promise<void> {
  await page.getByTestId('save-import-file').setInputFiles({
    name: filename,
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(text, 'utf8'),
  });
}

test('存档 → 全员离开 → 新房间读档认领座位 → 状态一致；导出、导入与篡改文件', async ({ fourPlayers }) => {
  test.setTimeout(300_000);
  const pages = fourPlayers.map((p) => p.page);
  const [a, b, c, d] = pages as [Page, Page, Page, Page];
  const code = await createRoom(a, { map: 'test', timer: 'off' });
  for (const p of [b, c, d]) await joinRoom(p, code);
  await pickReadyStart(pages);

  // 第 1 轮：P1 买 L1、P3 买 L4，P2、P4 付过路费
  await playTurn(a, 0, { node: 4, prev: 3, choice: 'confirm' });
  await playTurn(b, 1, { node: 4, prev: 3 });
  await playTurn(c, 2, { node: 10, prev: 9, choice: 'confirm' });
  await playTurn(d, 3, { node: 10, prev: 9 });
  await waitMyTurn(a);
  await syncPages(pages, a);
  const beforeHud: HudSnapshot[] = await Promise.all(pages.map((p) => hudSnapshot(p)));
  const beforeView: string[] = await Promise.all(pages.map((p) => latestViewJson(p)));
  // 开局路上随机摆着神明（M6）：落点附近的天使 / 土地公显灵可能改等级，这里只断言归属；读档前后的完全一致见下文
  expect(beforeHud[0]!.lots.L1?.owner).toBe('0');
  expect(beforeHud[0]!.lots.L4?.owner).toBe('2');

  // 房主存档（系统菜单）
  await openMenu(a);
  await a.getByTestId('save-name').fill(SAVE_NAME);
  await a.getByTestId('save-submit').click();
  await expect(a.getByTestId('toast').filter({ hasText: '已存档' }).first()).toBeVisible();
  await expect(a.locator(`[data-testid="save-list"] > li[data-name="${SAVE_NAME}"]`)).toHaveCount(1);
  const [savedId] = await saveIds(a, SAVE_NAME);
  expect(savedId).toBeTruthy();
  // 非房主看得到列表但不能存档
  await openMenu(b);
  await expect(b.getByTestId('save-name')).toHaveCount(0);
  await expect(b.locator(`[data-testid="save-list"] > li[data-name="${SAVE_NAME}"]`)).toHaveCount(1);
  await b.keyboard.press('Escape');
  await a.keyboard.press('Escape');

  // 全员离开：P2..P4 离开房间，房主解散（原房间还在对局时不能另开房间读这个存档）
  for (const p of [b, c, d]) {
    await openMenu(p);
    await p.getByTestId('menu-leave').click();
    await expect(p.getByTestId('screen-home')).toBeVisible();
  }
  // P2 也是存档的 owner：原房间还在对局时另开房间读它被拒（SAVE_FORBIDDEN{gameInProgress}），随后解散这个临时房间
  await createRoom(b, { map: 'test', timer: 'off' });
  await b.getByTestId('lobby-saves-toggle').click();
  await b.getByTestId(`save-load-${savedId}`).click();
  await expect(
    b.getByTestId('toast').filter({ hasText: '这个存档所在的对局还在进行中，请先结束或解散那个房间' }),
  ).toBeVisible();
  await expect(b.getByTestId('loaded-save')).toHaveCount(0);
  await b.getByTestId('room-dissolve').click();
  await expect(b.getByTestId('screen-home')).toBeVisible();
  await openMenu(a);
  await a.getByTestId('menu-dissolve').click();
  await a.getByTestId('menu-dissolve-confirm').click();
  await expect(a.getByTestId('screen-home')).toBeVisible();

  // 房主新建房间，打开存档面板
  const code2 = await createRoom(a, { map: 'test', timer: 'off' });
  expect(code2).not.toBe(code);
  await a.getByTestId('lobby-saves-toggle').click();
  await expect(a.getByTestId(`save-${savedId}`)).toBeVisible();

  // 导出 → 下载的 .r4save
  const [download] = await Promise.all([a.waitForEvent('download'), a.getByTestId(`save-export-${savedId}`).click()]);
  expect(download.suggestedFilename()).toMatch(/\.r4save$/);
  const path = await download.path();
  const text = readFileSync(path, 'utf8');
  expect(text.startsWith('R4S1.')).toBe(true);

  // 导入同一文件：新条目，仍是官方存档
  await importText(a, download.suggestedFilename(), text);
  await expect(a.getByTestId('toast').filter({ hasText: `已导入存档「${SAVE_NAME}」` })).toBeVisible();
  await expect(a.locator(`[data-testid="save-list"] > li[data-name="${SAVE_NAME}"]`)).toHaveCount(2);
  const importedId = (await saveIds(a, SAVE_NAME)).find((id) => id !== savedId)!;
  expect(importedId).toBeTruthy();
  await expect(a.getByTestId(`save-${importedId}`)).toHaveAttribute('data-verified', 'true');
  await expect(a.getByTestId(`save-unofficial-${importedId}`)).toHaveCount(0);

  // 导入篡改过的文件：可以导入，但标「非官方存档」
  await importText(a, 'tampered.r4save', tamper(text));
  await expect(a.getByTestId('toast').filter({ hasText: '非官方存档' })).toBeVisible();
  const [tamperedId] = await saveIds(a, TAMPERED_NAME);
  expect(tamperedId).toBeTruthy();
  await expect(a.getByTestId(`save-unofficial-${tamperedId}`)).toHaveText('非官方存档');

  // 读篡改存档：大厅横幅也标「非官方存档」
  await a.getByTestId(`save-load-${tamperedId}`).click();
  await expect(a.getByTestId('loaded-save')).toContainText(TAMPERED_NAME);
  await expect(a.getByTestId('loaded-unofficial')).toHaveText('非官方存档');

  // 改读导入的官方存档
  await a.getByTestId('lobby-saves-toggle').click();
  await a.getByTestId(`save-load-${importedId}`).click();
  await expect(a.getByTestId('loaded-save')).toContainText(SAVE_NAME);
  await expect(a.getByTestId('loaded-unofficial')).toHaveCount(0);
  // 房主自动回到 1P；其余座位显示「原：角色 / 昵称，待认领」
  await expect(a.getByTestId('seat-0')).toHaveAttribute('data-kind', 'human');
  await expect(a.getByTestId('seat-1-origin')).toHaveText('原：阿土伯 / P2');
  await expect(a.getByTestId('seat-1-unclaimed')).toHaveText('待认领');
  await expect(a.getByTestId('room-start')).toBeDisabled();

  // P2 以玩家身份进房：凭 token 自动回到原座位
  await joinRoom(b, code2);
  await expect(a.getByTestId('seat-1')).toHaveAttribute('data-saved', 'claimed');
  await expect(b.getByTestId('seat-1-name')).toHaveText('P2');
  // P3 以观战身份进房，再认领原座位
  await joinRoom(c, code2, true);
  await expect(c.getByTestId('seat-2-claim')).toBeVisible();
  await c.getByTestId('seat-2-claim').click();
  await expect(c.getByTestId('seat-2-name')).toHaveText('P3');
  // P4 没来：房主给 4P 补电脑
  await expect(a.getByTestId('start-hint')).toContainText('4P');
  await a.getByTestId('seat-3-add-ai').click();
  await expect(a.getByTestId('seat-3')).toHaveAttribute('data-kind', 'ai');
  await setReady(b);
  await setReady(c);
  await expect(a.getByTestId('room-start')).toBeEnabled();
  await a.getByTestId('room-start').click();
  const back = [a, b, c];
  for (const p of back) {
    await expect(p.getByTestId('screen-game')).toBeVisible();
    await waitIdle(p);
  }

  // 状态与存档前一致：HUD 数值、权威 view（按各自座位投影）逐字相等
  for (let i = 0; i < back.length; i++) {
    expect(await hudSnapshot(back[i]!), `P${i + 1} HUD`).toEqual(beforeHud[i]);
    expect(await latestViewJson(back[i]!), `P${i + 1} view`).toBe(beforeView[i]);
  }
  // 读档后仍然轮到 P1
  await waitMyTurn(a);

  expectNoErrors(fourPlayers);
});
