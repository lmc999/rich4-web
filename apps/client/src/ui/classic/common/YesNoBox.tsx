// 原版 YES/NO 确认框（ui.md §2.1：Data#399 = ui.yesno 三帧 96×48「常态 / YES 亮 / NO 亮」，置于 Data#476 图5 = ui.common
// 宝石消息框 195×133（锚点 97,81）之内；可带讲话头像与表情 map#15–26 + 气泡，见 speaker）。消息框按三宫格纵向拉伸以容纳
// 更多行正文（宽度固定 195）；
// YES / NO 各是一颗透明 <button>（左半 YES、右半 NO；DOM 可访问、data-testid 可配），悬停 / 键盘焦点时换亮帧；
// 焦点在场景内时 Y / N 键与 ← → 可用（Y / N 不认落在 body 上的按键）。手机横屏时 YES 向左、NO 向右各补到 ≥44px。
// 位置：消息框画点缺省 (220, 333)（ui 调研样稿 mockup-main-640x480 目视，visual）；YES/NO 水平居中、底边落在绳纹边之上
// （框内 (49, 高−60)，用真实素材包截图目视调整）。正文从 y=36 起，缺省高度放 2 行，行数多时框向下拉长。
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { Rect } from '../layout';
import { Sprite, useSpriteFrame } from '../Sprite';
import s from './common.module.css';
import { isTextEntry } from './focus';
import { CLASSIC_FRAMES } from './frames';
import { Hotspots } from './Hotspots';
import { NineSlice } from './NineSlice';
import { SpeakerBubble, type SpeakerBubbleProps } from './SpeakerBubble';
import { useEnsureSceneSprites } from './sceneAssets';
import { SCENE_H } from './stage';
import { TEXT } from './textStyles';

export const YESNO_SHEET = 'ui.yesno';
export const MESSAGE_SHEET = 'ui.common';

export const YESNO = {
  w: 96,
  h: 48,
  /** YES/NO 左上角距消息框左边 */
  dx: 49,
  /** YES/NO 顶边距消息框底边（YES/NO 整个落在棕色内框里，底边留出 12px 的绳纹边） */
  fromBottom: 60,
  frames: { normal: 0, yes: 1, no: 2 },
} as const;

/** 消息框：锚点、缺省画点、正文区（相对框左上角） */
export const MESSAGE_BOX = {
  w: 195,
  h: 133,
  ax: 97,
  ay: 81,
  at: { x: 220, y: 333 },
  text: { x: 14, y: 36, w: 167 },
  /** 正文行高（12px 字 + 3） */
  lineH: 15,
  /** 缺省高度能放下的正文行数 */
  baseLines: 2,
} as const;

/** 放得下 lines 行正文的消息框高度 */
export function messageBoxHeight(lines: number): number {
  return MESSAGE_BOX.h + Math.max(0, Math.ceil(lines) - MESSAGE_BOX.baseLines) * MESSAGE_BOX.lineH;
}

/** 消息框与 YES/NO 的布局（场景坐标）；框超出场景底边时整体上移 */
export function yesNoLayout(
  x: number,
  y: number,
  lines: number,
): { box: Rect; text: Rect; yesno: Rect; yes: Rect; no: Rect } {
  const h = messageBoxHeight(lines);
  const left = x - MESSAGE_BOX.ax;
  const top = Math.max(0, Math.min(y - MESSAGE_BOX.ay, SCENE_H - 4 - h));
  const yn = { x: left + YESNO.dx, y: top + h - YESNO.fromBottom, w: YESNO.w, h: YESNO.h };
  return {
    box: { x: left, y: top, w: MESSAGE_BOX.w, h },
    text: {
      x: left + MESSAGE_BOX.text.x,
      y: top + MESSAGE_BOX.text.y,
      w: MESSAGE_BOX.text.w,
      h: yn.y - 4 - (top + MESSAGE_BOX.text.y),
    },
    yesno: yn,
    yes: { x: 0, y: 0, w: YESNO.w / 2, h: YESNO.h },
    no: { x: YESNO.w / 2, y: 0, w: YESNO.w / 2, h: YESNO.h },
  };
}

export interface YesNoBoxProps {
  /** 消息框画点（场景坐标；缺省 (220,333)） */
  x?: number;
  y?: number;
  /** 正文行数（决定消息框高度；缺省 2） */
  lines?: number;
  /** 正文（DOM 描边字） */
  children?: ReactNode;
  onYes: () => void;
  onNo: () => void;
  yesDisabled?: boolean;
  noDisabled?: boolean;
  /** 读屏名称（例如「购买」「不买」） */
  yesLabel: string;
  noLabel: string;
  yesTestId?: string;
  noTestId?: string;
  testId?: string;
  /** Y / N 与 ← → 快捷键（缺省开） */
  hotkeys?: boolean;
  /** 讲话头像（角色、表情）与气泡；不给则只有消息框 */
  speaker?: SpeakerBubbleProps;
}

