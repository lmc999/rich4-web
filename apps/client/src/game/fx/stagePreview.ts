// /dev/gallery 的「路面物件与特效」预览：在测试地图上摆出全部路面物件、路上神明与恶犬、恶人、乞丐和各种角色状态外观，
// 然后循环播放爆炸、飞弹、核弹、光柱、光束、魔法阵、神明发威、传送等特效。用的是对局同一套 GameRenderer / BoardController / BoardStage。
import { buildTestMap } from '@rich4/shared/data';
import type { GameView } from '@rich4/shared/view';
import { BoardController } from '../BoardController';
import { GameRenderer } from '../GameRenderer';
import type { BoardStage } from './BoardStage';

export interface StagePreviewHandle {
  renderer: GameRenderer;
  stage: BoardStage;
  /** 立即播放下一段特效 */
  next(): void;
  destroy(): void;
}

const ST0 = { hotel: 0, away: 0, jail: 0, hospital: 0, hibernate: 0, sleepwalk: 0, stay: 0, tortoise: 0 };

/** 预览用的最小显示态（只含棋盘与舞台读取的字段） */
export function previewView(): GameView {
  const player = (seat: 0 | 1 | 2 | 3, character: number, node: number, extra: Record<string, unknown>) => ({
    seat,
    character,
    placed: true,
    node,
    alive: true,
    vehicle: 'walk',
    god: null,
    bomb: null,
    st: { ...ST0 },
    ...extra,
  });
  const view = {
    lands: [],
    facilities: [],
    companies: [],
    stocks: [],
    players: [
      player(0, 9, 2, { god: { kind: 2, days: 5 }, vehicle: 'car' }),
      player(1, 4, 5, { st: { ...ST0, hibernate: 3, tortoise: 2 }, bomb: { fuse: 25 } }),
      player(2, 3, 14, { st: { ...ST0, jail: 2 } }),
      player(3, 10, 11, { st: { ...ST0, sleepwalk: 3 }, vehicle: 'moto', god: { kind: 8, days: 3 } }),
    ],
    objects: [
      { id: 1, kind: 'roadblock', node: 3, placedBy: 0 },
      { id: 2, kind: 'mine', node: 6, placedBy: 1 },
      { id: 3, kind: 'bomb', node: 7, placedBy: null },
      { id: 4, kind: 'gift', node: 9, placedBy: null },
      { id: 5, kind: 'chest', node: 12, placedBy: null },
    ],
    gods: [
      { slot: 0, kind: 1, where: { t: 'road', node: 8 } },
      { slot: 8, kind: 9, where: { t: 'road', node: 13 } },
      { slot: 10, kind: 11, where: { t: 'road', node: 10 } },
      { slot: 12, kind: 15, where: { t: 'road', node: 18 } },
    ],
    beggars: [{ seat: 3, node: 20 }],
    villains: [
      { kind: 'thief', onBoard: true, node: 15 },
      { kind: 'robber', onBoard: false, node: 0 },
      { kind: 'thug', onBoard: true, node: 17 },
      { kind: 'spy', onBoard: false, node: 0 },
    ],
  };
  return view as unknown as GameView;
}

type Demo = (s: BoardStage, signal: AbortSignal) => Promise<void>;

const DEMOS: readonly Demo[] = [
  (s, sig) => s.explode({ tile: 6 }, 'big', sig),
  (s, sig) => s.strike('missile', 9, 100, sig),
  (s, sig) => s.pillar({ seat: 0 }, 0xffd84d, sig),
  (s, sig) => s.beam({ seat: 0 }, { seat: 1 }, 0xf2545b, sig),
  (s, sig) => s.magic(0, [1, 3], sig),
  (s, sig) => s.godPower(0, 2, sig),
  (s, sig) => s.teleport({ tile: 4 }, { tile: 16 }, sig),
  (s, sig) => s.manifest(12, { tile: 12 }, 'levelUp', sig),
  (s, sig) => s.strike('nuke', 11, 220, sig),
  (s, sig) => s.rewind(sig),
];

export async function mountStagePreview(host: HTMLElement): Promise<StagePreviewHandle> {
  const renderer = await GameRenderer.create({ host, quality: 'high' });
  await renderer.loadMap(buildTestMap());
  // 拉近一些，看得清物件与状态外观
  await renderer.camera.zoomTo(1.05, 0);
  const ctrl = new BoardController(renderer, { nameOf: (s) => `${s + 1}P`, autoFollow: () => false });
  const view = previewView();
  ctrl.syncView(view);
  const stage = ctrl.fx.stageFor(ctrl) as BoardStage;
  stage.syncWorld(view);
  let i = 0;
  let busy = false;
  const ac = new AbortController();
  const play = (): void => {
    if (busy || ac.signal.aborted) return;
    busy = true;
    const demo = DEMOS[i++ % DEMOS.length]!;
    void demo(stage, ac.signal).finally(() => {
      busy = false;
    });
  };
  const timer = setInterval(play, 2400);
  play();
  return {
    renderer,
    stage,
    next: play,
    destroy() {
      clearInterval(timer);
      ac.abort();
      ctrl.clearFx();
      renderer.destroy();
    },
  };
}
