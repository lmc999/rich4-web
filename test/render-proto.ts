/**
 * 临时调试原型：用原版素材按原版渲染模型拼台湾图（v2.06 Game/map.mkf）。
 *   npx tsx test/render-proto.ts
 * 输出：.cache/assets-research/render/*.png 与 render-proto.report.json（均 gitignore，不入库）。
 *
 * 渲染模型（本次逆向 v2.06 fcn.00407ebd 得出，见报告）：
 *   - 投影表 T[view][(dy+14)*29 + (dx+14)] = (sy, sx)（注意 (Y, X) 顺序、dy 在外层）
 *   - 亚格偏移 o1 = (m0*fx>>5) + (m2*fy>>5)，o2 = (m1*fx>>5) + (m3*fy>>5)，fx = x&31，fy = y&31
 *   - 镜头 (cx, cy)：基准 bx = 220 + o1(cam)，by = 260 + o2(cam)（屏幕 640×480 坐标，棋盘区 (0,40)-(440,480)）
 *   - 世界点 P：sx = bx + T.sx − o1(P)，sy = by + T.sy − o2(P)，格差 |d| ≤ 14 才画
 *   - 地面：格 (dx,dy) 的四角 = T(dx,dy)、T(dx+1,dy)、T(dx+1,dy+1)、T(dx,dy+1) + (bx,by)，贴 GND 图块 arrange[(cy+dy)*72 + cx+dx]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Canvas, Mkf, parseGnd, parseLib, parseMap, type SpriteLib } from './render-lib';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = `${ROOT}.cache/assets-research/render${process.env.ED === 'v311' ? '/v311' : ''}`;
mkdirSync(OUT, { recursive: true });

// ───────────── 表 ─────────────
interface RawView {
  cellScreen: { data: [number, number][][] };
  subcell: { data: [number, number, number, number][] };
  drawOrder: { data: [number, number][][] };
}
const tables = JSON.parse(readFileSync(`${ROOT}.cache/extract/tables.${process.env.ED === 'v311' ? 'v311' : 'v206'}.json`, 'utf8')) as { view: RawView };
const V = tables.view;
/** 返回 (sx, sy)。raw 项是 (sy, sx)。 */
function T(view: number, dx: number, dy: number): [number, number] {
  const e = V.cellScreen.data[view]![(dy + 14) * 29 + (dx + 14)]!;
  return [e[1], e[0]];
}
function sub(view: number, x: number, y: number): [number, number] {
  const fx = x & 31;
  const fy = y & 31;
  const m = V.subcell.data[view]!;
  return [((m[0] * fx) >> 5) + ((m[2] * fy) >> 5), ((m[1] * fx) >> 5) + ((m[3] * fy) >> 5)];
}
interface Cam {
  view: number;
  x: number;
  y: number;
}
function base(c: Cam): [number, number] {
  const [o1, o2] = sub(c.view, c.x, c.y);
  return [220 + o1, 260 + o2];
}
/** 原版世界点 → 屏幕（640×480 坐标）；越出 ±14 格返回 null */
function project(c: Cam, x: number, y: number): [number, number] | null {
  const dx = (x >> 5) - (c.x >> 5);
  const dy = (y >> 5) - (c.y >> 5);
  if (dx < -14 || dx > 14 || dy < -14 || dy > 14) return null;
  const [bx, by] = base(c);
  const [tx, ty] = T(c.view, dx, dy);
  const [o1, o2] = sub(c.view, x, y);
  return [bx + tx - o1, by + ty - o2];
}

// ───────────── 线性拟合（整图总览用；原版只有 ±14 格的表） ─────────────
function fitAffine(view: number) {
  let Sxx = 0;
  let Sxy = 0;
  let Syy = 0;
  let X1 = 0;
  let X2 = 0;
  let Y1 = 0;
  let Y2 = 0;
  for (let dy = -14; dy <= 14; dy++)
    for (let dx = -14; dx <= 14; dx++) {
      const [sx, sy] = T(view, dx, dy);
      Sxx += dx * dx;
      Sxy += dx * dy;
      Syy += dy * dy;
      X1 += dx * sx;
      X2 += dy * sx;
      Y1 += dx * sy;
      Y2 += dy * sy;
    }
  const det = Sxx * Syy - Sxy * Sxy;
  const a = (X1 * Syy - X2 * Sxy) / det;
  const b = (X2 * Sxx - X1 * Sxy) / det;
  const c = (Y1 * Syy - Y2 * Sxy) / det;
  const e = (Y2 * Sxx - Y1 * Sxy) / det;
  let maxErr = 0;
  for (let dy = -14; dy <= 14; dy++)
    for (let dx = -14; dx <= 14; dx++) {
      const [sx, sy] = T(view, dx, dy);
      maxErr = Math.max(maxErr, Math.abs(a * dx + b * dy - sx), Math.abs(c * dx + e * dy - sy));
    }
  const s = Math.hypot(a, b);
  const theta = (Math.atan2(-b, a) * 180) / Math.PI;
  const k = Math.hypot(c, e) / s;
  return { a, b, c, e, maxErr, s, theta, k };
}

