// BAIL 的原版场景：监狱（Panel#63 砖墙 8 个窗洞 + 铁栏、四大恶人 Panel#64）或医院（Panel#65 走廊 8 张病床、护士）。
// - 8 格 = 4 个座位 + 4 个恶人：被关押 / 住院的玩家与关在这里的恶人露出大头（医院是躺在病床上），名牌写名字与剩余天数；
// - 点一格选中（监狱铁栏换成开着的门；恶人另在右下角露出全身像），讲话框写说明与价钱；YES = 保释（30 点券）/
//   雇用（300 点券），NO = 离开（SKIP）；点券不够的格子不能选；
// - data-testid：格子 bail-seat-<座位> / bail-hire-<恶人>（选中），YES bail-confirm，NO bail-skip；Esc 也是离开。
import type { SeatIndex, VillainKind } from '@rich4/shared/engine';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTx } from '../../../../i18n/tx';
import { formatMoney } from '../../../../presentation/names';
import { useGameText } from '../../../components/names';
import type { DecisionProps } from '../../../decisions/types';
import { useDecision } from '../../../decisions/useDecision';
import s from '../../common/common.module.css';
import { DecisionStage } from '../../common/DecisionStage';
import { classicText } from '../../common/textStyles';
import { YESNO_SHEET } from '../../common/YesNoBox';
import type { RequiredKeys } from '../../decisions/scene';
import { Sprite } from '../../Sprite';
import {
  BAIL_UI,
  type BailWhere,
  BUBBLE_TEXT,
  bailCell,
  barsAt,
  cellRect,
  doorAt,
  HOSPITAL_FRAME,
  HOSPITAL_SHEET,
  JAIL_FRAME,
  JAIL_SHEET,
  nameTagAt,
  POINTS_TEXT,
  portraitAt,
  portraitFrame,
  VILLAIN_SHEET,
  villainIndex,
} from './bailLayout';
import { characterOf, YesNoPair } from './shared';
import v from './venues.module.css';

export function bailSheet(where: BailWhere): string {
  return where === 'jail' ? JAIL_SHEET : HOSPITAL_SHEET;
}

/** 依赖的素材：监狱或医院图集、YES/NO；监狱另要恶人全身像 */
export const requiredKeys: RequiredKeys<'BAIL'> = (p) =>
  p.decision.options.where === 'jail' ? [JAIL_SHEET, VILLAIN_SHEET, YESNO_SHEET] : [HOSPITAL_SHEET, YESNO_SHEET];

type BailPick = { k: 'bail'; seat: SeatIndex } | { k: 'hire'; kind: VillainKind };

