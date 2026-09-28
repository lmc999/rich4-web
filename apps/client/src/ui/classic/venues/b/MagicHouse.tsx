// MAGIC_CAST 的原版场景：魔法屋（Panel#18 六芒星底图、女巫、12 个效果图标、提示框；Panel#19 命中掩膜 13 区；Panel#20 施法 FLC）。
// - 女巫站在中心六边形（掩膜区 13），水晶球里是这次抽到的条件图标（图 11+条件）；左上角的讲话框写着条件与被点名的玩家；
// - 12 个星区（掩膜区 e+1）对应 12 种效果：指针悬停 / 键盘焦点时点亮该效果的图标（图 23+e），在图标旁弹出提示框
//   （图 6/7/9/10，尾巴指向图标）写效果名与说明；点选后在中间弹出 YES/NO 确认框；YES → 施法 FLC 播完后提交 MAGIC_CAST；
// - 点在星区任意位置都算（按掩膜逐像素判定）；每个效果另有一颗以图标为中心的透明按钮（Tab 可达，data-testid 与程序化
//   对话框同名：magic-effect-<e>；确认为 magic-confirm），掩膜加载不到时按这些按钮的矩形命中；
// - 不能放弃（原版必须施法）：没有关闭钮；Esc 取消当前点选。倒计时快到时不播 FLC，直接提交。
import type { MagicEffectId } from '@rich4/shared/engine';
import { type MouseEvent, type ReactNode, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useGameText } from '../../../components/names';
import type { DecisionProps } from '../../../decisions/types';
import { useDecision } from '../../../decisions/useDecision';
import s from '../../common/common.module.css';
import { DecisionStage } from '../../common/DecisionStage';
import { type HotspotSpec, Hotspots } from '../../common/Hotspots';
import { localPoint } from '../../common/hitTest';
import { maskRegion, useSceneMask } from '../../common/mask';
import { BUBBLE_LAYOUT, COMMON_SHEET } from '../../common/SpeakerBubble';
import { classicText, TEXT } from '../../common/textStyles';
import { YESNO_SHEET, YesNoBox } from '../../common/YesNoBox';
import type { RequiredKeys } from '../../decisions/scene';
import { Sprite } from '../../Sprite';
import {
  BALL_AT,
  COND_BUBBLE_AT,
  CONFIRM_AT,
  conditionFrame,
  effectButtonRect,
  effectFrame,
  effectRegion,
  HINT,
  hintPlacement,
  MAGIC_CAST_FLC,
  MAGIC_FRAME,
  MAGIC_ICON_AT,
  MAGIC_MASK,
  MAGIC_SHEET,
  regionEffect,
  WITCH_AT,
  WITCH_FACE,
} from './magicLayout';
import { SceneFlic } from './shared';
import v from './venues.module.css';

/** 依赖的素材：魔法屋图集、YES/NO、讲话框与消息框（掩膜与施法 FLC 可选：缺了按矩形命中、不播 FLC） */
export const requiredKeys: RequiredKeys<'MAGIC_CAST'> = [MAGIC_SHEET, YESNO_SHEET, COMMON_SHEET];

/** 施法 FLC 约 1.8 秒；剩余时间不够这么多时直接提交 */
export const CAST_FLC_BUDGET_MS = 4000;

const SPEECH_TAIL_BR = 3;

