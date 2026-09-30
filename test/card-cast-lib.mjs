// 调研（出卡插画，只读）：test/card-drive.mjs 的出卡助手——在 P1 页经卡片欄 → 目标面板 → YES 出卡，
// 同时在 P1 / P2 两页采样出卡弹窗（data-card、原版 / 程序化、插画素材键、位置、透明度），按时间点截图。
// 用法（在 card-drive 的脚本里）：const { castViaUi } = await import('./card-cast-lib.mjs'); await castViaUi(H, slot, tag)

/** 等某页出现出卡弹窗，按 at（ms，从出现起算）截图并采样；返回采样表 */
export async function sampleCast(H, page, who, tag, { timeout = 15_000, at = [80, 350, 800] } = {}) {
  const { probeCard, shot } = H;
  const t0 = Date.now();
  const samples = [];
  let seenAt = null;
  const shots = [];
  let i = 0;
  while (Date.now() - t0 < timeout) {
    const p = await probeCard(page);
    const now = Date.now();
    if (p.cast || p.popup) {
      if (seenAt === null) seenAt = now;
      samples.push({ t: now - seenAt, ...p });
      if (i < at.length && now - seenAt >= at[i]) {
        shots.push(await shot(page, `${tag}-${who}-t${at[i]}`));
        i++;
      }
    } else if (seenAt !== null) {
      samples.push({ t: now - seenAt, gone: true });
      break;
    }
    await page.waitForTimeout(40);
  }
  return { who, seen: seenAt !== null, samples, shots };
}

/** 把采样压成一行：弹窗种类、原版与否、data-card、插画素材键、插画矩形 */
export function summarize(s) {
  if (!s.seen) return { who: s.who, seen: false };
  const withCast = s.samples.filter((x) => x.cast);
  const first = withCast[0] ?? s.samples[0];
  const keys = [...new Set(withCast.map((x) => x.castArt?.bgKey ?? (x.cast?.classic ? 'NO-BG' : 'procedural')))];
  const last = s.samples.filter((x) => !x.gone).at(-1);
  return {
    who: s.who,
    seen: true,
    popupKind: first?.popup?.kind ?? null,
    classic: first?.popup?.classic ?? null,
    dataCard: first?.cast?.dataCard ?? null,
    variant: first?.cast?.variant ?? null,
    artKeys: keys,
    artRect: withCast.find((x) => x.castArt)?.castArt?.rect ?? null,
    procIcon: first?.cast?.procIcon ?? null,
    text: first?.cast?.text ?? null,
    durationMs: last?.t ?? null,
    shots: s.shots,
  };
}

/** P1 经卡片欄出一张卡；pickTarget(page) 负责在目标面板里把目标选完（缺省点第一个候选） */
export async function castViaUi(H, slot, tag, { pickTarget = null, sampleB = true } = {}) {
  const { A, B, shot, log, decisionFull } = H;
  const d = await decisionFull(A);
  const row = d.options.cards.find((r) => r.slot === slot);
  if (!row) throw new Error(`slot ${slot} 不在卡片欄`);
  if (!(await A.getByTestId('turn-inventory').isVisible().catch(() => false))) {
    await A.getByTestId('action-cards').click();
    await A.getByTestId('turn-inventory').waitFor();
  }
  await A.getByTestId(`inv-card-${slot}`).click();
  const picker = A.getByTestId('target-picker');
  await picker.waitFor({ timeout: 5000 });
  await A.waitForTimeout(300);
  const tp = await A.evaluate(() => {
    const el = document.querySelector('[data-testid="target-picker"]');
    return {
      kind: el?.getAttribute('data-target-kind') ?? null,
      cursor: document.querySelector('[data-testid="classic-board-slot"]')?.getAttribute('data-classic-cursor') ?? null,
      arts: [...document.querySelectorAll('[data-testid$="card-art"]')].map((a) => a.getAttribute('data-testid')),
      text: el?.textContent?.slice(0, 160) ?? null,
    };
  });
  const tpShot = await shot(A, `${tag}-target-panel`);
  if (pickTarget) await pickTarget(A);
  else {
    // 缺省：依次点目标面板里第一个没按下的候选，直到 YES 可用（最多 4 次）
    for (let k = 0; k < 4; k++) {
      if (await A.getByTestId('target-confirm').isEnabled()) break;
      const btn = picker.locator('button[aria-pressed="false"]:not([disabled])').first();
      if ((await btn.count()) === 0) break;
      await btn.click();
      await A.waitForTimeout(150);
    }
  }
  await shot(A, `${tag}-target-picked`);
  if (!(await A.getByTestId('target-confirm').isEnabled())) {
    log(`${tag}: target-confirm 不可用，取消`);
    await A.getByTestId('target-cancel').click().catch(() => {});
    return { tag, slot, card: row.card, targetPanel: tp, cast: null };
  }
  await A.getByTestId('target-confirm').click();
  const [sa, sb] = await Promise.all([
    sampleCast(H, A, H.actorName ?? 'P1', tag),
    sampleB
      ? sampleCast(H, B, H.watcherName ?? 'P2', tag)
      : Promise.resolve({ who: H.watcherName ?? 'P2', seen: false, samples: [], shots: [] }),
  ]);
  // actor = 出卡人页，watcher = 另一名真人页
  const res = { tag, slot, card: row.card, targetPanel: { ...tp, shot: tpShot }, actor: summarize(sa), watcher: summarize(sb), raw: { actor: sa.samples, watcher: sb.samples } };
  log(`${tag} card=${row.card}`, JSON.stringify({ actor: res.actor, watcher: res.watcher }));
  return res;
}