// ───────────── 素材 ─────────────
const ED = process.env.ED === 'v311' ? 'v311' : 'v206';
const SHARE = process.env.RICH4_SHARE ?? '';
const mapMkf = new Mkf(ED === 'v206' ? `${ROOT}original/Game/map.mkf` : `${ROOT}original/MultiverseJourney/map.mkf`);
// v3.11 的 Data.mkf 不在 original/，需从 Steam 安装目录（只读共享盘）读取
const dataMkf = new Mkf(ED === 'v206' ? `${ROOT}original/Game/Data.mkf` : `${SHARE}/MultiverseJourney/Data.mkf`);
const GM = 0; // 台湾
const gnd = parseGnd(mapMkf.get(GM * 2));
const map = parseMap(mapMkf.get(GM * 2 + 1));
const libCache = new Map<string, SpriteLib>();
const lib = (mkf: Mkf, i: number) => {
  const k = `${mkf.path}#${i}`;
  let l = libCache.get(k);
  if (!l) {
    l = parseLib(mkf.get(i));
    libCache.set(k, l);
  }
  return l;
};
// 资源号：v2.06 = fcn.0040779b 载入器；v3.11 = fcn.00407ad2 载入器 + fcn.0040829d 绘制器
const RES =
  ED === 'v206'
    ? {
        decor: 12, // SMP 17 帧，node+0x22 的 1 基下标
        ownerFlag: 13, // SPR 12 帧，空地有主时的角色标记，帧 = 角色号
        lotOverlay: 14, // SPR 5 帧，涨价/查封地块高亮
        house: (gm: number, level: number) => 27 + gm * 5 + (level - 1), // level 1..5
        chain: (_gm: number) => 47,
        // kind 0 公園；1 旅館 2 購物中心 3 加油站 4 研究所；各 5 级
        facility: (kind: number, level: number) => (kind === 0 ? 48 : 48 + (kind - 1) * 5 + level),
        spriteId: (id: number) => id + 26, // 企业 +0x20 / 景观 +0x1a
        // Data.mkf：角色 c 的 21 套姿态 = 87 + 21c + k
        charPose: (c: number, k: number) => 87 + 21 * c + k,
        object: (t: number) => 0x163 + t - 1,
      }
    : {
        decor: 24, // SMP 58 帧（奇数普通、偶数粉红光环、37..58 天体）
        ownerFlag: 25,
        lotOverlay: 26,
        house: (gm: number, level: number) => 0x27 + gm * 5 + (level - 1),
        chain: (gm: number) => 0x4f + gm,
        // 17 槽：0 公園、1..5 旅館、6..10 購物中心、11 加油站（仅 1 级）、12..16 研究所；stage0 基址 0x57，stage1 为 0x68 + map*17
        facility: (kind: number, level: number) =>
          0x57 + [0, level, 5 + level, 11, 11 + level][kind]!,
        spriteId: (id: number) => id + 0x26,
        charPose: (c: number, k: number) => 0x80 + 21 * c + k,
        object: (t: number) => 0x18c + t - 1,
      };

const PLAYER_COLORS: [number, number, number][] = [
  [232, 48, 48],
  [48, 96, 232],
  [40, 200, 72],
  [240, 208, 32],
];

// 演示状态：让住宅/设施都有建筑，便于核对锚点与朝向
function demoState() {
  const lands = map.lands.map((l, i) => {
    const level = i % 7 === 6 ? 0 : (i % 5) + 1; // 1..5，每 7 块留一块空地
    return { ...l, level, owner: (i % 4) + 1, chain: i % 11 === 10 };
  });
  const facilities = map.facilities.map((f, i) => ({ ...f, kind: i % 5, level: i % 5 === 0 ? 1 : 3, owner: ((i + 1) % 4) + 1 }));
  return { lands, facilities };
}
const demo = demoState();

