// BANK_ATM 的原版场景（original-skin.md §4.2 场所屏：银行 ATM Panel#24）：路过银行时 ATM 落在棋盘视窗中央，
// 停在银行时叠在银行底图（Panel#23 图0）之上。两颗业务钮选存 / 取（亮帧表示选中；挤兑期间取款钮压禁止符号），
// 键盘（7–9/4–6/1–3/C 0 ←、MAX、↵）与计量条输入金额，LCD 数字右对齐；↵ 提交 ATM{op, amount}，EXIT / Esc 提交 SKIP。
// 逻辑与提交和程序化 BankAtmDialog 相同（上限全部来自 options：存款上限 = 现金、取款上限 = 存款）；
// data-testid 沿用程序化对话框（decision-BANK_ATM、bank-op-deposit/withdraw、bank-confirm、bank-skip、bank-cash），
// 液晶屏上的透明数字框是 role=spinbutton「金额」（E2E 两种皮肤共用 fill）。
import { type KeyboardEvent, type PointerEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type LooseT, useGameText } from '../../../components/names';
import type { DecisionProps } from '../../../decisions/types';
import { useDecision } from '../../../decisions/useDecision';
import { ClassicButton } from '../../common/ClassicButton';
import { DecisionStage } from '../../common/DecisionStage';
import { type HotspotSpec, Hotspots } from '../../common/Hotspots';
import { type CalcBounds, calcPress, keyOfKeyboard, meterRatio, valueAtRatio } from '../../common/numpad';
import { SceneLayer } from '../../common/Stage4x3';
import { TEXT } from '../../common/textStyles';
import type { RequiredKeys } from '../../decisions/scene';
import { ensureClassicI18n } from '../../i18n';
import type { Rect } from '../../layout';
import { Sprite } from '../../Sprite';
import { ATM, type AtmKey, atmDigits, atmKeyPad, BANK, VENUE_KEYS } from './layout';
import { Amount, SceneText } from './parts';
import v from './venues.module.css';

type AtmOp = 'deposit' | 'withdraw';

/** 路过只要 ATM；停下还要银行底图 */
export const requiredKeys: RequiredKeys<'BANK_ATM'> = (p) =>
  p.decision.options.mode === 'stop' ? [VENUE_KEYS.atm, VENUE_KEYS.bank] : [VENUE_KEYS.atm];

interface OpState {
  op: AtmOp;
  max: number;
  blocked: string | null;
}

const FLASH_MS = 120;

