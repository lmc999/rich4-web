// BANK_COUNTER 的原版场景（original-skin.md §4.2 场所屏：银行 Panel#23）：柜台底图（图0）上柜员眨眼说话、心形气泡讲解
// 当前业务；右侧资料羊皮纸（图15）列现金 / 存款 / 贷款与到期日、额度；蓝钮（图16/17）选贷款 / 还款 / 特别融资（银行董事长
// 才有；选中后换成董事长办公室图2，董事长用讲话框图22 说话）；金额用计算器（Panel#21 + 掩膜 Panel#22），↵ 或蓝色确认钮
// 提交 LOAN / REPAY / FINANCE{amount}，EXIT（图18/19）与 Esc 提交 SKIP。
// 上限全部来自 options（loanLimit、repayMax、financeLimit）；不能办的业务钮压禁止符号（图23）并在气泡里说明原因。
// data-testid 沿用程序化 BankCounterDialog（bank-op-loan/repay/finance、bank-confirm、bank-skip、counter-loan、counter-limit）；
// 隐藏的 role=spinbutton「金额」给读屏与 E2E 直接填数。
import type { ReactNode } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDateShort } from '../../../components/format';
import { type LooseT, useGameText } from '../../../components/names';
import type { DecisionProps } from '../../../decisions/types';
import { useDecision } from '../../../decisions/useDecision';
import { Calculator } from '../../common/Calculator';
import { ClassicButton } from '../../common/ClassicButton';
import { DecisionStage } from '../../common/DecisionStage';
import { NUMPAD_MASK, NUMPAD_SHEET } from '../../common/numpad';
import { SceneLayer } from '../../common/Stage4x3';
import { TEXT } from '../../common/textStyles';
import type { RequiredKeys } from '../../decisions/scene';
import { Sprite } from '../../Sprite';
import { BANK, VENUE_KEYS } from './layout';
import { Amount, PlateButton, SceneText, SrNumber, useBlink, useTalk } from './parts';

type CounterOp = 'loan' | 'repay' | 'finance';

export const requiredKeys: RequiredKeys<'BANK_COUNTER'> = [VENUE_KEYS.bank, NUMPAD_SHEET, NUMPAD_MASK];

interface OpDef {
  op: CounterOp;
  label: string;
  max: number;
  blocked: string | null;
}

const INTENT = { loan: 'LOAN', repay: 'REPAY', finance: 'FINANCE' } as const;

