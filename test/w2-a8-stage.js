// 调试（浏览器面板里执行，A8 原版舞台目视）：在首页上叠一块独立的原版棋盘（880×880，缩放 2 = 440 源像素），
// 真实素材包 + 台湾图，手动推进动画时钟逐段目视原版 FLIC 与原版精灵演出（神明降临、救护车、飞弹、定时炸弹、恶人行走）。
// 用法：把本文件内容交给 javascript_tool，然后调用 window.__a8.scene(name) 与 window.__a8.step(ms)。
(async () => {
  const { createOrigBoard } = await import('/src/game/orig/createOrigBoard.ts');
  const { packClient } = await import('/src/skin/skinStore.ts');
  const { AnimClock } = await import('/src/game/anim/AnimClock.ts');
  const { useMapStore } = await import('/src/store/mapStore.ts');
  const { budgetMs } = await import('/src/presentation/handlers/budget.ts');
  const client = await packClient();
  const idx = await useMapStore
    .getState()
    .load('taiwan', '3c2f31eb596b101b2989768ffbec27d11ecf82c9fe3c248b48041336ef41a551');
  const def = idx.def;
  window.__a8?.created.surface.destroy();
  document.getElementById('a8-host')?.remove();
  const host = document.createElement('div');
  host.id = 'a8-host';
  host.style.cssText = 'position:fixed;left:0;top:0;width:880px;height:880px;z-index:100000;background:#000';
  document.body.appendChild(host);
  const clock = new AnimClock();
  const created = await createOrigBoard(
    {
      host,
      clock,
      quality: 'high',
      def,
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
      controller: { nameOf: (s) => `P${s + 1}`, autoFollow: () => false },
    },
    client,
  );
  const r = created.surface;
  const ctrl = created.controller;
  const stage = ctrl.stage;
  await ctrl.flics?.ready;
  const colors = [0xff0000, 0x00c000, 0x2060ff, 0xffd000];
  r.owners = { character: (s) => s, color: (s) => colors[s % 4] };
  const tiles = new Map(def.tiles.map((t) => [t.id, t]));
  const sounds = [];
  const audio = { play: (id) => sounds.push(id) };
  const render = () => r.app.render();
  const step = async (ms) => {
    for (let t = 0; t < ms; t += 16) {
      clock.advance(16);
      await new Promise((res) => setTimeout(res, 0));
    }
    render();
    return clock.now();
  };
  const look = (tile) => {
    r.camera.setZoom(2);
    r.camera.lookAt(r.proj.project(tiles.get(tile).world));
    render();
  };
  let running = null;
  const begin = (e) => stage.beginEvent(e, { audio, budgetMs: budgetMs(e, 'original') });
  const actorAt = (seat, character, tile) => {
    const a = r.actor(seat) ?? r.addActor(seat, character, `P${seat + 1}`, tile, colors[seat]);
    a.root.visible = true;
    a.teleport(tile);
    return a;
  };
  const cause = { k: 'card', ref: 17, by: 0 };
  const scenes = {
    god: () => {
      actorAt(0, 3, 20);
      look(20);
      const e = { type: 'GOD_ATTACHED', seat: 0, kind: 4, displaced: null };
      begin(e);
      return stage.godArrive(0, 4, new AbortController().signal);
    },
    ambulance: () => {
      actorAt(0, 3, 20);
      look(20);
      const e = { type: 'CONFINED', actor: { t: 'seat', seat: 0 }, where: 'hospital', days: 3, total: 3, cause };
      begin(e);
      return stage.escort(0, 'hospital', new AbortController().signal);
    },
    police: () => {
      actorAt(0, 3, 20);
      look(20);
      const e = { type: 'CONFINED', actor: { t: 'seat', seat: 0 }, where: 'jail', days: 3, total: 3, cause };
      begin(e);
      return stage.escort(0, 'jail', new AbortController().signal);
    },
    missile: () => {
      look(30);
      const e = { type: 'STRIKE', kind: 'missile', center: 30, half: 100, lots: [], actors: [] };
      begin(e);
      return stage.strike('missile', 30, 100, new AbortController().signal);
    },
    bomb: () => {
      actorAt(1, 5, 40);
      look(40);
      const e = { type: 'BOMB_ATTACHED', seat: 1, fuse: 30 };
      begin(e);
      return stage.bombAttach(1, 30, new AbortController().signal);
    },
    boom: () => {
      look(40);
      const e = { type: 'BOMB_EXPLODED', seat: 1, node: 40, lot: 'L1' };
      begin(e);
      return stage.explode({ tile: 40 }, 'big', new AbortController().signal);
    },
    villain: () => {
      look(50);
      const path = [50, 51, 52, 53, 54, 55];
      begin({ type: 'MOVE_SEGMENT', actor: { t: 'villain', kind: 'robber' }, path: path.slice(1), remaining: 0 });
      return stage.walkVillain('robber', path, new AbortController().signal);
    },
    doll: () => {
      look(60);
      const path = [60, 61, 62, 63, 64];
      begin({ type: 'DOLL_WALK', seat: 0, path, clearedObjects: [], clearedGods: [] });
      return stage.dollWalk(path, [], new AbortController().signal);
    },
  };
  window.__a8 = {
    created,
    r,
    ctrl,
    stage,
    clock,
    sounds,
    step,
    look,
    render,
    scene: (name) => {
      sounds.length = 0;
      const t0 = clock.now();
      running = scenes[name]().then(() => ({ done: clock.now() - t0 }));
      return name;
    },
    finish: async () => {
      let res = null;
      void running.then((x) => {
        res = x;
      });
      for (let i = 0; i < 1000 && !res; i++) await step(16);
      return { ...res, sounds: [...sounds] };
    },
    overlay: () => r.layers.overlay.children.map((c) => `${c.label}@${Math.round(c.position.x)},${Math.round(c.position.y)}`),
  };
  return 'ready';
})();
