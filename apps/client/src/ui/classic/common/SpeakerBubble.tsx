// 讲话头像 + 讲话框（ui.md §2.1：讲话头像 map#15–26 = portrait.speaker.<角色>，图0 大头、图1–4 表情、图5 小头，
// 「贴 (170,130)，图号 = 表情+1」——表情帧是脸部小图，按同一画点叠在大头上；讲话框 Data#476 = ui.common：
// 图0–3 四种尾巴方向的方框 139×116（锚点在尾巴尖所在的角）、图6 云形气泡 210×154（锚点近中心）。
// 文字用 DOM 描边字叠在框内。云形气泡相对头像的偏移按样稿目视（visual）。
import type { ReactNode } from 'react';
import { Sprite, useSpriteFrame } from '../Sprite';
import s from './common.module.css';
import { useEnsureSceneSprites } from './sceneAssets';
import { TEXT } from './textStyles';

export const COMMON_SHEET = 'ui.common';

/** 讲话头像的精灵键 */
export function speakerSheet(character: number): string {
  return `portrait.speaker.${Math.min(11, Math.max(0, Math.trunc(character)))}`;
}

/** 头像画点（ui.md：贴 (170,130)） */
export const SPEAKER_HEAD_AT = { x: 170, y: 130 } as const;

export type BubbleKind = 'cloud' | 'speech' | 'none';

/** 讲话框图号：0 尾巴左上、1 左下、2 右上、3 右下（锚点 = 尾巴尖） */
export type SpeechTail = 0 | 1 | 2 | 3;

/** 气泡里放文字的矩形（相对气泡左上角）与相对头像画点的缺省偏移 */
export const BUBBLE_LAYOUT = {
  cloud: { frame: 6, w: 210, h: 154, ax: 98, ay: 69, text: { x: 30, y: 30, w: 150, h: 84 }, offset: { x: 93, y: 39 } },
  speech: { w: 139, h: 116, text: { x: 26, y: 22, w: 88, h: 72 } },
} as const;

/** 各尾巴方向的锚点（尾巴尖）与相对头像画点的缺省偏移（头像右侧 / 上下） */
const TAILS: Readonly<Record<SpeechTail, { ax: number; ay: number; offset: { x: number; y: number } }>> = {
  0: { ax: 0, ay: 0, offset: { x: 30, y: -10 } },
  1: { ax: 0, ay: 116, offset: { x: 30, y: 10 } },
  2: { ax: 139, ay: 0, offset: { x: -30, y: -10 } },
  3: { ax: 139, ay: 116, offset: { x: -30, y: 10 } },
};

export interface SpeakerBubbleProps {
  /** 角色号 0–11 */
  character: number;
  /** 表情 0–3（叠图1–4）；null 只画大头 */
  expression?: number | null;
  /** 头像画点（缺省 (170,130)） */
  x?: number;
  y?: number;
  bubble?: BubbleKind;
  /** 讲话框尾巴方向（bubble = speech 时） */
  tail?: SpeechTail;
  /** 气泡画点（缺省按头像画点加偏移） */
  bubbleAt?: { x: number; y: number };
  /** 气泡里的文字 */
  children?: ReactNode;
  testId?: string;
}

export function SpeakerBubble({
  character,
  expression = null,
  x = SPEAKER_HEAD_AT.x,
  y = SPEAKER_HEAD_AT.y,
  bubble = 'cloud',
  tail = 0,
  bubbleAt,
  children,
  testId,
}: SpeakerBubbleProps): ReactNode {
  const sheet = speakerSheet(character);
  useEnsureSceneSprites([sheet, COMMON_SHEET]);
  const head = useSpriteFrame(sheet, 0);
  const bubbleFrame = useSpriteFrame(COMMON_SHEET, bubble === 'cloud' ? BUBBLE_LAYOUT.cloud.frame : tail);
  const face = expression === null ? null : Math.min(4, Math.max(1, Math.trunc(expression) + 1));

  let box: {
    left: number;
    top: number;
    w: number;
    h: number;
    text: { x: number; y: number; w: number; h: number };
  } | null = null;
  if (bubble === 'cloud') {
    const L = BUBBLE_LAYOUT.cloud;
    const at = bubbleAt ?? { x: x + L.offset.x, y: y + L.offset.y };
    const ax = bubbleFrame?.ax ?? L.ax;
    const ay = bubbleFrame?.ay ?? L.ay;
    box = { left: at.x - ax, top: at.y - ay, w: L.w, h: L.h, text: L.text };
  } else if (bubble === 'speech') {
    const T = TAILS[tail];
    const at = bubbleAt ?? { x: x + T.offset.x, y: y + T.offset.y };
    box = {
      left: at.x - (bubbleFrame?.ax ?? T.ax),
      top: at.y - (bubbleFrame?.ay ?? T.ay),
      w: BUBBLE_LAYOUT.speech.w,
      h: BUBBLE_LAYOUT.speech.h,
      text: BUBBLE_LAYOUT.speech.text,
    };
  }

  return (
    <div className={s.speaker} data-testid={testId} data-character={character} data-bubble={bubble}>
      {box &&
        (bubbleFrame ? (
          <Sprite
            sheet={COMMON_SHEET}
            frame={bubble === 'cloud' ? BUBBLE_LAYOUT.cloud.frame : tail}
            x={box.left}
            y={box.top}
            origin="topLeft"
          />
        ) : (
          <span
            className={s.cloudFallback}
            style={{ left: box.left + 8, top: box.top + 8, width: box.w - 16, height: box.h - 24 }}
            aria-hidden="true"
          />
        ))}
      {head ? (
        <>
          <Sprite sheet={sheet} frame={0} x={x} y={y} />
          {face !== null && <Sprite sheet={sheet} frame={face} x={x} y={y} />}
        </>
      ) : (
        <span
          className={s.headFallback}
          style={{ left: x - 32, top: y - 32, background: '#f3c89a' }}
          aria-hidden="true"
        />
      )}
      {box && children !== undefined && (
        <div
          className={s.bubbleText}
          style={{
            ...(bubble === 'cloud' ? TEXT.bodyDark : TEXT.body),
            left: box.left + box.text.x,
            top: box.top + box.text.y,
            width: box.text.w,
            height: box.text.h,
          }}
          data-testid={testId ? `${testId}-text` : undefined}
        >
          {children}
        </div>
      )}
    </div>
  );
}
