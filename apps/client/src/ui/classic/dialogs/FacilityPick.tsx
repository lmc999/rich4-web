// BUILD_FACILITY / FACILITY_TYPE 的原版场景（original-skin.md §4.2 通用；ui.md §2.1「设施类别选择 Data#476 图4」）：
// 设施类别选择条 355×83（公园 / 旅馆 / 购物中心 / 加油站 / 研究所五格，格子 60×60、左上 (11,11)、步距 68，逐像素统计），
// 点格子选种类（选中格旁出现原版手形光标）；下方宝石消息框写兴建费用、现金与所选设施的等级上限、收费预览、说明。
// - BUILD_FACILITY（付费首建，可放弃）：YES → BUILD_FACILITY{facility}（先选种类、现金不足时禁用）、NO / Esc → DECLINE；
// - FACILITY_TYPE（免费首建，只选种类）：只有 YES → CHOOSE_FACILITY_TYPE{facility}。
// 候选种类以 options.types 为准（不在其中的格子禁用）；testid 与程序化的 FacilityBuildDialog 相同（facility-type-<种类>…）。
import { FACILITY_TYPES, type FacilityType } from '@rich4/shared/engine';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type LooseT, useGameText } from '../../components/names';
import { type DecisionProps, narrowDecision } from '../../decisions/types';
import { useDecision } from '../../decisions/useDecision';
import { DecisionStage } from '../common/DecisionStage';
import { TEXT } from '../common/textStyles';
import { YESNO_SHEET, YesNoBox } from '../common/YesNoBox';
import type { RequiredKeys } from '../decisions/scene';
import { REGION } from '../layout';
import { Sprite } from '../Sprite';
import d from './dialogs.module.css';
import { COMMON_SHEET, ConfirmBox, CURSOR, CURSOR_SHEET, Money } from './parts';

type FacilityKind = 'BUILD_FACILITY' | 'FACILITY_TYPE';

export const requiredKeys: RequiredKeys<FacilityKind> = [YESNO_SHEET, COMMON_SHEET, CURSOR_SHEET];

/** Data#476 图4 的格子几何（相对选择条左上角） */
export const FACILITY_BAR = { frame: 4, w: 355, h: 83, x0: 11, y0: 11, dx: 68, cell: 60 } as const;
/** 选择条的左上角（棋盘视窗里水平居中） */
export const FACILITY_BAR_AT = {
  x: REGION.board.x + Math.round((REGION.board.w - FACILITY_BAR.w) / 2),
  y: REGION.board.y + 110,
} as const;

