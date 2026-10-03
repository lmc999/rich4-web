// 原版新闻板（original-skin.md §4.2 通用；ui.md §2.3 Panel#66 图0 + 插图 Data#400–435）：板面 440×480 不透明贴在舞台 (0,0)
// （下面垫黑：原版整张拷贝，素材包抠掉的 RGB 0 像素原版是黑色，见 layout.ts 的 BOARD_UNDERLAY）
// （盖住工具列与棋盘视窗，资料栏与日历照常可见），插图框 (25,44) 388×251，下方写分类、标题（打字机）、内文与受影响玩家。
// 插图 Data#400+i = illustration.news.<i>（exe 0x44a200 lea edi,[ebx+0x190]）。
// 命运板（同一张 Panel#66 的图1 紫板 + 命运插图表 0x473dd8）见 ./FateBoard。
// data-testid 与程序化 NewsPopup 相同（news-popup[data-news]、news-headline、news-affected…）。
import type { ReactNode } from 'react';
import { useTx } from '../../../i18n/tx';
import { formatMoney } from '../../../presentation/names';
import { useTypewriter } from '../../popups/hooks';
import type { AffectedRow, NewsPopupSpec } from '../../popups/popupStore';
import { classicText, TEXT } from '../common/textStyles';
import { useSceneImage } from '../dialogs/parts';
import { Sprite } from '../Sprite';
import { BOARD_UNDERLAY, NEWS_BOARD, NEWS_SHEET, newsArtKey } from './layout';
import pp from './popups.module.css';

function Affected({ rows }: { rows: readonly AffectedRow[] }): ReactNode {
  const t = useTx();
  if (rows.length === 0) return null;
  return (
    <ul className={pp.affected} aria-label={t('events:popup.newsAffected')} data-testid="news-affected">
      {rows.map((r) => (
        <li key={r.seat} data-seat={r.seat}>
          {r.name}
          {r.deltas.map((d) => (
            <span
              key={d.field}
              className={d.field === 'points' || d.delta > 0 ? pp.gain : pp.loss}
              data-field={d.field}
            >
              {' '}
              {t(`events:popup.field.${d.field}`)} {d.delta > 0 ? '+' : '-'}
              {formatMoney(Math.abs(d.delta))}
            </span>
          ))}
        </li>
      ))}
    </ul>
  );
}

export function NewsBoard({ spec, ms }: { spec: NewsPopupSpec; ms: number }): ReactNode {
  const t = useTx();
  const img = useSceneImage(newsArtKey(spec.id));
  const typed = useTypewriter(spec.headline, Math.min(1400, ms * 0.4));
  const done = typed.length >= [...spec.headline].length;
  const A = NEWS_BOARD.art;
  const T = NEWS_BOARD.text;
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
      <Sprite sheet={NEWS_SHEET} frame={0} x={0} y={0} origin="topLeft" />
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
      <div className={pp.text} style={{ ...TEXT.body, left: T.x, top: T.y, width: T.w, height: T.h }}>
        <p style={classicText({ size: 12, color: '#ffe060' })} data-category={spec.category}>
          {t('events:popup.news')} · {spec.categoryLabel}
        </p>
        <h2 className={pp.srOnly} data-testid="news-headline">
          {spec.headline}
        </h2>
        <p style={classicText({ size: 20, color: '#fff', bold: true, lineHeight: 24 })} aria-hidden="true">
          {typed}
          {!done && '▌'}
        </p>
        {spec.body && <p data-testid="news-body">{spec.body}</p>}
        <Affected rows={spec.affected} />
      </div>
    </section>
  );
}
