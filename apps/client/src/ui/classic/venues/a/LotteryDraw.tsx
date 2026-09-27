// 乐透开奖的原版演出（original-skin.md §4.2 场所屏：乐透开奖 Panel#15/16/17）：LOTTERY_DRAW 事件的弹窗（popupStore 的
// kind 'lottery'）在原版皮肤下换成这个 640×480 场景——开奖舞台底图（图0）、主持人（图1–6 六个姿势）与心形气泡（图22）、
// 摇奖机 FLC（Panel#16，推断落点 (182,105)）转动，随后爆炸框（图24 中奖 / 图23 无人中奖）里亮出两颗号码球（图37–46）、
// 中奖人的小头（图25–36）与一句话；没人买票时主持人举牌（图3）说「本月不开奖」。彩带 FLC（Panel#17）置信度 guess，
// 可用时才播。只读演出：不抢焦点、不挡点击（弹窗层的「跳过」照常可按）。
// 接入：PopupLayer 的 PopupBody 里 `case 'lottery'` 换成
//   <ClassicLotteryDraw spec={p} ms={p.realMs} minMs={p.minMs}
//     onSkip={() => usePopupStore.getState().skip(p.popupId)}
//     fallback={<LotteryDrawPopup spec={p} ms={p.realMs} />} />
// 它只在经典舞台之内、素材包里 LOTTERY_DRAW_KEYS 全部可用时画原版场景，否则原样画 fallback（整体回退）。
import { type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LooseT } from '../../../components/names';
import type { LotteryPopupSpec } from '../../../popups/popupStore';
import { useClassicAssets } from '../../assets';
import { useClassicBox } from '../../ClassicStage';
import { SceneLayer, Stage4x3 } from '../../common/Stage4x3';
import { prepareSceneKeys, sceneKeysStatus, scenePackClient } from '../../common/sceneAssets';
import { TEXT } from '../../common/textStyles';
import { Sprite } from '../../Sprite';
import { DRAW, type DrawPhase, drawBalls, drawPhase, VENUE_KEYS } from './layout';
import { PlateButton, SceneText, VenueFlic } from './parts';

/** 原版开奖演出依赖的素材（彩带 FLC 可选） */
export const LOTTERY_DRAW_KEYS: readonly string[] = [VENUE_KEYS.lotteryDraw, VENUE_KEYS.machine];

/** 素材准备的最长等待：超过就画 fallback（弹窗寿命只有几秒） */
export const DRAW_PREPARE_MS = 800;

export interface LotteryDrawSceneProps {
  spec: LotteryPopupSpec;
  /** 弹窗实际寿命（真实毫秒，已按倍速换算） */
  ms: number;
  /** 测试：固定阶段 */
  phase?: DrawPhase;
  /**
   * 跳过演出（给了才画「跳过」钮：演出场景盖住了弹窗层原来的跳过钮）；minMs 之后出现。
   * PopupLayer 接入时传 () => usePopupStore.getState().skip(p.popupId) 与 p.minMs
   */
  onSkip?: () => void;
  minMs?: number;
}

/** 最短展示时间过后才可以跳过 */
function useSkippable(minMs: number, enabled: boolean): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    setOk(false);
    const id = setTimeout(() => setOk(true), Math.max(0, minMs));
    return () => clearTimeout(id);
  }, [minMs, enabled]);
  return ok;
}

/** 阶段随时间推进（按弹窗寿命的比例切换） */
function usePhase(ms: number, hasNumber: boolean, fixed?: DrawPhase): DrawPhase {
  const [phase, setPhase] = useState<DrawPhase>(() => fixed ?? drawPhase(0, ms, hasNumber));
  useEffect(() => {
    if (fixed) {
      setPhase(fixed);
      return;
    }
    if (!hasNumber) return;
    const a = setTimeout(() => setPhase('spin'), Math.max(0, ms * DRAW.phase.spin));
    const b = setTimeout(() => setPhase('reveal'), Math.max(0, ms * DRAW.phase.reveal));
    return () => {
      clearTimeout(a);
      clearTimeout(b);
    };
  }, [ms, hasNumber, fixed]);
  return phase;
}

