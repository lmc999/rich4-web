// LOTTERY 的原版场景（original-skin.md §4.2 场所屏：乐透投注 Panel#12 + 跑马灯 Panel#14）：酒吧底图（号码盘 01–36 烘焙在图里）、
// 猫女坐在号码盘上沿眨眼说话、气泡（图8）讲规则与价格；奖池写在跑马灯 FLC 里；已售号码压暗并画买主的小头（map#15–26 图5），
// 本人买的加金边；点号码 → 选号圈（图7）套上并弹 YES/NO（Data#399 + 消息框）确认 → LOTTERY_BUY{number: 下标}；
// 「机选」在未售号码里随机挑一个，「不买」/ Esc 提交 SKIP。现金不足时 YES 禁用。
// 逻辑与程序化 LotteryDialog 相同；data-testid 沿用（lottery-ball-<n>、lottery-quick、lottery-buy、lottery-skip、lottery-pool）。
// 手机横屏：号码格 62×46 逻辑像素排满号码盘，热区补不到 44px，另给一个原生下拉框选号（系统选择器）。
import type { SeatIndex } from '@rich4/shared/engine';
import { type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useGameText } from '../../../components/names';
import type { DecisionProps } from '../../../decisions/types';
import { useDecision } from '../../../decisions/useDecision';
import { DecisionStage } from '../../common/DecisionStage';
import { type HotspotSpec, Hotspots } from '../../common/Hotspots';
import { speakerSheet } from '../../common/SpeakerBubble';
import { SceneLayer } from '../../common/Stage4x3';
import { TEXT } from '../../common/textStyles';
import { MESSAGE_SHEET, YESNO_SHEET, YesNoBox } from '../../common/YesNoBox';
import type { RequiredKeys } from '../../decisions/scene';
import { Sprite } from '../../Sprite';
import { preloadLotteryDraw } from './LotteryDraw';
import { LOTTERY, lotteryCell, VENUE_KEYS } from './layout';
import { Amount, PlateButton, SceneText, useBlink, useTalk, VenueFlic } from './parts';
import v from './venues.module.css';

/** 号码盘热区容器的上缘（号码盘卡片从 y≈255 起） */
const BOARD_TOP = 250;

/** 未售号码的下标 */
export function freeNumbers(sold: readonly (SeatIndex | null)[]): number[] {
  const out: number[] = [];
  sold.forEach((o, i) => {
    if (o === null) out.push(i);
  });
  return out;
}

/** 机选：在未售号码里等概率挑一个；全部售出时 null */
export function quickPick(sold: readonly (SeatIndex | null)[], random: () => number = Math.random): number | null {
  const free = freeNumbers(sold);
  if (free.length === 0) return null;
  return free[Math.min(free.length - 1, Math.floor(random() * free.length))]!;
}

/** 在场玩家的角色号（画已售号码的买主小头） */
function charactersOf(p: Pick<DecisionProps<'LOTTERY'>, 'view'>): number[] {
  return [...new Set(p.view.players.map((x) => x.character))];
}

export const requiredKeys: RequiredKeys<'LOTTERY'> = (p) => [
  VENUE_KEYS.lotteryBet,
  VENUE_KEYS.marquee,
  YESNO_SHEET,
  MESSAGE_SHEET,
  ...charactersOf(p).map(speakerSheet),
];

export interface LotteryBetSceneProps extends DecisionProps<'LOTTERY'> {
  /** 机选用的随机源（测试注入） */
  random?: () => number;
}