export default function BailScene(props: DecisionProps<'BAIL'>): ReactNode {
  const { t } = useTranslation();
  const tx = useTx();
  const { view, map, isMine, decision: d } = props;
  const ctl = useDecision(props);
  const text = useGameText(view, map);
  const o = d.options;
  const where = o.where;
  const jail = where === 'jail';
  const sheet = bailSheet(where);
  const ui = BAIL_UI[where];
  const canBail = o.points >= o.costs.bail;
  const canHire = o.points >= o.costs.hire;
  const [pick, setPick] = useState<BailPick | null>(null);

  const inmateOf = (seat: SeatIndex) => o.inmates.find((m) => m.seat === seat) ?? null;
  const villainOf = (kind: VillainKind) => o.villains.find((x) => x.kind === kind) ?? null;
  const selected = (i: number): boolean => {
    const c = bailCell(i);
    if (!pick) return false;
    return c.k === 'seat' ? pick.k === 'bail' && pick.seat === c.seat : pick.k === 'hire' && pick.kind === c.kind;
  };

  const confirm = (): void => {
    if (!pick) return;
    if (pick.k === 'bail') ctl.send({ type: 'BAIL', target: pick.seat });
    else ctl.send({ type: 'HIRE', villain: pick.kind });
  };
  const leave = (): void => {
    ctl.send({ type: 'SKIP' });
  };

  const yesOk = pick !== null && (pick.k === 'bail' ? canBail : canHire);
  const costLine = (k: 'bail' | 'hire'): string =>
    `${t(k === 'bail' ? 'dlg.bail.bailFor' : 'dlg.bail.hireFor')} ${formatMoney(o.costs[k])} ${t('dlg.common.points')}`;

  let bubble: ReactNode;
  if (pick?.k === 'bail') {
    const m = inmateOf(pick.seat);
    bubble = (
      <>
        <p style={classicText({ size: 12, color: '#1f5a2a', outline: null, bold: true, lineHeight: 14 })}>
          {text.player(pick.seat)}
        </p>
        {m && <p>{t('dlg.bail.remaining', { n: m.remaining })}</p>}
        <p>{costLine('bail')}</p>
      </>
    );
  } else if (pick?.k === 'hire') {
    bubble = (
      <>
        <p style={classicText({ size: 12, color: '#1f5a2a', outline: null, bold: true, lineHeight: 14 })}>
          {text.villain(pick.kind)} ・ {costLine('hire')}
        </p>
        <p>{tx(`dlg.bail.villainDesc.${pick.kind}`)}</p>
      </>
    );
  } else {
    bubble = (
      <>
        <p style={classicText({ size: 12, color: '#1f5a2a', outline: null, bold: true, lineHeight: 14 })}>
          {t(jail ? 'dlg.bail.titleJail' : 'dlg.bail.titleHospital')}
        </p>
        {o.inmates.length > 0 && <p>{costLine('bail')}</p>}
        {o.villains.length > 0 && <p>{costLine('hire')}</p>}
        {((!canBail && o.inmates.length > 0) || (!canHire && o.villains.some((x) => x.available))) && (
          <p style={{ color: '#a01a10' }}>{text.reason('notEnoughPoints')}</p>
        )}
      </>
    );
  }

  const cells = Array.from({ length: 8 }, (_, i) => {
    const c = bailCell(i);
    if (c.k === 'seat') {
      const p = view.players.find((x) => x.seat === c.seat);
      const m = inmateOf(c.seat);
      const confined = p ? p.st[where] !== 0 : false;
      if (!p || (!m && !confined)) return { i, c, show: false as const };
      return {
        i,
        c,
        show: true as const,
        frame: portraitFrame(where, { k: 'seat', character: p.character }),
        name: text.player(c.seat),
        sub: m ? t('dlg.bail.remaining', { n: m.remaining }) : '',
        enabled: m !== null && canBail,
        testId: `bail-seat-${c.seat}`,
        label: `${costLine('bail')}：${text.player(c.seat)}${m ? `（${t('dlg.bail.remaining', { n: m.remaining })}）` : ''}`,
        select: (): void => setPick({ k: 'bail', seat: c.seat }),
      };
    }
    const vi = villainOf(c.kind);
    if (!vi) return { i, c, show: false as const };
    return {
      i,
      c,
      show: true as const,
      frame: portraitFrame(where, { k: 'villain', kind: c.kind }),
      name: text.villain(c.kind),
      sub: vi.available ? '' : t('dlg.bail.villainAway'),
      enabled: vi.available && canHire,
      testId: `bail-hire-${c.kind}`,
      label: `${costLine('hire')}：${text.villain(c.kind)}`,
      select: (): void => setPick({ k: 'hire', kind: c.kind }),
    };
  });

  const tag = classicText({ size: 12, lineHeight: 14 });

  return (
    <DecisionStage
      ctl={ctl}
      decision={d}
      view={view}
      map={map}
      isMine={isMine}
      label={t(jail ? 'dlg.bail.titleJail' : 'dlg.bail.titleHospital')}
      backdrop="opaque"
      onClose={leave}
      closeButton={false}
      attrs={{ 'data-venue': where, 'data-pick': pick ? (pick.k === 'bail' ? `seat-${pick.seat}` : pick.kind) : '' }}
    >
      <div className={v.deco}>
        {jail ? (
          <>
            {/* 窗洞后面的人（墙在上面，窗洞是透明孔） */}
            {cells.map((x) =>
              x.show ? (
                <Sprite
                  key={x.i}
                  sheet={sheet}
                  frame={x.frame}
                  x={portraitAt(where, x.i).x}
                  y={portraitAt(where, x.i).y}
                  testId={`bail-portrait-${x.i}`}
                />
              ) : null,
            )}
            <Sprite sheet={sheet} frame={JAIL_FRAME.bg} x={0} y={0} origin="topLeft" />
            {cells.map((x) =>
              selected(x.i) ? (
                <Sprite
                  key={x.i}
                  sheet={sheet}
                  frame={JAIL_FRAME.door}
                  x={doorAt(x.i).x}
                  y={doorAt(x.i).y}
                  origin="topLeft"
                />
              ) : (
                <Sprite
                  key={x.i}
                  sheet={sheet}
                  frame={JAIL_FRAME.bars}
                  x={barsAt(x.i).x}
                  y={barsAt(x.i).y}
                  origin="topLeft"
                />
              ),
            )}
          </>
        ) : (
          <>
            <Sprite sheet={sheet} frame={HOSPITAL_FRAME.bg} x={0} y={0} origin="topLeft" />
            {ui.nurse && (
              <Sprite sheet={sheet} frame={HOSPITAL_FRAME.nurse} x={ui.nurse.x} y={ui.nurse.y} origin="topLeft" />
            )}
            {cells.map((x) =>
              x.show ? (
                <Sprite
                  key={x.i}
                  sheet={sheet}
                  frame={x.frame}
                  x={portraitAt(where, x.i).x}
                  y={portraitAt(where, x.i).y}
                  testId={`bail-portrait-${x.i}`}
                />
              ) : null,
            )}
          </>
        )}
        {cells.map((x) => {
          if (!x.show) return null;
          const r = nameTagAt(where, x.i);
          return (
            <p
              key={x.i}
              className={v.box}
              style={{ ...tag, left: r.x, top: r.y, width: r.w, height: r.h, textAlign: 'center' }}
            >
              {x.name}
              {x.sub ? ` ${x.sub}` : ''}
            </p>
          );
        })}
        {/* 选中的恶人：全身像 */}
        {pick?.k === 'hire' && ui.villain && (
          <Sprite
            sheet={VILLAIN_SHEET}
            frame={villainIndex(pick.kind)}
            x={ui.villain.x}
            y={ui.villain.y}
            testId="bail-villain-figure"
          />
        )}
        {/* 讲话框 */}
        <Sprite
          sheet={sheet}
          frame={jail ? JAIL_FRAME.bubble : HOSPITAL_FRAME.bubble}
          x={ui.bubble.x}
          y={ui.bubble.y}
          origin="topLeft"
        />
        <div
          className={v.box}
          style={{
            ...classicText({ size: 12, color: '#3a2410', outline: null, lineHeight: 14 }),
            left: ui.bubble.x + BUBBLE_TEXT.x,
            top: ui.bubble.y + BUBBLE_TEXT.y,
            width: BUBBLE_TEXT.w,
            height: BUBBLE_TEXT.h,
          }}
          data-testid="bail-bubble"
        >
          {bubble}
        </div>
        {/* 点券 */}
        <Sprite
          sheet={sheet}
          frame={jail ? JAIL_FRAME.points : HOSPITAL_FRAME.points}
          x={ui.points.x}
          y={ui.points.y}
          origin="topLeft"
        />
        <p
          className={v.box}
          style={{
            ...classicText({ size: 15, lineHeight: 20, align: 'right', bold: true }),
            left: ui.points.x + POINTS_TEXT.x,
            top: ui.points.y + POINTS_TEXT.y,
            width: POINTS_TEXT.w,
            height: POINTS_TEXT.h,
          }}
          data-testid="bail-points"
          data-value={o.points}
          title={t('dlg.common.points')}
        >
          {formatMoney(o.points)}
        </p>
      </div>

      {/* 格子（透明按钮） */}
      {cells.map((x) => {
        if (!x.show) return null;
        const r = cellRect(where, x.i);
        return (
          <button
            key={x.i}
            type="button"
            className={v.cell}
            style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
            aria-label={x.label}
            aria-pressed={selected(x.i)}
            data-selected={selected(x.i) ? 'true' : undefined}
            disabled={!x.enabled || !ctl.interactive}
            data-testid={x.testId}
            onClick={x.select}
          />
        );
      })}

      <YesNoPair
        x={ui.yesno.x}
        y={ui.yesno.y}
        onYes={confirm}
        onNo={leave}
        yesDisabled={!yesOk || !ctl.interactive}
        noDisabled={!ctl.interactive}
        yesLabel={pick?.k === 'hire' ? t('dlg.bail.hireFor') : t('dlg.bail.bailFor')}
        noLabel={t('dlg.bail.skip')}
        yesTestId="bail-confirm"
        noTestId="bail-skip"
        testId="bail-yesno"
      />

      {/* 读屏：在押 / 住院的人与可雇的恶人 */}
      <div className={s.srOnly}>
        <p>{t(jail ? 'dlg.bail.inmatesJail' : 'dlg.bail.inmatesHospital')}</p>
        {o.inmates.length === 0 && <p>{t('dlg.bail.noInmates')}</p>}
        {o.villains.length > 0 && <p>{t('dlg.bail.villains')}</p>}
      </div>
    </DecisionStage>
  );
}

/** 测试：格子里的人（纯函数版，供单测核对 8 格分配） */
export function bailOccupants(
  o: DecisionProps<'BAIL'>['decision']['options'],
  view: DecisionProps<'BAIL'>['view'],
): { cell: number; who: string }[] {
  const out: { cell: number; who: string }[] = [];
  for (let i = 0; i < 8; i++) {
    const c = bailCell(i);
    if (c.k === 'seat') {
      const p = view.players.find((x) => x.seat === c.seat);
      if (p && (o.inmates.some((m) => m.seat === c.seat) || p.st[o.where] !== 0))
        out.push({ cell: i, who: `seat${c.seat}:${characterOf(view, c.seat)}` });
    } else if (o.villains.some((x) => x.kind === c.kind)) out.push({ cell: i, who: c.kind });
  }
  return out;
}
