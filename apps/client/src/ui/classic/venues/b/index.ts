// 原版场所屏（第二组，original-skin.md §4.2 场所屏、§5 A12）的注册表。登记方式见 ../../decisions/scene.ts：
// KIND: classicScene(() => import('./Xxx'))；与 ../a、../../dialogs 不得重复登记同一 kind。
//   MAGIC_CAST   魔法屋（Panel#18/19/20）
//   AUCTION_BID  拍卖厅（Panel#26 + Q 版小人 Panel#27–62）
//   BAIL         监狱 / 医院 / 四大恶人（Panel#63/64/65）
// 场景音乐不需要场景自己放：app/audioWiring 的 venueOf 按本人的决策（以及他人公开的魔法屋、拍卖决策）选场景曲
// （MAGIC_CAST → magic、AUCTION_BID → auction、BAIL → jail / hospital）；公佈欄在原版没有场景曲，保持棋盘曲。
//
// 另有两个不对应独立决策的原版画面，由别处挂载：
// - 公佈欄（Panel#73）是 TURN_MENU 的子页。回合菜单的原版场景由 ../../dialogs 登记；接入方式（同 venues/a 的股市）：
//   A. 一行：dialogs/index.ts 的 TURN_MENU 改为 classicScene(() => import('../venues/b/TurnMenuBoard'))
//      （默认导出 = 原版回合菜单 + 原版公佈欄，requiredKeys 已并入 BULLETIN_REQUIRED_KEYS）；
//   B. 组合：<ClassicBoardSheet {...p}><TurnMenuScene {...p} /></ClassicBoardSheet>（./BoardSheet；可与 venues/a 的
//      ClassicStockSheet 嵌套），requiredKeys 并入 BULLETIN_REQUIRED_KEYS；
//   C. 直接渲染 <BulletinBoardScene {...p} ctl={ctl} onClose={关闭子页} />（./BulletinBoard，自带 DecisionStage，
//      testid 仍是 decision-TURN_MENU，data-sheet="board"）。
// - 观战版拍卖厅 ClassicAuctionWatch（props { view, map }）：本人没有 AUCTION_BID 决策（观战者、卖方、已退出的人）而
//   拍卖进行中时由经典布局挂载，只读、不挡棋盘；素材逻辑键见 auctionWatchKeys（挂载前用 sceneKeysStatus 判定）。
import { lazy } from 'react';
import type { ClassicDecisionRegistry } from '../../decisions/scene';
import { classicScene } from '../../decisions/scene';
import { AUCTION_SHEET, chibiSheet } from './auctionLayout';
import { BULLETIN_REQUIRED_KEYS } from './bulletinLayout';

export const classicVenuesB: ClassicDecisionRegistry = {
  MAGIC_CAST: classicScene(() => import('./MagicHouse')),
  AUCTION_BID: classicScene(() => import('./Auction')),
  BAIL: classicScene(() => import('./Bail')),
};

export type { ClassicBoardSheetProps } from './BoardSheet';
export type { BulletinBoardProps } from './BulletinBoard';
export { BULLETIN_REQUIRED_KEYS };

/** TURN_MENU 的公佈欄子页（原版 Panel#73，懒加载；props 见 BulletinBoardProps） */
export const ClassicBulletinBoard = lazy(() => import('./BulletinBoard'));

/** 观战版拍卖厅（只读，懒加载） */
export const ClassicAuctionWatch = lazy(() => import('./Auction').then((m) => ({ default: m.AuctionWatchScene })));
export type { AuctionWatchSceneProps } from './Auction';

/** 观战版拍卖厅依赖的素材：拍卖厅图集 + 在场玩家的 Q 版小人 */
export function auctionWatchKeys(characters: readonly number[]): string[] {
  return [AUCTION_SHEET, ...characters.map((c) => chibiSheet(c))];
}
