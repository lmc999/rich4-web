// 原版新闻板（original-skin.md §4.2 通用；exe v2.06 fcn.0044a173，ui.md §2.3 Panel#66 图0 + 插图 Data#400–435）：
// - 板面 440×480 不透明贴在舞台 (0,0)（下面垫黑：原版整张拷贝，素材包抠掉的 RGB 0 像素原版是黑色，见 layout.ts 的
//   BOARD_UNDERLAY），盖住工具列与棋盘视窗，资料栏与日历照常可见；插图框 (25,44) 388×251，插图 Data#400+i =
//   illustration.news.<i>（exe 0x44a200 lea edi,[ebx+0x190]）；
// - 分类名（无責任新聞 / 政府公告 / 社會新聞 / 路況報導 / 氣象報導 / 財經新聞，表 0x473cfc）写在 (24,8)，标题（原版原文，
//   i18n news:<id>.headline，可能两行）写在 (24,310)，都是 28px（./boardText）；整块画好才拷上屏幕，没有打字机；
// - 受影响玩家按各新闻处理函数参数 0 分支列出（layout.ts 的 NEWS_BOARD_LISTS）：税 / 储金红利逐行 24px「<人>繳交<n>元」
//   写在 (24, 346 + 32·i)，讲话头像画在 (390, 358 + 32·i)；获释 / 延长、豪雨 / 塞车、得奖的人只画头像。其余新闻不画人。
// - 停留与跳过由 handler / PopupScene 负责（shared/view/pacing 的 NEWS_SHOW：等语音播完、不足 2.4 秒补足；任意鼠标键 /
//   按键放开即结束并停掉语音，原版 fcn.00452c39(2400)）；原版新闻板没有音效，只有语音。
// 命运板（同一张 Panel#66 的图1 紫板 + 命运插图表 0x473dd8）见 ./FateBoard。
// data-testid 与程序化 NewsPopup 相同（news-popup[data-news]、news-headline、news-affected…），另有 news-category、
// news-art、news-row、news-face。
import type { ReactNode } from 'react';
import { useTx } from '../../../i18n/tx';
import type { NewsPopupSpec } from '../../popups/popupStore';
import { speakerSheet } from '../common/SpeakerBubble';
import { useEnsureSceneSprites } from '../common/sceneAssets';
import { useSceneImage } from '../dialogs/parts';
import { Sprite } from '../Sprite';
import { boardText } from './boardText';
import {
  BOARD_UNDERLAY,
  NEWS_BOARD,
  NEWS_BOARD_LISTS,
  NEWS_LIST_FACE_X,
  NEWS_LIST_TEXT_DY,
  NEWS_LIST_TEXT_X,
  NEWS_SHEET,
  newsArtKey,
} from './layout';
import pp from './popups.module.css';

/** 分类名与标题：28px（fcn.0044e200(28, …) 0x44a1eb） */
const TEXT28 = boardText(28);
/** 逐人名单：24px（fcn.0044e200(24, …) 0x4487f5 / 0x4499af） */
const TEXT24 = boardText(24);

export function NewsBoard({ spec }: { spec: NewsPopupSpec }): ReactNode {
  const t = useTx();
  const img = useSceneImage(newsArtKey(spec.id));
  const list = NEWS_BOARD_LISTS[spec.id] ?? null;
  const people = list ? spec.affected : [];
  useEnsureSceneSprites(people.map((r) => speakerSheet(r.character)));
  const A = NEWS_BOARD.art;
  const C = NEWS_BOARD.category;
  const H = NEWS_BOARD.headline;
  return (
    <section
      className={pp.layer}
      style={{ left: 0, top: 0, width: NEWS_BOARD.w, height: NEWS_BOARD.h }}
      data-testid="news-popup"
      data-news={spec.id}
      aria-label={t('events:popup.news')}
    >
      <span
        className={pp.underlay}
        style={{ left: 0, top: 0, width: NEWS_BOARD.w, height: NEWS_BOARD.h, background: BOARD_UNDERLAY }}
        aria-hidden="true"
      />
      <Sprite sheet={NEWS_SHEET} frame={0} x={0} y={0} origin="topLeft" testId="news-board" />
      {img ? (
        <span
          className={pp.art}
          style={{ left: A.x, top: A.y, width: A.w, height: A.h, backgroundImage: `url("${img.url}")` }}
          data-testid="news-art"
          aria-hidden="true"
        />
      ) : (
        <span className={pp.blank} style={{ left: A.x, top: A.y, width: A.w, height: A.h }} aria-hidden="true" />
      )}
      <p
        className={pp.text}
        style={{ ...TEXT28, left: C.x, top: C.y, margin: 0, overflow: 'visible' }}
        data-testid="news-category"
        data-category={spec.category}
      >
        {spec.categoryLabel}
      </p>
      <h2
        className={pp.text}
        style={{ ...TEXT28, left: H.x, top: H.y, margin: 0, overflow: 'visible' }}
        data-testid="news-headline"
      >
        {spec.headline}
      </h2>
      {list && people.length > 0 && (
        <ul
          className={pp.list}
          style={{ left: 0, top: 0, width: NEWS_BOARD.w, height: NEWS_BOARD.h }}
          aria-label={t('events:popup.newsAffected')}
          data-testid="news-affected"
        >
          {people.map((r, i) => {
            const y = list.faceY0 + list.dy * i;
            return (
              <li key={r.seat} data-seat={r.seat} aria-label={list.rows ? undefined : r.name}>
                {list.rows && (
                  <span
                    className={pp.text}
                    style={{ ...TEXT24, left: NEWS_LIST_TEXT_X, top: y + NEWS_LIST_TEXT_DY, overflow: 'visible' }}
                    data-testid="news-row"
                  >
                    {r.line ?? r.name}
                  </span>
                )}
                <Sprite
                  sheet={speakerSheet(r.character)}
                  frame={list.face}
                  x={NEWS_LIST_FACE_X}
                  y={y}
                  testId="news-face"
                />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