// 玩家：4 名角色放在节点上，朝向下一节点
function dirOf(dx: number, dy: number): number {
  // 原版 fcn.00453614：ang = atan2(−dy, dx)，o = round(ang/45°) & 7，dir = [2,3,4,5,6,7,0,1][o]
  const ang = Math.atan2(-dy, dx);
  const o = ((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8;
  return [2, 3, 4, 5, 6, 7, 0, 1][o]!;
}

interface DrawItem {
  key: number;
  seq: number;
  lib: SpriteLib;
  frame: number;
  sx: number;
  sy: number;
  recolor?: [number, number, number];
  tag: string;
}
function drawKey(sy: number, layer: number): number {
  const v = (((sy & 0xfff) << 4) | layer) & 0xffff;
  return v >= 0x8000 ? v - 0x10000 : v;
}

function renderBoard(cam: Cam, players: { char: number; node: number }[], opts: { overlayNodes: boolean }) {
  const cv = new Canvas(640, 480, [0, 0, 0]);
  cv.clip = [0, 40, 440, 480];
  const [bx, by] = base(cam);
  const cellX = cam.x >> 5;
  const cellY = cam.y >> 5;
  // 1) 地面：按 drawOrder（b0 = dy，b1 = dx）
  let tilesDrawn = 0;
  for (const [b0, b1] of V.drawOrder.data[cam.view]!) {
    const dy = b0;
    const dx = b1;
    const row = cellY + dy;
    const col = cellX + dx;
    if (row < 0 || row >= 72 || col < 0 || col >= 72) continue;
    const q = [T(cam.view, dx, dy), T(cam.view, dx + 1, dy), T(cam.view, dx + 1, dy + 1), T(cam.view, dx, dy + 1)].map(
      ([x, y]) => [x + bx, y + by] as [number, number],
    );
    cv.texQuad(q, gnd.tiles, gnd.arrange[row * 72 + col]! * 1024, gnd.palette);
    tilesDrawn++;
  }
  // 2) 节点装饰（不排序，紧接地面）
  const decor = lib(mapMkf, RES.decor);
  let decorDrawn = 0;
  for (const n of map.nodes) {
    if (!n.decor) continue;
    const p = project(cam, n.x, n.y);
    if (!p) continue;
    cv.blit(decor, n.decor - 1, p[0], p[1]);
    decorDrawn++;
  }
  // 3) 排序精灵
  const items: DrawItem[] = [];
  let seq = 0;
  const push = (x: number, y: number, layer: number, l: SpriteLib, frame: number, tag: string, recolor?: [number, number, number]) => {
    const p = project(cam, x, y);
    if (!p) return;
    items.push({ key: drawKey(p[1], layer), seq: seq++, lib: l, frame, sx: p[0], sy: p[1], recolor, tag });
  };
  const fr = (facing: number) => (8 - (facing + cam.view)) & 7;
  for (const p of players) {
    const n = map.nodes[p.node - 1]!;
    const nx = map.nodes[(n.adj.find((a) => a) ?? p.node) - 1]!;
    const dir = dirOf(nx.x - n.x, nx.y - n.y);
    const boat = (n.flags & 0x80000000) !== 0;
    const l = lib(dataMkf, RES.charPose(p.char, boat ? 13 : 0));
    const per = l.frames.length >> 3;
    push(n.x, n.y, 0xc, l, ((8 - cam.view + dir) & 7) * per, `player${p.char}`);
  }
  for (const l of demo.lands) {
    if (l.level) {
      const res = l.chain ? RES.chain(GM) : RES.house(GM, l.level);
      push(l.x, l.y, 0, lib(mapMkf, res), fr(l.facing), `land${l.id}`, PLAYER_COLORS[(l.owner ?? 1) - 1]);
    } else if (l.owner) {
      push(l.x, l.y, 0, lib(mapMkf, RES.ownerFlag), (l.owner - 1) % 12, `flag${l.id}`);
    }
  }
  for (const f of demo.facilities) {
    const res = RES.facility(f.kind ?? 0, f.level ?? 1);
    push(f.x, f.y, 0, lib(mapMkf, res), fr(f.facing), `fac${f.id}`, PLAYER_COLORS[(f.owner ?? 1) - 1]);
  }
  for (const c of map.companies) if (c.sprite) push(c.x, c.y, 0, lib(mapMkf, RES.spriteId(c.sprite)), fr(c.facing), `comp${c.id}`, [0, 0, 0]);
  for (const s of map.landscapes) if (s.sprite) push(s.x, s.y, 0, lib(mapMkf, RES.spriteId(s.sprite)), fr(s.facing), `scape${s.id}`);
  items.sort((a, b) => a.key - b.key || a.seq - b.seq);
  for (const it of items) cv.blit(it.lib, it.frame, it.sx, it.sy, it.recolor);
  // 4) 核对叠加：节点红点 + 邻接细线（原版没有，仅验证用）
  let nodesVisible = 0;
  if (opts.overlayNodes) {
    for (const n of map.nodes) {
      const p = project(cam, n.x, n.y);
      if (!p) continue;
      for (const a of n.adj) {
        if (!a) continue;
        const m = map.nodes[a - 1]!;
        const q = project(cam, m.x, m.y);
        if (q) cv.line(p[0], p[1], q[0], q[1], [255, 0, 255]);
      }
    }
    for (const n of map.nodes) {
      const p = project(cam, n.x, n.y);
      if (!p) continue;
      if (p[0] >= 0 && p[0] < 440 && p[1] >= 40 && p[1] < 480) nodesVisible++;
      cv.dot(p[0], p[1], 2, [255, 0, 0]);
    }
  }
  cv.clip = [0, 0, 640, 480];
  // 棋盘框
  cv.line(0, 40, 439, 40, [255, 255, 255]);
  cv.line(440, 40, 440, 479, [255, 255, 255]);
  return { cv, tilesDrawn, decorDrawn, sprites: items.length, nodesVisible };
}

// 整图总览：用拟合仿射把 72×72 块全部投影（原版没有这种视图，仅为目视核对）
function renderOverview(view: number, withSprites: boolean) {
  const A = fitAffine(view);
  const P = (x: number, y: number): [number, number] => [(A.a * x + A.b * y) / 32, (A.c * x + A.e * y) / 32];
  const corners = [P(0, 0), P(2304, 0), P(0, 2304), P(2304, 2304)];
  const minX = Math.floor(Math.min(...corners.map((c) => c[0]))) - 160;
  const minY = Math.floor(Math.min(...corners.map((c) => c[1]))) - 200;
  const maxX = Math.ceil(Math.max(...corners.map((c) => c[0]))) + 160;
  const maxY = Math.ceil(Math.max(...corners.map((c) => c[1]))) + 60;
  const cv = new Canvas(maxX - minX, maxY - minY, [0, 0, 0]);
  const S = (x: number, y: number): [number, number] => {
    const [a, b] = P(x, y);
    return [a - minX, b - minY];
  };
  for (let row = 0; row < 72; row++)
    for (let col = 0; col < 72; col++) {
      const x = col * 32;
      const y = row * 32;
      cv.texQuad([S(x, y), S(x + 32, y), S(x + 32, y + 32), S(x, y + 32)], gnd.tiles, gnd.arrange[row * 72 + col]! * 1024, gnd.palette);
    }
  const decor = lib(mapMkf, RES.decor);
  for (const n of map.nodes) if (n.decor) cv.blit(decor, n.decor - 1, ...S(n.x, n.y).map(Math.round) as [number, number]);
  if (withSprites) {
    const items: { sy: number; draw: () => void }[] = [];
    const fr = (facing: number) => (8 - (facing + view)) & 7;
    const add = (x: number, y: number, l: SpriteLib, f: number, rc?: [number, number, number]) => {
      const [sx, sy] = S(x, y).map(Math.round) as [number, number];
      items.push({ sy, draw: () => cv.blit(l, f, sx, sy, rc) });
    };
    for (const l of demo.lands) if (l.level) add(l.x, l.y, lib(mapMkf, l.chain ? RES.chain(GM) : RES.house(GM, l.level)), fr(l.facing), PLAYER_COLORS[(l.owner ?? 1) - 1]);
    for (const f of demo.facilities) add(f.x, f.y, lib(mapMkf, RES.facility(f.kind ?? 0, f.level ?? 1)), fr(f.facing), PLAYER_COLORS[(f.owner ?? 1) - 1]);
    for (const c of map.companies) if (c.sprite) add(c.x, c.y, lib(mapMkf, RES.spriteId(c.sprite)), fr(c.facing), [0, 0, 0]);
    for (const s of map.landscapes) if (s.sprite) add(s.x, s.y, lib(mapMkf, RES.spriteId(s.sprite)), fr(s.facing));
    items.sort((a, b) => a.sy - b.sy);
    for (const it of items) it.draw();
  }
  for (const n of map.nodes) {
    const p = S(n.x, n.y);
    for (const a of n.adj) if (a) cv.line(p[0], p[1], ...S(map.nodes[a - 1]!.x, map.nodes[a - 1]!.y), [255, 0, 255]);
  }
  for (const n of map.nodes) cv.dot(...S(n.x, n.y), 3, (n.flags & 0x80000000) !== 0 ? [0, 255, 255] : [255, 0, 0]);
  return { cv, fit: A };
}

// 附带一张正射底图 + 节点（世界坐标 = 底图像素），证明坐标系一致
function renderTopDown() {
  const cv = new Canvas(2304, 2304);
  for (let row = 0; row < 72; row++)
    for (let col = 0; col < 72; col++) {
      const t = gnd.arrange[row * 72 + col]! * 1024;
      for (let y = 0; y < 32; y++)
        for (let x = 0; x < 32; x++) {
          const c = gnd.tiles[t + y * 32 + x]!;
          cv.put(col * 32 + x, row * 32 + y, gnd.palette[c * 4]!, gnd.palette[c * 4 + 1]!, gnd.palette[c * 4 + 2]!);
        }
    }
  for (const n of map.nodes) for (const a of n.adj) if (a) cv.line(n.x, n.y, map.nodes[a - 1]!.x, map.nodes[a - 1]!.y, [255, 0, 255]);
  for (const n of map.nodes) cv.dot(n.x, n.y, 4, (n.flags & 0x80000000) !== 0 ? [0, 255, 255] : [255, 0, 0]);
  for (const l of map.lands) cv.dot(l.x, l.y, 3, [255, 255, 0]);
  for (const f of map.facilities) cv.dot(f.x, f.y, 5, [0, 255, 0]);
  for (const c of map.companies) cv.dot(c.x, c.y, 5, [0, 128, 255]);
  for (const s of map.landscapes) cv.dot(s.x, s.y, 5, [255, 128, 0]);
  return cv;
}

// ───────────── 运行 ─────────────
const report: Record<string, unknown> = { gm: GM, gnd: { tilesW: gnd.tilesW, tilesH: gnd.tilesH, identityArrange: gnd.arrange.every((v, i) => v === i) } };
report.fits = Array.from({ length: 8 }, (_, v) => fitAffine(v));

const top = renderTopDown();
top.downscale(2).savePng(`${OUT}/taiwan_topdown_nodes_half.png`);

for (const view of [0, 1, 3]) {
  const { cv } = renderOverview(view, true);
  const name = view === 0 ? 'taiwan_view0' : `taiwan_view${view}_overview`;
  cv.savePng(`${OUT}/${name}.png`);
  cv.downscale(3).savePng(`${OUT}/${name}_third.png`);
}
const g0 = renderOverview(0, false);
g0.cv.downscale(3).savePng(`${OUT}/taiwan_view0_groundonly_third.png`);

const nodeById = (id: number) => map.nodes[id - 1]!;
const cams: { name: string; node: number }[] = [
  { name: 'taipei', node: map.nodes.find((n) => n.type === 2001)!.id },
  { name: 'greenisland', node: 1 },
  { name: 'center', node: 50 },
];
const boards: unknown[] = [];
for (const view of [0, 1, 2, 5]) {
  for (const c of cams) {
    const n = nodeById(c.node);
    const cam: Cam = { view, x: n.x, y: n.y };
    const ps = [
      { char: 0, node: c.node },
      { char: 1, node: n.adj.find((a) => a) ?? c.node },
    ];
    const r = renderBoard(cam, ps, { overlayNodes: true });
    r.cv.savePng(`${OUT}/board_v${view}_${c.name}.png`);
    const clean = renderBoard(cam, ps, { overlayNodes: false });
    clean.cv.savePng(`${OUT}/board_v${view}_${c.name}_clean.png`);
    boards.push({ view, cam: c.name, camWorld: [n.x, n.y], tilesDrawn: r.tilesDrawn, decorDrawn: r.decorDrawn, sprites: r.sprites, nodesVisible: r.nodesVisible });
  }
}
report.boards = boards;

// 表投影 vs 拟合仿射：以每个节点为镜头，比较 ±14 格内所有节点/地块的屏幕位置差
const affineErr: Record<string, number> = {};
for (let view = 0; view < 8; view++) {
  const A = fitAffine(view);
  let worst = 0;
  const pts = [...map.nodes, ...map.lands, ...map.facilities, ...map.companies, ...map.landscapes];
  for (const c of map.nodes) {
    const cam: Cam = { view, x: c.x, y: c.y };
    for (const p of pts) {
      const t = project(cam, p.x, p.y);
      if (!t) continue;
      const ax = 220 + (A.a * (p.x - c.x) + A.b * (p.y - c.y)) / 32;
      const ay = 260 + (A.c * (p.x - c.x) + A.e * (p.y - c.y)) / 32;
      worst = Math.max(worst, Math.abs(ax - t[0]), Math.abs(ay - t[1]));
    }
  }
  affineErr[`view${view}`] = Math.round(worst * 100) / 100;
}
report.tableVsAffineMaxPx = affineErr;
writeFileSync(`${OUT}/render-proto.report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 1).slice(0, 3000));