export default function MagicHouseScene(props: DecisionProps<'MAGIC_CAST'>): ReactNode {
  const { t } = useTranslation();
  const { view, map, isMine, decision: d } = props;
  const ctl = useDecision(props);
  const text = useGameText(view, map);
  const o = d.options;
  const mask = useSceneMask(MAGIC_MASK);
  const [pick, setPick] = useState<MagicEffectId | null>(null);
  const [hot, setHot] = useState<MagicEffectId | null>(null);
  /** 施法中：效果与是否播 FLC（倒计时快到时不播） */
  const [casting, setCasting] = useState<{ e: MagicEffectId; flc: boolean } | null>(null);
  const allowed = useMemo(() => new Set<MagicEffectId>(o.effects), [o.effects]);
  const includesMe = o.targets.includes(d.seat);
  const busy = casting !== null;
  const canPick = ctl.interactive && !busy;
  const cond = text.magicCondition(o.condition);
  const names = o.targets.map((seat) => ({ seat, name: text.player(seat) }));

  const choose = (e: MagicEffectId | null): void => {
    if (!canPick) return;
    if (e === null || allowed.has(e)) setPick(e);
  };

  const submit = (e: MagicEffectId): void => {
    const ok = ctl.send({ type: 'MAGIC_CAST', effect: e }, (accepted) => {
      if (!accepted) setCasting(null);
    });
    if (!ok) setCasting(null);
  };

  const cast = (): void => {
    if (pick === null || !canPick) return;
    // 倒计时快到了：不播 FLC，直接提交
    if (ctl.remainingMs !== null && ctl.remainingMs < CAST_FLC_BUDGET_MS) {
      setCasting({ e: pick, flc: false });
      submit(pick);
      return;
    }
    setCasting({ e: pick, flc: true });
  };

  const onFlicDone = (): void => {
    if (casting !== null && !ctl.locked) submit(casting.e);
  };

  // 星区里按钮之外的地方：按掩膜取区号（键盘与读屏走 12 颗按钮）
  const onAreaClick = (e: MouseEvent<HTMLDivElement>): void => {
    if (!canPick || !mask) return;
    if (e.target instanceof Element && e.target.closest('[data-spot]')) return;
    const p = localPoint(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY, 640, 480);
    if (!p) return;
    const eff = regionEffect(maskRegion(mask, p.x, p.y));
    if (eff !== null) choose(eff);
  };

  const spots: HotspotSpec[] = o.effects.map((e) => ({
    id: String(e),
    rect: effectButtonRect(e),
    region: effectRegion(e),
    label: `${text.magicEffect(e)}：${text.magicEffectDesc(e)}`,
    testId: `magic-effect-${e}`,
    pressed: pick === e,
    onActivate: () => choose(e),
  }));

  const hint = hot !== null && hot !== pick && allowed.has(hot) && !busy ? hot : null;
  const hp = hint === null ? null : hintPlacement(hint);
  const lit = new Set<MagicEffectId>();
  if (hot !== null && allowed.has(hot)) lit.add(hot);
  if (pick !== null) lit.add(pick);
  if (casting !== null) lit.add(casting.e);

  const bubbleLeft = COND_BUBBLE_AT.x - BUBBLE_LAYOUT.speech.w;
  const bubbleTop = COND_BUBBLE_AT.y - BUBBLE_LAYOUT.speech.h;
  const bt = BUBBLE_LAYOUT.speech.text;
  const confirmLines =
    pick === null ? 0 : 1 + Math.ceil(text.magicEffectDesc(pick).length / 13) + 1 + (includesMe ? 1 : 0);

  return (
    <DecisionStage
      ctl={ctl}
      decision={d}
      view={view}
      map={map}
      isMine={isMine}
      label={`${t('dlg.magic.title')}：${t('dlg.magic.condition', { cond })}`}
      backdrop="opaque"
      closeButton={false}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && pick !== null && !busy) {
          e.preventDefault();
          setPick(null);
        }
      }}
      attrs={{
        'data-venue': 'magic',
        'data-pick': pick === null ? '' : String(pick),
        'data-casting': busy ? 'true' : 'false',
      }}
    >
      <div className={v.deco}>
        <Sprite sheet={MAGIC_SHEET} frame={MAGIC_FRAME.bg} x={0} y={0} origin="topLeft" />
        {busy ? (
          <Sprite sheet={MAGIC_SHEET} frame={MAGIC_FRAME.witchCast} x={182} y={142} origin="topLeft" />
        ) : (
          <>
            <Sprite sheet={MAGIC_SHEET} frame={MAGIC_FRAME.witch} x={WITCH_AT.x} y={WITCH_AT.y} origin="topLeft" />
            <Sprite
              sheet={MAGIC_SHEET}
              frame={MAGIC_FRAME.eyes}
              x={WITCH_AT.x + WITCH_FACE.eyes.x}
              y={WITCH_AT.y + WITCH_FACE.eyes.y}
              origin="topLeft"
              className={v.blink}
            />
            {hint !== null && (
              <Sprite
                sheet={MAGIC_SHEET}
                frame={MAGIC_FRAME.mouthOpen}
                x={WITCH_AT.x + WITCH_FACE.mouthOpen.x}
                y={WITCH_AT.y + WITCH_FACE.mouthOpen.y}
                origin="topLeft"
                className={v.talk}
              />
            )}
            <Sprite
              sheet={MAGIC_SHEET}
              frame={conditionFrame(o.condition)}
              x={BALL_AT.x}
              y={BALL_AT.y}
              className={v.ball}
              testId="magic-ball"
            />
          </>
        )}
        {[...lit].map((e) => (
          <Sprite
            key={e}
            sheet={MAGIC_SHEET}
            frame={effectFrame(e)}
            x={MAGIC_ICON_AT[e]![0]}
            y={MAGIC_ICON_AT[e]![1]}
            testId={`magic-lit-${e}`}
          />
        ))}
      </div>

      {/* 星区：整幅按掩膜命中（点在按钮之外也算），12 颗按钮以图标为中心 */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: 指针在按钮之外的像素命中；键盘走里面的按钮 */}
      <div style={{ position: 'absolute', left: 0, top: 0, width: 640, height: 480 }} onClick={onAreaClick}>
        <Hotspots
          x={0}
          y={0}
          w={640}
          h={480}
          maskKey={MAGIC_MASK}
          spots={spots}
          disabled={!canPick}
          label={t('dlg.magic.title')}
          testId="magic-star"
          onHotChange={(id) => setHot(id === null ? null : (Number(id) as MagicEffectId))}
        />
      </div>

      {/* 左上角讲话框：女巫点名的条件与名单（尾巴指向女巫） */}
      <div className={v.deco}>
        <Sprite sheet={COMMON_SHEET} frame={SPEECH_TAIL_BR} x={COND_BUBBLE_AT.x} y={COND_BUBBLE_AT.y} />
        <div
          className={v.box}
          style={{
            ...classicText({ size: 12, lineHeight: 14 }),
            left: bubbleLeft + bt.x - 8,
            top: bubbleTop + bt.y - 6,
            width: bt.w + 16,
            height: bt.h + 12,
          }}
        >
          <p data-testid="magic-condition">{t('dlg.magic.condition', { cond })}</p>
          <p data-testid="magic-targets" data-targets={o.targets.join(',')}>
            {names.map((n, i) => (
              <span key={n.seat} style={n.seat === d.seat ? { color: '#ff9a8a' } : undefined}>
                {i > 0 ? '、' : ''}
                {n.name}
              </span>
            ))}
          </p>
        </div>
      </div>

      {/* 悬停提示框：效果名与说明 */}
      {hp && hint !== null && (
        <div className={v.deco} data-testid="magic-hint" data-effect={hint}>
          <Sprite sheet={MAGIC_SHEET} frame={hp.frame} x={hp.x} y={hp.y} origin="topLeft" />
          <div
            className={v.box}
            style={{
              ...TEXT.small,
              left: hp.x + HINT.text.x,
              top: hp.y + HINT.text.y,
              width: HINT.text.w,
              height: HINT.text.h,
            }}
          >
            <p style={classicText({ size: 12, color: '#ffe060', bold: true, lineHeight: 16 })}>
              {text.magicEffect(hint)}
            </p>
            <p>{text.magicEffectDesc(hint)}</p>
          </div>
        </div>
      )}

      {/* 确认：施放这个魔法吗？ */}
      {pick !== null && !busy && (
        <YesNoBox
          x={CONFIRM_AT.x}
          y={CONFIRM_AT.y}
          lines={confirmLines}
          onYes={cast}
          onNo={() => setPick(null)}
          yesDisabled={!ctl.interactive}
          yesLabel={t('dlg.magic.cast', { name: text.magicEffect(pick) })}
          noLabel={t('dlg.common.cancel')}
          yesTestId="magic-confirm"
          noTestId="magic-cancel"
          testId="magic-confirm-box"
        >
          <p style={TEXT.title}>{text.magicEffect(pick)}</p>
          <p>{text.magicEffectDesc(pick)}</p>
          <p>
            {'→ '}
            {names.map((n) => n.name).join('、')}
          </p>
          {includesMe && <p style={TEXT.warn}>{t('dlg.magic.includesMe')}</p>}
        </YesNoBox>
      )}

      {/* 施法 FLC（整幅，不透明）：播完才提交 */}
      <SceneFlic
        flicKey={MAGIC_CAST_FLC}
        start={casting?.flc === true}
        onDone={onFlicDone}
        w={640}
        h={480}
        testId="magic-cast-flic"
      />

      {/* 读屏：条件、名单与可选效果 */}
      <div className={s.srOnly}>
        <p>{t('dlg.magic.condition', { cond })}</p>
        {includesMe && <p>{t('dlg.magic.includesMe')}</p>}
        <p>{pick === null ? t('dlg.magic.pickFirst') : text.magicEffect(pick)}</p>
      </div>
    </DecisionStage>
  );
}