export default function BankCounterScene(props: DecisionProps<'BANK_COUNTER'>): ReactNode {
  const { t } = useTranslation();
  const lt = t as unknown as LooseT;
  const { view, map, isMine, decision: d } = props;
  const ctl = useDecision(props);
  const text = useGameText(view, map);
  const o = d.options;
  const ops: OpDef[] = [
    {
      op: 'loan',
      label: t('dlg.bank.loan'),
      max: o.loanLimit,
      blocked: o.loanBlocked
        ? lt(`dlg.bank.loanBlocked.${o.loanBlocked}`)
        : o.loanLimit <= 0
          ? t('dlg.bank.noLimit')
          : null,
    },
    {
      op: 'repay',
      label: t('dlg.bank.repay'),
      max: o.repayMax,
      blocked: o.loan <= 0 ? t('dlg.bank.noLoan') : o.repayMax <= 0 ? t('dlg.bank.noMoney') : null,
    },
  ];
  if (o.financeLimit !== null) {
    ops.push({
      op: 'finance',
      label: t('dlg.bank.finance'),
      max: o.financeLimit,
      blocked: o.financeLimit <= 0 ? t('dlg.bank.noLimit') : null,
    });
  }
  const [op, setOp] = useState<CounterOp>(() => (ops.find((x) => x.blocked === null) ?? ops[0]!).op);
  const cur = ops.find((x) => x.op === op) ?? ops[0]!;
  const [amount, setAmount] = useState(0);
  const max = Math.max(0, cur.max);
  const amt = Math.min(Math.max(0, amount), max);
  const canSubmit = ctl.interactive && cur.blocked === null && amt >= 1;
  const office = op === 'finance';
  const blink = useBlink();
  const talk = useTalk(
    `${op}:${cur.blocked ?? ''}`,
    office ? BANK.chairman.mouth.talk.length : BANK.clerk.mouth.talk.length,
  );

  const submit = (): void => {
    if (!canSubmit) return;
    ctl.send({ type: INTENT[op], amount: amt });
  };
  const choose = (next: OpDef): void => {
    if (next.blocked !== null || next.op === op) return;
    setOp(next.op);
    setAmount(0);
  };

  const face = office ? BANK.chairman : BANK.clerk;
  const balloon = office ? BANK.chairmanBalloon : BANK.clerkBalloon;
  const sheet = BANK.sheet;
  const rows: [string, ReactNode][] = [
    [t('dlg.common.cash'), <Amount key="c" value={o.cash} testId="counter-cash" />],
    [t('dlg.common.deposit'), <Amount key="d" value={o.deposit} testId="counter-deposit" />],
    [t('dlg.bank.loanNow'), <Amount key="l" value={o.loan} testId="counter-loan" />],
  ];

  return (
    <DecisionStage
      ctl={ctl}
      decision={d}
      view={view}
      map={map}
      isMine={isMine}
      label={t('dlg.bank.counterTitle')}
      onClose={() => ctl.send({ type: 'SKIP' })}
      closeButton={false}
      backdrop="opaque"
      countdownAt={BANK.ring}
      attrs={{ 'data-op': op, 'data-room': office ? 'office' : 'hall' }}
    >
      <Sprite sheet={VENUE_KEYS.bank} frame={office ? BANK.office : BANK.hall} x={0} y={0} origin="topLeft" />
      {/* 表情：眨眼、说话 */}
      {blink && (
        <Sprite sheet={VENUE_KEYS.bank} frame={face.eyes.closed} x={face.eyes.x} y={face.eyes.y} origin="topLeft" />
      )}
      {talk >= 0 && (
        <Sprite
          sheet={VENUE_KEYS.bank}
          frame={face.mouth.talk[talk % face.mouth.talk.length]!}
          x={face.mouth.x}
          y={face.mouth.y}
          origin="topLeft"
        />
      )}

      {/* 讲话：当前业务的说明，或不能办的原因 */}
      <SceneLayer x={balloon.x} y={balloon.y} testId="counter-balloon">
        <Sprite sheet={VENUE_KEYS.bank} frame={balloon.frame} x={0} y={0} origin="topLeft" />
        <SceneText
          rect={balloon.text}
          style={{ ...TEXT.bodyDark, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}
        >
          <p style={{ ...TEXT.bodyDark, fontWeight: 700 }}>{cur.label}</p>
          {cur.blocked ? (
            <p role="alert" style={{ ...TEXT.bodyDark, color: '#b01010' }} data-testid="counter-blocked">
              {cur.blocked}
            </p>
          ) : (
            <p style={TEXT.bodyDark}>{lt(`dlg.bank.hint.${op}`)}</p>
          )}
        </SceneText>
      </SceneLayer>

      {/* 资料羊皮纸：标题与到期日 / 额度，三栏现金、存款、贷款 */}
      <SceneLayer x={sheet.x} y={sheet.y} w={200} h={280} testId="counter-sheet">
        <Sprite sheet={VENUE_KEYS.bank} frame={sheet.frame} x={0} y={0} origin="topLeft" />
        <SceneText rect={sheet.title} style={TEXT.bodyDark}>
          <p style={{ ...TEXT.bodyDark, fontSize: 16, lineHeight: '20px', fontWeight: 700 }}>
            {t('dlg.bank.counterTitle')}
          </p>
          <p style={TEXT.bodyDark}>{text.player(d.seat)}</p>
          <p style={TEXT.bodyDark}>
            {t('dlg.bank.due')}：
            {o.loan > 0
              ? formatDateShort(o.loanDue)
              : t('dlg.bank.duePreview', { date: formatDateShort(o.dueDatePreview) })}
          </p>
          <p style={TEXT.bodyDark}>
            {t('dlg.bank.limit')}：<Amount value={o.loanLimit} testId="counter-limit" />
          </p>
        </SceneText>
        {rows.map(([k, val], i) => (
          <SceneText
            key={k}
            rect={sheet.rows[i]!}
            style={{ ...TEXT.bodyDark, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
          >
            <span>{k}</span>
            <span>{val}</span>
          </SceneText>
        ))}
        {o.financeLimit !== null && (
          <SceneText rect={{ x: 12, y: 258, w: 176, h: 18 }} style={TEXT.bodyDark} testId="counter-finance">
            {t('dlg.bank.financeNow')} <Amount value={o.finance} /> / <Amount value={o.financeLimit} />
          </SceneText>
        )}
      </SceneLayer>

      {/* 业务钮 */}
      {ops.map((x, i) => {
        const at = BANK.ops[i]!;
        return (
          <PlateButton
            key={x.op}
            x={at.x}
            y={at.y}
            w={BANK.blue.w}
            h={BANK.blue.h}
            label={x.label}
            title={x.blocked ?? x.label}
            pressed={op === x.op}
            disabled={x.blocked !== null}
            plate={{ sheet: VENUE_KEYS.bank, normal: BANK.blue.normal, hover: BANK.blue.hover }}
            testId={`bank-op-${x.op}`}
            onClick={() => choose(x)}
            textStyle={{ fontSize: 15, lineHeight: '18px', fontWeight: 700 }}
          />
        );
      })}
      {ops.map((x, i) =>
        x.blocked !== null ? (
          <Sprite
            key={`ban-${x.op}`}
            sheet={VENUE_KEYS.bank}
            frame={BANK.ban}
            x={BANK.ops[i]!.x + BANK.blue.w - 16}
            y={BANK.ops[i]!.y + BANK.blue.h / 2}
            testId={`counter-ban-${x.op}`}
          />
        ) : null,
      )}

      {/* 金额：计算器 + 隐藏的数字框；确认钮 */}
      <Calculator
        value={amt}
        onChange={setAmount}
        min={0}
        max={max}
        onEnter={() => submit()}
        enterDisabled={!canSubmit}
        x={BANK.calc.x}
        y={BANK.calc.y}
        label={t('dlg.bank.amount')}
        disabled={!ctl.interactive || cur.blocked !== null}
        testId="bank-calc"
      />
      <SrNumber
        label={t('dlg.bank.amount')}
        value={amt}
        min={0}
        max={max}
        onChange={setAmount}
        disabled={!ctl.interactive || cur.blocked !== null}
        testId="bank-amount-input"
      />
      <PlateButton
        x={BANK.confirm.x}
        y={BANK.confirm.y}
        w={BANK.blue.w}
        h={BANK.blue.h}
        label={`${lt(`dlg.bank.do.${op}`)} ${amt}`}
        disabled={!canSubmit}
        plate={{ sheet: VENUE_KEYS.bank, normal: BANK.blue.normal, hover: BANK.blue.hover }}
        testId="bank-confirm"
        onClick={submit}
      >
        {lt(`dlg.bank.do.${op}`)} <Amount value={amt} unit={t('cmp.unit.yuan')} testId="counter-amount" />
      </PlateButton>
      <ClassicButton
        sheet={VENUE_KEYS.bank}
        frames={{ normal: BANK.exit.normal, hover: BANK.exit.hover }}
        x={BANK.exit.x}
        y={BANK.exit.y}
        w={80}
        h={40}
        label={t('dlg.bank.leave')}
        onClick={() => ctl.send({ type: 'SKIP' })}
        testId="bank-skip"
      />
    </DecisionStage>
  );
}
