// 调试（浏览器面板里执行）：在对局页上叠一块独立的原版棋盘（880×880，缩放 2 = 440 源像素），
// 按 .cache/assets-preview/board/*.png 的镜头（台北、中部、绿岛）与摆放规则（住宅按序 1–5 级、设施旅馆 2 级、若干角色）
// 渲染，便于并排目视对照。用法：把本文件内容交给 javascript_tool，然后调用 window.__w2show(view, name)。
(async () => {
  const { createOrigBoard } = await import('/src/game/orig/createOrigBoard.ts');
  const { packClient } = await import('/src/skin/skinStore.ts');
  const { AnimClock } = await import('/src/game/anim/AnimClock.ts');
  const client = await packClient();
  const entries = window.__rich4.store.map.getState().entries;
  const def = Object.values(entries).find((e) => e.def?.id === 'taiwan').def;
  window.__w2board?.surface.destroy();
  document.getElementById('w2-host')?.remove();
  const host = document.createElement('div');
  host.id = 'w2-host';
  host.style.cssText = 'position:fixed;left:0;top:0;width:880px;height:880px;z-index:100000;background:#000';
  document.body.appendChild(host);
  const clock = new AnimClock();
  const created = await createOrigBoard(
    {
      host,
      clock,
      quality: 'low',
      def,
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
      controller: { nameOf: (s) => `P${s + 1}`, autoFollow: () => false },
    },
    client,
  );
  const r = created.surface;
  const colors = [0xff0000, 0x00c000, 0x2060ff, 0xffd000];
  r.owners = { character: (s) => s, color: (s) => colors[s % 4] };
  let i = 0;
  for (const l of def.lots) {
    const k = i++;
    if (l.kind === 'facility') r.boardView.setLot(l.id, { owner: k % 4, level: 2, facility: 'hotel' });
    else r.boardView.setLot(l.id, { owner: k % 4, level: (k % 5) + 1 });
  }
  const tiles = new Map(def.tiles.map((t) => [t.id, t]));
  def.tiles
    .slice(0, 40)
    .filter((_, j) => j % 5 === 0)
    .forEach((t, j) => {
      const next = tiles.get(t.links[0]?.to ?? t.id) ?? t;
      const a = r.addActor(10 + j, j % 12, '', t.id, 0xffffff);
      a.root.visible = true;
      const dx = next.world.x - t.world.x;
      const dy = next.world.y - t.world.y;
      const ang = Math.round((Math.atan2(-dy, dx) / Math.PI) * 4) & 7;
      a.setFacing([2, 3, 4, 5, 6, 7, 0, 1][ang]);
    });
  const cams = { center: { x: 1203, y: 578 }, taipei: { x: 1463, y: 239 }, greenisland: tiles.get(1).world };
  window.__w2board = created;
  window.__w2show = (view, name) => {
    r.setView(view);
    r.camera.setZoom(2);
    r.camera.lookAt(r.proj.project(cams[name]));
    for (let k = 0; k < 30; k++) clock.advance(16);
    return { view: r.rotation, zoom: r.camera.zoom, center: r.camera.center };
  };
  return 'ready';
})();