export default function FacilityPickScene(props: DecisionProps<FacilityKind>): ReactNode {
  const { t } = useTranslation();
  const lt = t as unknown as LooseT;
  const { view, map, isMine } = props;
  const d0 = narrowDecision(props.decision);
  const ctl = useDecision(props);
  const text = useGameText(view, map);
  const [pick, setPick] = useState<FacilityType | null>(null);
  const types = d0.options.types;
  const paid = d0.kind === 'BUILD_FACILITY';
  const short = d0.kind === 'BUILD_FACILITY' && d0.options.cost > d0.options.cash;
  const row = types.find((x) => x.type === pick) ?? null;

  const confirm = (): void => {
    if (pick === null) return;
    ctl.send(paid ? { type: 'BUILD_FACILITY', facility: pick } : { type: 'CHOOSE_FACILITY_TYPE', facility: pick });
  };
  const confirmLabel =
    pick === null
      ? t('dlg.facility.pickFirst')
      : t(paid ? 'dlg.facility.build' : 'dlg.facility.choose', { name: text.facility(pick) });

  const bar = (
    <fieldset className={d.grid} style={{ left: 0, top: 0 }} aria-label={t('dlg.facility.types')}>
      <Sprite
        sheet={COMMON_SHEET}
        frame={FACILITY_BAR.frame}
        x={FACILITY_BAR_AT.x}
        y={FACILITY_BAR_AT.y}
        origin="topLeft"
      />
      {FACILITY_TYPES.map((type, i) => {
        const offered = types.some((x) => x.type === type);
        const cx = FACILITY_BAR_AT.x + FACILITY_BAR.x0 + i * FACILITY_BAR.dx;
        const cy = FACILITY_BAR_AT.y + FACILITY_BAR.y0;
        return (
          <div key={type}>
            <button
              type="button"
              className={d.pick}
              style={{ left: cx, top: cy, width: FACILITY_BAR.cell, height: FACILITY_BAR.cell }}
              aria-label={text.facility(type)}
              aria-pressed={pick === type}
              title={text.facility(type)}
              disabled={!offered || !ctl.interactive}
              data-offered={offered ? 'true' : 'false'}
              data-testid={`facility-type-${type}`}
              onClick={() => setPick(type)}
            />
            {!offered && (
              <span
                className={d.grid}
                style={{
                  left: cx,
                  top: cy,
                  width: FACILITY_BAR.cell,
                  height: FACILITY_BAR.cell,
                  background: 'rgb(0 0 0 / 0.55)',
                }}
                aria-hidden="true"
              />
            )}
            <span
              className={d.pickName}
              style={{
                ...TEXT.small,
                left: cx - 4,
                top: FACILITY_BAR_AT.y + FACILITY_BAR.h + 2,
                width: FACILITY_BAR.cell + 8,
                color: pick === type ? '#ffe060' : '#fff',
              }}
            >
              {text.facility(type)}
            </span>
            {pick === type && (
              <Sprite sheet={CURSOR_SHEET} frame={CURSOR.hand} x={cx + 48} y={cy + 46} className={d.pointer} />
            )}
          </div>
        );
      })}
    </fieldset>
  );

  const info = row ? (
    <>
      <p>
        {text.facility(row.type)}：{lt(`dlg.facility.desc.${row.type}`)}
      </p>
      <p>
        {t('dlg.facility.cap', { n: row.cap })} · {t('dlg.facility.fee')} <Money value={row.feePreview} />
      </p>
    </>
  ) : (
    <p>{t('dlg.facility.pickFirst')}</p>
  );

  const title = t(paid ? 'dlg.facility.titleBuild' : 'dlg.facility.titleFree');
  return (
    <DecisionStage
      ctl={ctl}
      decision={d0}
      view={view}
      map={map}
      isMine={isMine}
      label={`${title} ${text.lot(d0.options.lot)}`}
      onClose={paid ? () => ctl.send({ type: 'DECLINE' }) : undefined}
      closeButton={false}
      countdownAt={{ x: REGION.board.x + REGION.board.w - 38, y: REGION.board.y + 6 }}
      attrs={{ 'data-pick': pick ?? '' }}
    >
      {bar}
      {d0.kind === 'BUILD_FACILITY' ? (
        <YesNoBox
          lines={7}
          onYes={confirm}
          onNo={() => ctl.send({ type: 'DECLINE' })}
          yesDisabled={pick === null || short}
          yesLabel={confirmLabel}
          noLabel={t('dlg.facility.decline')}
          yesTestId="facility-confirm"
          noTestId="facility-decline"
          testId="classic-facility-box"
        >
          <p style={TEXT.title}>
            {title} {text.lot(d0.options.lot)}
          </p>
          <p>
            {t('dlg.facility.cost')}：<Money value={d0.options.cost} testId="facility-cost" />
          </p>
          <p>
            {t('dlg.common.cash')}：<Money value={d0.options.cash} />
          </p>
          {short && (
            <p role="alert" style={TEXT.warn}>
              {t('dlg.common.notEnoughCash')}
            </p>
          )}
          {info}
        </YesNoBox>
      ) : (
        <ConfirmBox
          lines={6}
          yes={{ label: confirmLabel, onClick: confirm, disabled: pick === null, testId: 'facility-confirm' }}
          testId="classic-facility-box"
        >
          <p style={TEXT.title}>
            {title} {text.lot(d0.options.lot)}
          </p>
          <p>{t('dlg.facility.freeNote')}</p>
          {info}
        </ConfirmBox>
      )}
    </DecisionStage>
  );
}