/**
 * 在一段时间里同时盯住两页：每出现一次出卡弹窗（按 popup 节点 + data-card + variant 区分）就在出现后约 350ms 截图并记下现场；
 * tick(i) 每轮调用一次（用来按默认应答推进对局）。until() 返回 true 时提前结束。
 */
export async function watchCasts(H, ms, { tick = null, until = null, tag = 'watch' } = {}) {
  const { A, B, probeCard, shot, log } = H;
  const pages = [
    ['P1', A],
    ['P2', B],
  ];
  const seen = [];
  const live = new Map();
  const t0 = Date.now();
  let i = 0;
  while (Date.now() - t0 < ms) {
    for (const [who, page] of pages) {
      const p = await probeCard(page).catch(() => null);
      const key = p?.cast ? `${p.cast.dataCard}/${p.cast.variant}/${p.cast.text}` : null;
      const cur = live.get(who);
      if (key && (!cur || cur.key !== key)) {
        const rec = { who, key, t: Date.now() - t0, first: p, shots: [], snapped: false, since: Date.now() };
        live.set(who, rec);
        seen.push(rec);
        log(`${tag} ${who} 出卡弹窗 card=${p.cast.dataCard} variant=${p.cast.variant} art=${p.castArt?.bgKey ?? 'none'} text=${p.cast.text.slice(0, 80)}`);
      } else if (!key && cur) live.delete(who);
      const rec = live.get(who);
      if (rec && !rec.snapped && Date.now() - rec.since >= 350) {
        rec.snapped = true;
        rec.mid = await probeCard(page).catch(() => null);
        rec.shots.push(await shot(page, `${tag}-card${rec.first.cast.dataCard}-${rec.first.cast.variant}-${who}`));
      }
    }
    if (tick) await tick(i++);
    if (until && (await until())) break;
    await A.waitForTimeout(60);
  }
  return seen.map((r) => ({
    who: r.who,
    t: r.t,
    card: r.first.cast.dataCard,
    variant: r.first.cast.variant,
    classic: r.first.cast.classic,
    popupClassic: r.first.popup?.classic ?? null,
    artKey: r.mid?.castArt?.bgKey ?? r.first.castArt?.bgKey ?? null,
    artRect: r.mid?.castArt?.rect ?? null,
    procIcon: r.first.cast.procIcon,
    text: r.first.cast.text,
    shots: r.shots,
  }));
}

/** P1 经卡片欄对某座位出卡（只点，不采样）：返回目标面板截图 */
export async function clickCast(H, page, card, pick) {
  const { shot, decisionFull } = H;
  const d = await decisionFull(page);
  const row = d.options.cards.find((r) => r.card === card && r.usable);
  if (!row) throw new Error(`card ${card} 不可用：${JSON.stringify(d.options.cards.filter((r) => r.card === card))}`);
  if (!(await page.getByTestId('turn-inventory').isVisible().catch(() => false))) {
    await page.getByTestId('action-cards').click();
    await page.getByTestId('turn-inventory').waitFor();
  }
  await page.getByTestId(`inv-card-${row.slot}`).click();
  await page.getByTestId('target-picker').waitFor({ timeout: 5000 });
  await pick(page);
  const f = await shot(page, `card${card}-target-picked`);
  await page.getByTestId('target-confirm').click();
  return f;
}

/** 被动卡决策（免费 / 嫁祸）在受害者页上的原版场景：截图 + 读插画 */
export async function probePassiveScene(H, page, who, tag) {
  const { probeCard, shot, decisionFull } = H;
  await page.waitForTimeout(700);
  const d = await decisionFull(page);
  const p = await probeCard(page);
  const scene = await page.evaluate(() => {
    const el = document.querySelector('[data-scene]');
    return el ? { scene: el.getAttribute('data-scene'), testid: el.getAttribute('data-testid') } : null;
  });
  const f = await shot(page, `${tag}-${d?.kind}-${who}`);
  return { who, kind: d?.kind ?? null, scene, arts: p.arts, shot: f };
}