export default function BankAtmScene(props: DecisionProps<'BANK_ATM'>): ReactNode {
  ensureClassicI18n();
  const { t } = useTranslation();
  const lt = t as unknown as LooseT;
  const { view, map, isMine, decision: d } = props;
  const ctl = useDecision(props);
  const text = useGameText(view, map);
  const o = d.options;
  const ops: Record<AtmOp, OpState> = {
    deposit: { op: 'deposit', max: o.cash, blocked: o.cash <= 0 ? t('dlg.bank.noCash') : null },
    withdraw: {
      op: 'withdraw',
      max: o.deposit,
      blocked: !o.canWithdraw ? t('dlg.bank.bankRun') : o.deposit <= 0 ? t('dlg.bank.noDeposit') : null,
    },
  };
  const [op, setOp] = useState<AtmOp>(() => (ops.deposit.blocked === null ? 'deposit' : 'withdraw'));
  const cur = ops[op];
  const [amount, setAmount] = useState(0);
  const bounds: CalcBounds = { min: 0, max: Math.max(0, cur.max), step: 1 };
  const amt = Math.min(Math.max(0, amount), bounds.max);
  const canSubmit = ctl.interactive && cur.blocked === null && amt >= 1;
  const [pressed, setPressed] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const meterRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const origin = ATM.at[o.mode];

  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    [],
  );

  const submit = (): void => {
    if (!canSubmit) return;
    ctl.send({ type: 'ATM', op, amount: amt });
  };

  const choose = (next: AtmOp): void => {
    if (ops[next].blocked !== null || next === op) return;
    setOp(next);
    setAmount(0);
  };

  const press = (key: AtmKey, viaKeyboard = false): void => {
    if (!ctl.interactive) return;
    if (viaKeyboard) {
      setFlash(key);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlash(null), FLASH_MS);
    }
    if (key === 'enter') {
      submit();
      return;
    }
    if (cur.blocked !== null) return;
    setAmount(calcPress(amt, key, bounds));
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.defaultPrevented || !ctl.interactive || e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' && e.key !== 'Enter') return;
    const k = keyOfKeyboard(e.key);
    if (!k) return;
    if (k === 'enter' && target.tagName === 'BUTTON') return;
    e.preventDefault();
    press(k, true);
  };

  const meterAt = (clientX: number): number | null => {
    const el = meterRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0)) return null;
    return valueAtRatio((clientX - r.left) / r.width, bounds);
  };
  const onMeterDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (!ctl.interactive || cur.blocked !== null) return;
    dragging.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const n = meterAt(e.clientX);
    if (n !== null) setAmount(n);
  };
  const onMeterMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return;
    const n = meterAt(e.clientX);
    if (n !== null) setAmount(n);
  };

  const labelOfKey = (k: AtmKey, cap: string): string => {
    if (k === 'enter') return t(op === 'deposit' ? 'dlg.bank.doDeposit' : 'dlg.bank.doWithdraw');
    if (k === 'max') return t('cmp.max');
    if (k === 'back') return lt('classic:calc.back');
    if (k === 'clear') return lt('classic:calc.clear');
    return cap;
  };

  const opLabel = (x: AtmOp): string => t(x === 'deposit' ? 'dlg.bank.deposit' : 'dlg.bank.withdraw');
  // 两组热区：业务钮与 EXIT 一组（最后渲染：手机上补到 44px 的热区压在液晶屏数字框上缘之上）、键盘一组
  const OPS_BOX = ATM.opsBox;
  const KEYS_BOX = ATM.keysBox;
  const rel = (r: Rect, box: Rect): Rect => ({
    ...r,
    x: r.x - box.x,
    y: r.y - box.y,
  });
  const opSpots: HotspotSpec[] = [
    ...(['deposit', 'withdraw'] as const).map(
      (x): HotspotSpec => ({
        id: x,
        rect: rel(ATM.ops[x].rect, OPS_BOX),
        label: opLabel(x),
        title: ops[x].blocked ?? opLabel(x),
        pressed: op === x,
        disabled: ops[x].blocked !== null,
        testId: `bank-op-${x}`,
        onActivate: () => choose(x),
      }),
    ),
    {
      id: 'exit',
      rect: rel(ATM.exit.rect, OPS_BOX),
      label: t('dlg.bank.skip'),
      testId: 'bank-skip',
      onActivate: () => ctl.send({ type: 'SKIP' }),
    },
  ];
  const keySpots: HotspotSpec[] = ATM.keys.map(
    (k): HotspotSpec => ({
      id: k.key,
      rect: rel(k.rect, KEYS_BOX),
      label: labelOfKey(k.key, k.cap),
      hit: rel(atmKeyPad(k), KEYS_BOX),
      disabled: k.key === 'enter' ? !canSubmit : cur.blocked !== null,
      testId: k.key === 'enter' ? 'bank-confirm' : `atm-key-${k.key}`,
      onActivate: () => press(k.key),
    }),
  );

  const shown = flash ?? pressed;
  const ratio = meterRatio(amt, bounds);
  const digits = atmDigits(amt);
  const lcd = ATM.lcd;
  const strip = { x: origin.x, y: origin.y + ATM.h + 4, w: ATM.w, h: 60 };

  return (
    <DecisionStage
      ctl={ctl}
      decision={d}
      view={view}
      map={map}
      isMine={isMine}
      label={`${t('dlg.bank.atmTitle')}（${o.mode === 'pass' ? t('dlg.bank.pass') : t('dlg.bank.stop')}）`}
      onClose={() => ctl.send({ type: 'SKIP' })}
      closeButton={false}
      backdrop={o.mode === 'stop' ? 'opaque' : 'none'}
      countdownAt={{ x: origin.x + ATM.w - 36, y: origin.y + 4 }}
      attrs={{ 'data-mode': o.mode, 'data-op': op }}
    >
      {o.mode === 'stop' && (
        <>
          <Sprite sheet={VENUE_KEYS.bank} frame={BANK.hall} x={0} y={0} origin="topLeft" />
          {/* 柜台底图右下角烘焙的 EXIT：停在银行时同样可以离开 */}
          <ClassicButton
            sheet={VENUE_KEYS.bank}
            frames={{ normal: BANK.exit.normal, hover: BANK.exit.hover }}
            x={BANK.exit.x}
            y={BANK.exit.y}
            w={80}
            h={40}
            label={t('dlg.bank.skip')}
            onClick={() => ctl.send({ type: 'SKIP' })}
            testId="atm-hall-exit"
          />
        </>
      )}
      <SceneLayer x={origin.x} y={origin.y} w={ATM.w} h={ATM.h} testId="classic-atm">
        {/* biome-ignore lint/a11y/noStaticElementInteractions: 键盘快捷键只是便利，每个键都有自己的 <button> */}
        <div className={v.fill} onKeyDown={onKey}>
          <div className={v.deco}>
            <Sprite sheet={VENUE_KEYS.atm} frame={ATM.body} x={0} y={0} origin="topLeft" />
            <Sprite
              sheet={VENUE_KEYS.atm}
              frame={ATM.ops[op].frame}
              x={ATM.ops[op].rect.x}
              y={ATM.ops[op].rect.y}
              origin="topLeft"
            />
            {(['deposit', 'withdraw'] as const).map((x) =>
              ops[x].blocked !== null ? (
                <Sprite
                  key={x}
                  sheet={VENUE_KEYS.atm}
                  frame={ATM.ban}
                  x={ATM.ops[x].rect.x + ATM.ops[x].rect.w / 2}
                  y={ATM.ops[x].rect.y + ATM.ops[x].rect.h / 2}
                  testId={`atm-ban-${x}`}
                />
              ) : null,
            )}
            {shown === 'exit' && (
              <Sprite
                sheet={VENUE_KEYS.atm}
                frame={ATM.exit.frame}
                x={ATM.exit.rect.x}
                y={ATM.exit.rect.y}
                origin="topLeft"
              />
            )}
            {ATM.keys.map((k) =>
              shown === k.key ? (
                <Sprite key={k.key} sheet={VENUE_KEYS.atm} frame={k.frame} x={k.rect.x} y={k.rect.y} origin="topLeft" />
              ) : null,
            )}
            {/* 计量条亮格按比例裁出 */}
            <span
              className={v.clip}
              style={{
                left: ATM.meter.rect.x,
                top: ATM.meter.rect.y,
                width: Math.round(ATM.meter.rect.w * ratio),
                height: ATM.meter.rect.h,
              }}
            >
              <Sprite sheet={VENUE_KEYS.atm} frame={ATM.meter.frame} x={0} y={0} origin="topLeft" />
            </span>
            {/* LCD 数字右对齐 */}
            <span data-testid="atm-lcd" data-value={amt}>
              {digits.map((n, i) => (
                <Sprite
                  // biome-ignore lint/suspicious/noArrayIndexKey: 位数从右往左排，下标即位
                  key={i}
                  sheet={VENUE_KEYS.atm}
                  frame={lcd.frame0 + n}
                  x={lcd.right - lcd.w - (digits.length - 1 - i) * lcd.step}
                  y={lcd.y}
                  origin="topLeft"
                />
              ))}
            </span>
            <SceneText
              rect={{ x: ATM.label.x, y: ATM.label.y, w: 40, h: 34 }}
              style={{ ...TEXT.bodyDark, fontWeight: 700 }}
              testId="atm-op-label"
            >
              {opLabel(op)}
            </SceneText>
          </div>
          <Hotspots
            x={KEYS_BOX.x}
            y={KEYS_BOX.y}
            w={KEYS_BOX.w}
            h={KEYS_BOX.h}
            spots={keySpots}
            disabled={!ctl.interactive}
            onPressChange={setPressed}
            label={t('dlg.bank.amount')}
            testId="atm-keys"
          />
          <div
            ref={meterRef}
            role="slider"
            tabIndex={ctl.interactive && cur.blocked === null ? 0 : -1}
            aria-label={t('dlg.bank.amount')}
            aria-valuemin={0}
            aria-valuemax={bounds.max}
            aria-valuenow={amt}
            aria-disabled={!ctl.interactive || cur.blocked !== null || undefined}
            className={v.meter}
            style={{
              left: ATM.meter.rect.x,
              top: ATM.meter.rect.y,
              width: ATM.meter.rect.w,
              height: ATM.meter.rect.h,
            }}
            data-testid="atm-meter"
            onPointerDown={onMeterDown}
            onPointerMove={onMeterMove}
            onPointerUp={() => {
              dragging.current = false;
            }}
            onPointerCancel={() => {
              dragging.current = false;
            }}
            onKeyDown={(e) => {
              if (!ctl.interactive || cur.blocked !== null) return;
              const step = Math.max(1, Math.trunc(bounds.max / 20));
              let next: number | null = null;
              if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = amt + step;
              else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = amt - step;
              else if (e.key === 'Home') next = 0;
              else if (e.key === 'End') next = bounds.max;
              if (next === null) return;
              e.preventDefault();
              setAmount(Math.min(bounds.max, Math.max(0, next)));
            }}
          />
          <input
            type="number"
            inputMode="numeric"
            className={v.lcdInput}
            style={{ left: ATM.lcdRect.x, top: ATM.lcdRect.y, width: ATM.lcdRect.w, height: ATM.lcdRect.h }}
            aria-label={t('dlg.bank.amount')}
            min={0}
            max={bounds.max}
            step={1}
            value={String(amt)}
            disabled={!ctl.interactive || cur.blocked !== null}
            data-testid="bank-amount-input"
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => {
              const raw = e.currentTarget.value.replace(/[^\d]/g, '');
              const n = raw === '' ? 0 : Number(raw);
              setAmount(Math.min(bounds.max, Math.max(0, Math.trunc(n))));
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              } else if (e.key === 'm' || e.key === 'M') {
                e.preventDefault();
                press('max');
              }
            }}
          />
          <Hotspots
            x={OPS_BOX.x}
            y={OPS_BOX.y}
            w={OPS_BOX.w}
            h={OPS_BOX.h}
            spots={opSpots}
            disabled={!ctl.interactive}
            onPressChange={setPressed}
            label={t('dlg.bank.op')}
            testId="atm-ops"
          />
        </div>
      </SceneLayer>
      {/* ATM 下方的说明：路过 / 停下、现金与存款、不能办的原因、准备金垫付 */}
      <SceneText rect={strip} testId="atm-info">
        <p>
          {o.mode === 'pass' ? t('dlg.bank.pass') : t('dlg.bank.stop')}　{t('dlg.common.cash')}{' '}
          <Amount value={o.cash} testId="bank-cash" />　{t('dlg.common.deposit')}{' '}
          <Amount value={o.deposit} testId="bank-deposit" />
        </p>
        {cur.blocked ? (
          <p style={TEXT.warn} role="alert" data-testid="atm-blocked">
            {cur.blocked}
          </p>
        ) : op === 'withdraw' && o.reserveShortfallPayer !== null ? (
          <p>{lt('dlg.bank.shortfall', { name: text.player(o.reserveShortfallPayer) })}</p>
        ) : null}
      </SceneText>
    </DecisionStage>
  );
}
