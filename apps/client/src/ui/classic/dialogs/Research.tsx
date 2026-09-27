// RESEARCH 的原版场景（original-skin.md §4.2 通用；ui.md §2.1 Data#476 图7「名牌」400×89，五格砖红底——
// 逐像素统计：格子 66×54、左上 (15,17)、步距 76）：五格对应研发项目 1–5，格里画成果道具的图标（Panel#11 图2–14，
// 帧 = 道具号 + 1；项目 p 产出道具 8+p），研究所等级以上的项目禁用、正在研发的项目标出剩余天数。点格子选项目
// （选中格旁出现原版手形光标）。下方宝石消息框：当前研发、研发天数、不收费、改选会放弃进度的提醒。
// YES（开始研发，先选项目）→ RESEARCH{project}、NO / Esc（维持现状）→ SKIP，与程序化的 ResearchDialog 相同；testid 同名。
import type { ResearchProject } from '@rich4/shared/engine';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useGameText } from '../../components/names';
import type { DecisionProps } from '../../decisions/types';
import { useDecision } from '../../decisions/useDecision';
import { DecisionStage } from '../common/DecisionStage';
import { TEXT } from '../common/textStyles';
import { YESNO_SHEET, YesNoBox } from '../common/YesNoBox';
import type { RequiredKeys } from '../decisions/scene';
import { REGION } from '../layout';
import { Sprite } from '../Sprite';
import d from './dialogs.module.css';
import { COMMON_SHEET, CURSOR, CURSOR_SHEET, ITEM_BAR_SHEET, itemIconFrame } from './parts';

export const requiredKeys: RequiredKeys<'RESEARCH'> = [YESNO_SHEET, COMMON_SHEET, ITEM_BAR_SHEET, CURSOR_SHEET];

/** Data#476 图7 的格子几何（相对名牌左上角） */
export const PLATE = { frame: 7, w: 400, h: 89, x0: 15, y0: 17, dx: 76, cw: 66, ch: 54 } as const;
export const PLATE_AT = {
  x: REGION.board.x + Math.round((REGION.board.w - PLATE.w) / 2),
  y: REGION.board.y + 80,
} as const;

export default function ResearchScene(props: DecisionProps<'RESEARCH'>): ReactNode {
  const { t } = useTranslation();
  const { view, map, isMine, decision: d0 } = props;
  const ctl = useDecision(props);
  const text = useGameText(view, map);
  const o = d0.options;
  const cur = o.current;
  const [pick, setPick] = useState<ResearchProject | null>(cur?.project ?? null);
  const curItem = cur ? o.projects.find((p) => p.project === cur.project)?.item : undefined;
  const chosen = o.projects.find((p) => p.project === pick) ?? null;

  return (
    <DecisionStage
      ctl={ctl}
      decision={d0}
      view={view}
      map={map}
      isMine={isMine}
      label={`${t('dlg.research.title')} ${text.lot(o.lot)}`}
      onClose={() => ctl.send({ type: 'SKIP' })}
      closeButton={false}
      countdownAt={{ x: REGION.board.x + REGION.board.w - 38, y: REGION.board.y + 6 }}
      attrs={{ 'data-pick': pick === null ? '' : String(pick) }}
    >
      <fieldset className={d.grid} style={{ left: 0, top: 0 }} aria-label={t('dlg.research.title')}>
        <Sprite sheet={COMMON_SHEET} frame={PLATE.frame} x={PLATE_AT.x} y={PLATE_AT.y} origin="topLeft" />
        {([1, 2, 3, 4, 5] as const).map((project, i) => {
          const row = o.projects.find((p) => p.project === project) ?? null;
          const item = (8 + project) as 9 | 10 | 11 | 12 | 13;
          const cx = PLATE_AT.x + PLATE.x0 + i * PLATE.dx;
          const cy = PLATE_AT.y + PLATE.y0;
          const running = cur?.project === project;
          return (
            <div key={project}>
              <Sprite sheet={ITEM_BAR_SHEET} frame={itemIconFrame(item)} x={cx + PLATE.cw / 2} y={cy + PLATE.ch / 2} />
              <button
                type="button"
                className={d.pick}
                style={{ left: cx, top: cy, width: PLATE.cw, height: PLATE.ch }}
                aria-label={`${text.item(item)} ${row ? t('dlg.research.days', { n: row.days }) : ''}`}
                aria-pressed={pick === project}
                title={text.item(item)}
                disabled={!row || !ctl.interactive}
                data-testid={`research-${project}`}
                onClick={() => setPick(project)}
              />
              {!row && (
                <span
                  className={d.grid}
                  style={{ left: cx, top: cy, width: PLATE.cw, height: PLATE.ch, background: 'rgb(0 0 0 / 0.55)' }}
                  aria-hidden="true"
                />
              )}
              <span
                className={d.pickName}
                style={{
                  ...TEXT.small,
                  left: cx - 5,
                  top: PLATE_AT.y + PLATE.h + 2,
                  width: PLATE.cw + 10,
                  color: pick === project ? '#ffe060' : running ? '#9fe39a' : '#fff',
                }}
              >
                {text.item(item)}
                {running && cur && (
                  <>
                    <br />
                    {t('dlg.research.days', { n: cur.days })}
                  </>
                )}
              </span>
              {pick === project && (
                <Sprite sheet={CURSOR_SHEET} frame={CURSOR.hand} x={cx + 54} y={cy + 42} className={d.pointer} />
              )}
            </div>
          );
        })}
      </fieldset>
      <YesNoBox
        lines={8}
        onYes={() => pick !== null && ctl.send({ type: 'RESEARCH', project: pick })}
        onNo={() => ctl.send({ type: 'SKIP' })}
        yesDisabled={pick === null}
        yesLabel={t('dlg.research.confirm')}
        noLabel={t('dlg.research.skip')}
        yesTestId="research-confirm"
        noTestId="research-skip"
        testId="classic-research-box"
      >
        <p style={TEXT.title}>
          {t('dlg.research.title')} · {t('dlg.common.levelN', { n: o.level })}
        </p>
        {cur && curItem !== undefined ? (
          <p data-testid="research-current">
            {t('dlg.research.current', { item: text.item(curItem), days: cur.days })}
          </p>
        ) : (
          <p>{t('dlg.research.none')}</p>
        )}
        {chosen && <p>{`${text.item(chosen.item)} · ${t('dlg.research.days', { n: chosen.days })}`}</p>}
        <p>{t('dlg.research.free')}</p>
        {cur && pick !== null && pick !== cur.project && <p style={TEXT.warn}>{t('dlg.research.switchWarn')}</p>}
      </YesNoBox>
    </DecisionStage>
  );
}
