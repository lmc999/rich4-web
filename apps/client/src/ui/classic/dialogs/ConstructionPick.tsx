// CONSTRUCTION_PICK 的原版场景（original-skin.md §4.2 通用；建设公司选一块自己的地加盖）：棋盘视窗整个露出来——
// 候选地块高亮到棋盘、棋盘上点候选地块即选中，鼠标光标换成原版手形；右侧（资料栏与日历的位置）一个拉长的宝石消息框，
// 列出候选（地名、等级、工程费或免费；DOM 列表，可滚动），YES（加盖 X，先选地）→ PICK_LOT{lot}，
// canSkip 时 NO（不需要）/ Esc → SKIP，否则只有 YES。逻辑与提交同程序化的 LotPickDialog；testid 同名（construction-<地块>…）。
import type { LotId } from '@rich4/shared/engine';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatMoney } from '../../../presentation/names';
import { formatInt } from '../../components/format';
import { useGameText } from '../../components/names';
import { type BoardPick, useBoardHighlight, useBoardPick } from '../../decisions/targeting';
import type { DecisionProps } from '../../decisions/types';
import { useDecision } from '../../decisions/useDecision';
import { DecisionStage } from '../common/DecisionStage';
import { TEXT } from '../common/textStyles';
import { MESSAGE_BOX, messageBoxHeight, YESNO_SHEET, YesNoBox } from '../common/YesNoBox';
import type { RequiredKeys } from '../decisions/scene';
import { REGION } from '../layout';
import d from './dialogs.module.css';
import { COMMON_SHEET, ConfirmBox, CURSOR_SHEET, useBoardCursor } from './parts';

export const requiredKeys: RequiredKeys<'CONSTRUCTION_PICK'> = [YESNO_SHEET, COMMON_SHEET, CURSOR_SHEET];

/** 右侧长消息框：画点让框贴在资料栏左上（框宽 195 固定），行数按候选多少、最多拉到接近舞台底 */
export const SIDE_BOX = { x: REGION.profile.x + MESSAGE_BOX.ax, y: MESSAGE_BOX.ay + 8, maxLines: 24 } as const;

/** 正文区高度（与 YesNoBox 的排版一致：框高 − 正文起点 36 − YES/NO 区 64） */
export function sideTextHeight(lines: number): number {
  return messageBoxHeight(lines) - MESSAGE_BOX.text.y - 64;
}

export default function ConstructionPickScene(props: DecisionProps<'CONSTRUCTION_PICK'>): ReactNode {
  const { t } = useTranslation();
  const { view, map, isMine, decision: d0 } = props;
  const ctl = useDecision(props);
  const text = useGameText(view, map);
  const o = d0.options;
  const [pick, setPick] = useState<LotId | null>(null);
  const lots = useMemo(() => o.lots.map((l) => l.lot), [o.lots]);
  useBoardHighlight(
    ctl.interactive ? { tiles: [], lots, seats: [], objects: [], selected: pick ? { lot: pick } : null } : null,
  );
  const onBoard = useCallback(
    (p: BoardPick) => {
      if (p.lot && lots.includes(p.lot)) setPick(p.lot);
    },
    [lots],
  );
  useBoardPick(ctl.interactive ? onBoard : null);
  useBoardCursor(ctl.interactive ? 'hand' : null);
  const row = o.lots.find((l) => l.lot === pick) ?? null;

  const lines = Math.min(SIDE_BOX.maxLines, Math.max(8, 5 + o.lots.length));
  const listH = sideTextHeight(lines) - 52;
  const confirmLabel = row
    ? t('dlg.construction.confirm', { name: text.lot(row.lot) })
    : t('dlg.construction.pickFirst');
  const body = (
    <>
      <p style={TEXT.title}>
        {t('dlg.construction.title')} · {text.lot(o.company)}
      </p>
      <p>
        {o.chairman ? t('dlg.construction.chairman', { n: o.levels }) : t('dlg.construction.levels', { n: o.levels })}
      </p>
      {o.lots.length === 0 ? (
        <p>{t('dlg.construction.none')}</p>
      ) : (
        <div className={d.list} style={{ position: 'relative', height: Math.max(30, listH) }} data-interactive="true">
          {o.lots.map((l) => (
            <button
              key={l.lot}
              type="button"
              className={d.listRow}
              aria-pressed={pick === l.lot}
              disabled={!ctl.interactive}
              onClick={() => setPick(l.lot)}
              data-testid={`construction-${l.lot}`}
            >
              <span>
                {text.lot(l.lot)} {t('dlg.common.levelN', { n: l.level })}
                {l.rent > 0 ? ` · ${t('dlg.construction.rent', { rent: formatInt(l.rent) })}` : ''}
              </span>
              <span>{l.cost > 0 ? formatMoney(l.cost) : t('dlg.construction.free')}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );

  return (
    <DecisionStage
      ctl={ctl}
      decision={d0}
      view={view}
      map={map}
      isMine={isMine}
      label={`${t('dlg.construction.title')} ${text.lot(o.company)}`}
      onClose={o.canSkip ? () => ctl.send({ type: 'SKIP' }) : undefined}
      closeButton={false}
      className={d.passThrough}
      countdownAt={{ x: REGION.board.x + REGION.board.w - 38, y: REGION.board.y + 6 }}
      attrs={{ 'data-pick': pick ?? '' }}
    >
      {o.canSkip ? (
        <YesNoBox
          x={SIDE_BOX.x}
          y={SIDE_BOX.y}
          lines={lines}
          onYes={() => row && ctl.send({ type: 'PICK_LOT', lot: row.lot })}
          onNo={() => ctl.send({ type: 'SKIP' })}
          yesDisabled={row === null}
          yesLabel={confirmLabel}
          noLabel={t('dlg.construction.skip')}
          yesTestId="construction-confirm"
          noTestId="construction-skip"
          testId="classic-construction-box"
        >
          {body}
        </YesNoBox>
      ) : (
        <ConfirmBox
          x={SIDE_BOX.x}
          y={SIDE_BOX.y}
          lines={lines}
          yes={{
            label: confirmLabel,
            onClick: () => row && ctl.send({ type: 'PICK_LOT', lot: row.lot }),
            disabled: row === null,
            testId: 'construction-confirm',
          }}
          testId="classic-construction-box"
        >
          {body}
        </ConfirmBox>
      )}
    </DecisionStage>
  );
}