export function YesNoBox({
  x = MESSAGE_BOX.at.x,
  y = MESSAGE_BOX.at.y,
  lines = MESSAGE_BOX.baseLines,
  children,
  onYes,
  onNo,
  yesDisabled = false,
  noDisabled = false,
  yesLabel,
  noLabel,
  yesTestId,
  noTestId,
  testId,
  hotkeys = true,
  speaker,
}: YesNoBoxProps): ReactNode {
  useEnsureSceneSprites([YESNO_SHEET, MESSAGE_SHEET]);
  const art = useSpriteFrame(YESNO_SHEET, 0);
  const [hot, setHot] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const L = yesNoLayout(x, y, lines);

  // Y / N：焦点在所属场景里（场景根或场景内的控件，不含文字输入框）时；← →：另外焦点在 body 上时也可用（只移焦点）。
  // Y / N 会直接提交决定，所以不认落在 body 上的按键：场景没抢焦点（玩家在聊天框里打字）或输入框消失后，
  // 接着敲的字母不能变成「是 / 否」。
  useEffect(() => {
    if (!hotkeys) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      const el = ref.current;
      if (!el) return;
      const scope = el.closest('[data-scene]') ?? el;
      const t = e.target;
      const inScope = t instanceof Node && scope.contains(t);
      const onBody = t === null || t === document.body || t === document.documentElement;
      if (!inScope && !onBody) return;
      if (t instanceof Element && isTextEntry(t)) return;
      const btn = (id: 'yes' | 'no'): HTMLButtonElement | null =>
        el.querySelector<HTMLButtonElement>(`button[data-spot="${id}"]`);
      const k = e.key.toLowerCase();
      if (k === 'y' || k === 'n') {
        if (!inScope) return;
        const b = btn(k === 'y' ? 'yes' : 'no');
        if (b && !b.disabled) {
          e.preventDefault();
          b.click();
        }
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const b = btn(e.key === 'ArrowLeft' ? 'yes' : 'no');
        if (b && !b.disabled) {
          e.preventDefault();
          b.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hotkeys]);

  const frame = hot === 'yes' && !yesDisabled ? YESNO.frames.yes : hot === 'no' && !noDisabled ? YESNO.frames.no : 0;

  return (
    <div className={s.yesno} ref={ref} style={{ left: 0, top: 0 }} data-testid={testId} data-hot={hot ?? ''}>
      {speaker && <SpeakerBubble {...speaker} />}
      <NineSlice spec={CLASSIC_FRAMES.messageBox} x={L.box.x} y={L.box.y} w={L.box.w} h={L.box.h} />
      <div
        className={s.msgText}
        style={{ ...TEXT.body, left: L.text.x, top: L.text.y, width: L.text.w, height: L.text.h }}
        data-testid={testId ? `${testId}-text` : undefined}
      >
        {children}
      </div>
      {art ? (
        <Sprite sheet={YESNO_SHEET} frame={frame} x={L.yesno.x} y={L.yesno.y} origin="topLeft" />
      ) : (
        <span
          className={s.yesnoFallback}
          style={{ left: L.yesno.x, top: L.yesno.y, width: L.yesno.w, height: L.yesno.h }}
          aria-hidden="true"
        >
          <span>YES</span>
          <span>NO</span>
        </span>
      )}
      {yesDisabled && (
        <span
          className={s.yesMask}
          style={{ left: L.yesno.x, top: L.yesno.y, width: L.yes.w, height: L.yes.h }}
          aria-hidden="true"
        />
      )}
      <Hotspots
        x={L.yesno.x}
        y={L.yesno.y}
        w={L.yesno.w}
        h={L.yesno.h}
        mask={null}
        onHotChange={setHot}
        spots={[
          {
            id: 'yes',
            rect: L.yes,
            label: yesLabel,
            disabled: yesDisabled,
            testId: yesTestId,
            hit: 'left',
            onActivate: onYes,
          },
          {
            id: 'no',
            rect: L.no,
            label: noLabel,
            disabled: noDisabled,
            testId: noTestId,
            hit: 'right',
            onActivate: onNo,
          },
        ]}
      />
    </div>
  );
}