export default function LotteryBetScene(props: LotteryBetSceneProps): ReactNode {
  const { t } = useTranslation();
  const { view, map, isMine, decision: d } = props;
  const ctl = useDecision(props);
  const text = useGameText(view, map);
  const o = d.options;
  const [pick, setPick] = useState<number | null>(null);
  const free = freeNumbers(o.sold);
  const short = o.price > o.cash;
  const mine = o.sold.filter((x) => x === d.seat).length;
  const blink = useBlink();
  const talk = useTalk(`${pick ?? ''}:${short}`, 2);
  const charOf = (seat: SeatIndex): number => view.players.find((x) => x.seat === seat)?.character ?? 0;
  const g = LOTTERY.girl;

  // 投注之后月中就会开奖：先把开奖演出的素材取回来
  useEffect(() => preloadLotteryDraw(), []);

  const spots: HotspotSpec[] = o.sold.map((owner, i) => {
    const c = lotteryCell(i);
    const label =
      owner === null
        ? t('dlg.lottery.ballFree', { n: i + 1 })
        : t('dlg.lottery.ballSold', { n: i + 1, name: text.player(owner) });
    return {
      id: String(i),
      rect: { x: c.x, y: c.y - BOARD_TOP, w: c.w, h: c.h },
      label,
      title: label,
      pressed: pick === i,
      disabled: owner !== null,
      hit: 'none',
      testId: `lottery-ball-${i + 1}`,
      onActivate: () => setPick(i),
    };
  });

  return (
    <DecisionStage
      ctl={ctl}
      decision={d}
      view={view}
      map={map}
      isMine={isMine}
      label={t('dlg.lottery.title')}
      onClose={() => {
        if (pick !== null) setPick(null);
        else ctl.send({ type: 'SKIP' });
      }}
      closeButton={false}
      backdrop="opaque"
      attrs={{ 'data-pick': pick === null ? '' : String(pick + 1) }}
    >
      <Sprite sheet={VENUE_KEYS.lotteryBet} frame={LOTTERY.bg} x={0} y={0} origin="topLeft" />

      {/* 猫女与表情 */}
      <Sprite sheet={VENUE_KEYS.lotteryBet} frame={g.frame} x={g.x} y={g.y} origin="topLeft" testId="lottery-girl" />
      {blink && (
        <Sprite
          sheet={VENUE_KEYS.lotteryBet}
          frame={g.eyes.closed}
          x={g.x + g.eyes.dx}
          y={g.y + g.eyes.dy}
          origin="topLeft"
        />
      )}
      {talk >= 0 && (
        <Sprite
          sheet={VENUE_KEYS.lotteryBet}
          frame={g.mouth.frames[talk % g.mouth.frames.length]!}
          x={g.x + g.mouth.dx}
          y={g.y + g.mouth.dy}
          origin="topLeft"
        />
      )}

      {/* 气泡：规则、价格、已买张数 */}
      {pick === null && (
        <SceneLayer x={LOTTERY.balloon.x} y={LOTTERY.balloon.y} testId="lottery-balloon">
          <Sprite sheet={VENUE_KEYS.lotteryBet} frame={LOTTERY.balloon.frame} x={0} y={0} origin="topLeft" />
          <SceneText
            rect={LOTTERY.balloon.text}
            style={{ ...TEXT.bodyDark, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 2 }}
          >
            <p style={{ ...TEXT.bodyDark, fontSize: 15, lineHeight: '18px', fontWeight: 700 }}>
              {t('dlg.lottery.title')}
            </p>
            <p style={TEXT.bodyDark}>{t('dlg.lottery.rule')}</p>
            <p style={TEXT.bodyDark}>
              {t('dlg.lottery.price')} <Amount value={o.price} unit={t('cmp.unit.yuan')} />
            </p>
            <p style={TEXT.bodyDark} data-testid="lottery-mine" data-value={mine}>
              {t('dlg.lottery.mine', { n: mine })}
            </p>
            {short && (
              <p role="alert" style={{ ...TEXT.bodyDark, color: '#b01010' }}>
                {t('dlg.common.notEnoughCash')}
              </p>
            )}
          </SceneText>
        </SceneLayer>
      )}

      {/* 跑马灯：奖池 */}
      <VenueFlic
        flicKey={VENUE_KEYS.marquee}
        rect={LOTTERY.marquee}
        mode="loop"
        testId="lottery-marquee"
        fallback={<span className={v.flicFallback} />}
      />
      <SceneText
        rect={{
          x: LOTTERY.marquee.x + LOTTERY.marquee.text.x,
          y: LOTTERY.marquee.y + LOTTERY.marquee.text.y,
          w: LOTTERY.marquee.text.w,
          h: LOTTERY.marquee.text.h,
        }}
        style={{
          ...TEXT.number,
          color: '#ffe060',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
        }}
      >
        <span>{t('dlg.lottery.pool')}</span>
        <Amount value={o.pool} unit={t('cmp.unit.yuan')} testId="lottery-pool" />
      </SceneText>

      {/* 号码盘：已售压暗 + 买主小头；选号圈 */}
      {o.sold.map((owner, i) => {
        if (owner === null) return null;
        const c = lotteryCell(i);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: 号码就是下标
          <span key={i} data-testid={`lottery-sold-${i + 1}`} data-owner={owner}>
            <span
              className={v.soldMask}
              style={{ left: c.x + 2, top: c.y + 2, width: c.w - 4, height: c.h - 4 }}
              data-mine={owner === d.seat ? 'true' : 'false'}
            />
            <Sprite sheet={speakerSheet(charOf(owner))} frame={5} x={c.cx + 18} y={c.cy - 10} />
          </span>
        );
      })}
      {pick !== null && (
        <Sprite
          sheet={VENUE_KEYS.lotteryBet}
          frame={LOTTERY.ring}
          x={lotteryCell(pick).cx}
          y={lotteryCell(pick).cy}
          testId="lottery-ring"
        />
      )}
      <Hotspots
        x={0}
        y={BOARD_TOP}
        w={640}
        h={480 - BOARD_TOP}
        spots={spots}
        disabled={!ctl.interactive || pick !== null}
        label={t('dlg.lottery.numbers')}
        testId="lottery-grid"
      />
      {/* 手机与读屏：原生下拉框选号 */}
      <select
        className={v.picker}
        style={{ left: LOTTERY.picker.x, top: LOTTERY.picker.y, width: LOTTERY.picker.w }}
        aria-label={t('dlg.lottery.numbers')}
        value={pick === null ? '' : String(pick)}
        disabled={!ctl.interactive}
        onChange={(e) => setPick(e.currentTarget.value === '' ? null : Number(e.currentTarget.value))}
        data-testid="lottery-picker"
      >
        <option value="">{t('dlg.lottery.pickFirst')}</option>
        {free.map((i) => (
          <option key={i} value={String(i)}>
            {t('dlg.lottery.ballFree', { n: i + 1 })}
          </option>
        ))}
      </select>

      {/* 机选、不买（蓝条当底板） */}
      <PlateButton
        x={LOTTERY.bar.quick.x}
        y={LOTTERY.bar.quick.y}
        w={LOTTERY.bar.w}
        h={LOTTERY.bar.h}
        label={t('dlg.lottery.quick')}
        disabled={free.length === 0 || pick !== null}
        plate={{ sheet: VENUE_KEYS.lotteryBet, normal: LOTTERY.bar.frame }}
        onClick={() => setPick(quickPick(o.sold, props.random))}
        testId="lottery-quick"
        hitPad="up"
      />
      <PlateButton
        x={LOTTERY.bar.skip.x}
        y={LOTTERY.bar.skip.y}
        w={LOTTERY.bar.w}
        h={LOTTERY.bar.h}
        label={t('dlg.lottery.skip')}
        disabled={pick !== null}
        plate={{ sheet: VENUE_KEYS.lotteryBet, normal: LOTTERY.bar.frame }}
        onClick={() => ctl.send({ type: 'SKIP' })}
        testId="lottery-skip"
        hitPad="down"
      />

      {/* 确认：买 N 号？ */}
      {pick !== null && (
        <YesNoBox
          x={LOTTERY.confirm.x}
          y={LOTTERY.confirm.y}
          lines={short ? 3 : 2}
          onYes={() => ctl.send({ type: 'LOTTERY_BUY', number: pick })}
          onNo={() => setPick(null)}
          yesDisabled={short}
          yesLabel={t('dlg.lottery.buy', { n: pick + 1 })}
          noLabel={t('dlg.common.cancel')}
          yesTestId="lottery-buy"
          noTestId="lottery-cancel"
          testId="lottery-confirm"
        >
          <p style={TEXT.title}>{t('dlg.lottery.buy', { n: pick + 1 })}</p>
          <p>
            {t('dlg.lottery.price')} <Amount value={o.price} unit={t('cmp.unit.yuan')} />　{t('dlg.common.cash')}{' '}
            <Amount value={o.cash} unit={t('cmp.unit.yuan')} testId="lottery-cash" />
          </p>
          {short && (
            <p role="alert" style={TEXT.warn}>
              {t('dlg.common.notEnoughCash')}
            </p>
          )}
        </YesNoBox>
      )}
    </DecisionStage>
  );
}