export function LotteryDrawScene({ spec, ms, phase: fixed, onSkip, minMs = 0 }: LotteryDrawSceneProps): ReactNode {
  const { t } = useTranslation();
  const lt = t as unknown as LooseT;
  const skippable = useSkippable(minMs, onSkip !== undefined);
  const hasNumber = spec.number !== null;
  const phase = usePhase(ms, hasNumber, fixed);
  const client = scenePackClient();
  const streamers = client?.usableEntry(VENUE_KEYS.streamers) ?? null;
  const won = spec.winner !== null;
  // 姿势：开场举手介绍（图1）→ 摇奖时侧身指向机器（图2）→ 中奖欢呼（图5）/ 没人中（图4 流汗）/ 不开奖举牌（图3）
  const pose = phase === 'intro' ? 1 : phase === 'spin' ? 2 : !hasNumber ? 3 : won ? 5 : 4;
  const [hw, hh] = DRAW.hostSize[pose - 1]!;
  const hx = DRAW.host.right - hw;
  const hy = DRAW.host.bottom - hh;
  const balls = spec.number === null ? null : drawBalls(spec.number);

  return (
    <Stage4x3
      testId="lottery-draw-scene"
      label={spec.title}
      readOnly
      interactive={onSkip !== undefined}
      backdrop="opaque"
      attrs={{ 'data-phase': phase, 'data-number': spec.number === null ? '' : String(spec.number) }}
    >
      <Sprite sheet={VENUE_KEYS.lotteryDraw} frame={DRAW.bg} x={0} y={0} origin="topLeft" />
      {phase === 'spin' && (
        <VenueFlic flicKey={VENUE_KEYS.machine} rect={DRAW.machine} mode="loop" testId="lottery-draw-machine" />
      )}
      <Sprite sheet={VENUE_KEYS.lotteryDraw} frame={pose} x={hx} y={hy} origin="topLeft" testId="lottery-draw-host" />

      {phase !== 'reveal' && (
        <SceneLayer x={DRAW.balloon.x} y={DRAW.balloon.y}>
          <Sprite sheet={VENUE_KEYS.lotteryDraw} frame={DRAW.balloon.frame} x={0} y={0} origin="topLeft" />
          <SceneText
            rect={DRAW.balloon.text}
            style={{
              ...TEXT.bodyDark,
              fontSize: 16,
              lineHeight: '20px',
              fontWeight: 700,
              display: 'grid',
              placeItems: 'center',
              textAlign: 'center',
            }}
          >
            {spec.title}
          </SceneText>
        </SceneLayer>
      )}

      {phase === 'reveal' && hasNumber && (
        <>
          {streamers && (
            <VenueFlic
              flicKey={VENUE_KEYS.streamers}
              rect={DRAW.streamers}
              mode="once"
              testId="lottery-draw-streamers"
            />
          )}
          <Sprite
            sheet={VENUE_KEYS.lotteryDraw}
            frame={won ? DRAW.burst.win : DRAW.burst.none}
            x={DRAW.burst.x}
            y={DRAW.burst.y}
          />
          {balls?.map((b, i) => (
            <Sprite
              // biome-ignore lint/suspicious/noArrayIndexKey: 十位、个位
              key={i}
              sheet={VENUE_KEYS.lotteryDraw}
              frame={DRAW.ball0 + b}
              x={DRAW.balls.xs[i]!}
              y={DRAW.balls.y}
            />
          ))}
          {spec.winner && (
            <Sprite
              sheet={VENUE_KEYS.lotteryDraw}
              frame={DRAW.head0 + spec.winner.character}
              x={DRAW.burst.x}
              y={DRAW.winnerY}
              testId="lottery-draw-winner"
            />
          )}
        </>
      )}
      {phase === 'reveal' && (
        <SceneText
          rect={
            hasNumber
              ? spec.winner
                ? DRAW.subtitle
                : { ...DRAW.subtitle, y: DRAW.subtitle.y - 20 }
              : { x: hx + 14, y: hy + 96, w: 108, h: 120 }
          }
          style={{
            ...TEXT.bodyDark,
            fontWeight: 700,
            display: 'grid',
            placeItems: 'center',
            textAlign: 'center',
          }}
        >
          <p data-testid="lottery-subtitle">{spec.subtitle}</p>
        </SceneText>
      )}
      {/* 号码（读屏 / 测试）：揭晓后给出 */}
      <span className="visually-hidden" data-testid="lottery-number" data-value={spec.number ?? ''} aria-live="polite">
        {phase === 'reveal' && spec.number !== null ? t('dlg.lottery.ballFree', { n: spec.number }) : ''}
      </span>
      {onSkip && skippable && (
        // 只读场景整体不接收指针（不挡棋盘），这颗钮单独接收
        <span style={{ pointerEvents: 'auto' }}>
          <PlateButton
            x={DRAW.skip.x}
            y={DRAW.skip.y}
            w={DRAW.skip.w}
            h={DRAW.skip.h}
            label={lt('events:popup.skip')}
            onClick={onSkip}
            testId="lottery-draw-skip"
          />
        </span>
      )}
    </Stage4x3>
  );
}

export interface ClassicLotteryDrawProps extends LotteryDrawSceneProps {
  /** 不在经典舞台之内、或素材不可用时画的（程序化 LotteryDrawPopup） */
  fallback: ReactNode;
}

type Gate = 'pending' | 'classic' | 'fallback';

/** 原版开奖演出的开关：经典舞台之内 + 素材可用 → 原版场景；否则 fallback。素材加载超过 DRAW_PREPARE_MS 也回退 */
export function ClassicLotteryDraw({ fallback, ...props }: ClassicLotteryDrawProps): ReactNode {
  const box = useClassicBox();
  const packId = useClassicAssets((s) => s.packId);
  const initial = (): Gate => {
    if (!box || packId === null) return 'fallback';
    const st = sceneKeysStatus(LOTTERY_DRAW_KEYS, scenePackClient());
    return st === 'ready' ? 'classic' : st === 'missing' ? 'fallback' : 'pending';
  };
  const [gate, setGate] = useState<Gate>(initial);

  useEffect(() => {
    if (gate !== 'pending') return;
    let live = true;
    const timer = setTimeout(() => {
      if (live) setGate('fallback');
      live = false;
    }, DRAW_PREPARE_MS);
    prepareSceneKeys(LOTTERY_DRAW_KEYS, scenePackClient()).then(
      (ok) => {
        if (!live) return;
        live = false;
        clearTimeout(timer);
        setGate(ok ? 'classic' : 'fallback');
      },
      () => {
        if (!live) return;
        live = false;
        clearTimeout(timer);
        setGate('fallback');
      },
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [gate]);

  if (gate === 'classic') return <LotteryDrawScene {...props} />;
  if (gate === 'fallback') return fallback;
  return null;
}

/** 预取开奖演出的素材（投注场景出现时调用；失败无妨，开奖时再判定） */
export function preloadLotteryDraw(): void {
  const client = scenePackClient();
  if (!client) return;
  void prepareSceneKeys(LOTTERY_DRAW_KEYS, client).catch(() => undefined);
}
