// 原版通用对话框的公共部件（original-skin.md §4.2 通用；ui.md §2.1–§2.2）：
// - MessageBox / ConfirmBox：宝石消息框（Data#476 图5，三宫格纵向拉伸）+ 0–2 颗 YES/NO 钮（Data#399；只要一颗时把 96×48 的
//   YES/NO 图按半边裁开用，悬停换亮帧）；两颗时直接用公共的 YesNoBox。
// - PlateButton：没有原版图的次要操作（投降、股市、公布栏…）用木框金边的文字钮（与 ClassicButton 缺图时的画法一致）。
// - CardGrid：卡片欄 / 道具欄（Panel#11 图0 青绿 / 图1 砖红，412×180，5×3 格；格子 78×54、步距 80×56，逐像素统计的网格线）。
//   卡片没有小图标，格里只写卡名（ui.md §2.2）；道具格画道具图标 Panel#11 图2–14（帧 = 道具号 + 1）与持有数。
// - PlayerPicker：选择玩家窗（Data#477 图0/1/2 = 2/3/4 格，锚点居中；格子 72×72、步距 80，左上 (12,12)）+ 72×72 头像
//   （Data#2 = portrait.face72，帧 = 角色号）；选中格旁画原版手形光标（Data#0 图27，锚点在指尖）。
// - CardArt：卡片插画（Data#530–559 = card.<k>，165×256）；素材不可用时不画（不以程序化卡面顶替）。
// - useBoardCursor：目标选择时把棋盘视窗的鼠标光标换成原版光标（Data#0：手形 27、白准星 6、红靶 9、箭头 41）。
import type { CardId, ItemId, SeatIndex } from '@rich4/shared/engine';
import type { GameView } from '@rich4/shared/view';
import clsx from 'clsx';
import { type CSSProperties, type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatMoney } from '../../../presentation/names';
import { ensureClassicImage, type ImageAsset, useClassicAssets } from '../assets';
import { frameObjectUrl } from '../common/frameImage';
import { CLASSIC_FRAMES } from '../common/frames';
import { NineSlice } from '../common/NineSlice';
import { useEnsureSceneSprites } from '../common/sceneAssets';
import { classicText, TEXT } from '../common/textStyles';
import { MESSAGE_BOX, YESNO, YESNO_SHEET, yesNoLayout } from '../common/YesNoBox';
import type { Rect } from '../layout';
import { Sprite, spriteStyle, useSheetStatus, useSpriteFrame } from '../Sprite';
import d from './dialogs.module.css';

export const COMMON_SHEET = 'ui.common';
export const ITEM_BAR_SHEET = 'ui.itemBar';
export const PICKER_SHEET = 'ui.playerPicker';
export const FACE_SHEET = 'portrait.face72';
export const CURSOR_SHEET = 'ui.cursor';

/** 座位 → 角色号 */
export function characterOf(view: GameView, seat: SeatIndex): number {
  return view.players.find((p) => p.seat === seat)?.character ?? 0;
}

/** 金额（千分位 + 「元」），带 data-value 供测试比对 */
export function Money({ value, testId }: { value: number; testId?: string }): ReactNode {
  const { t } = useTranslation();
  return (
    <span data-testid={testId} data-value={value}>
      {formatMoney(value)}
      {t('cmp.unit.yuan')}
    </span>
  );
}

// ───────────────────────── 消息框 ─────────────────────────

/** 不带钮的消息框高度（正文 lines 行） */
export function plainBoxHeight(lines: number): number {
  return MESSAGE_BOX.text.y + Math.max(1, Math.ceil(lines)) * MESSAGE_BOX.lineH + 18;
}

export interface MessageBoxProps {
  /** 画点（锚点 97,81；缺省 (220,333)） */
  x?: number;
  y?: number;
  lines?: number;
  children?: ReactNode;
  testId?: string;
  textStyle?: CSSProperties;
}

/** 只放正文的宝石消息框 */
export function MessageBox({
  x = MESSAGE_BOX.at.x,
  y = MESSAGE_BOX.at.y,
  lines = 2,
  children,
  testId,
  textStyle,
}: MessageBoxProps): ReactNode {
  const h = plainBoxHeight(lines);
  const left = x - MESSAGE_BOX.ax;
  const top = Math.max(0, Math.min(y - MESSAGE_BOX.ay, 476 - h));
  return (
    <div className={d.msg} style={{ left: 0, top: 0 }} data-testid={testId}>
      <NineSlice spec={CLASSIC_FRAMES.messageBox} x={left} y={top} w={MESSAGE_BOX.w} h={h} />
      <div
        className={d.msgText}
        style={{
          ...TEXT.body,
          ...textStyle,
          left: left + MESSAGE_BOX.text.x,
          top: top + MESSAGE_BOX.text.y,
          width: MESSAGE_BOX.text.w,
          height: h - MESSAGE_BOX.text.y - 12,
        }}
        data-testid={testId ? `${testId}-text` : undefined}
      >
        {children}
      </div>
    </div>
  );
}

export interface HalfButtonProps {
  half: 'yes' | 'no';
  x: number;
  y: number;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  testId?: string;
}

/** YES / NO 图的半边（48×48）做一颗钮：悬停 / 键盘焦点时换亮帧（图1 YES 亮、图2 NO 亮） */
export function HalfButton({ half, x, y, label, onClick, disabled = false, testId }: HalfButtonProps): ReactNode {
  useEnsureSceneSprites([YESNO_SHEET]);
  const [hot, setHot] = useState(false);
  const lit = hot && !disabled;
  const f = useSpriteFrame(YESNO_SHEET, lit ? (half === 'yes' ? YESNO.frames.yes : YESNO.frames.no) : 0);
  const status = useSheetStatus(YESNO_SHEET);
  const w = YESNO.w / 2;
  return (
    <button
      type="button"
      className={d.half}
      style={{ left: x, top: y, width: w, height: YESNO.h }}
      data-half={half}
      data-hot={lit ? 'true' : undefined}
      data-hitpad="grow"
      aria-label={label}
      title={label}
      disabled={disabled}
      data-testid={testId}
      onClick={onClick}
      onPointerEnter={() => setHot(true)}
      onPointerLeave={() => setHot(false)}
      onFocus={() => setHot(true)}
      onBlur={() => setHot(false)}
    >
      {f ? (
        <span className={d.halfClip} aria-hidden="true">
          <span
            className={d.halfArt}
            style={{ ...spriteStyle(f, 0, 0, 1, 'topLeft'), left: half === 'yes' ? 0 : -w }}
            data-sprite={`${YESNO_SHEET}/${lit ? (half === 'yes' ? 1 : 2) : 0}`}
          />
        </span>
      ) : status === 'loading' ? null : (
        <span className={d.halfFallback} aria-hidden="true">
          {half === 'yes' ? 'YES' : 'NO'}
        </span>
      )}
    </button>
  );
}

export interface BoxButton {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  testId?: string;
}

export interface ConfirmBoxProps {
  x?: number;
  y?: number;
  lines?: number;
  children?: ReactNode;
  /** 只要一颗钮时给 yes 或 no 之一（两颗都要时用公共的 YesNoBox） */
  yes?: BoxButton;
  no?: BoxButton;
  testId?: string;
}

/** 消息框 + 一颗 YES（或 NO）钮，钮在框底居中；Enter / 空格经按钮本身触发 */
export function ConfirmBox({
  x = MESSAGE_BOX.at.x,
  y = MESSAGE_BOX.at.y,
  lines = MESSAGE_BOX.baseLines,
  children,
  yes,
  no,
  testId,
}: ConfirmBoxProps): ReactNode {
  const L = yesNoLayout(x, y, lines);
  const btn = yes ?? no;
  const half: 'yes' | 'no' = yes ? 'yes' : 'no';
  const bx = L.box.x + Math.round((MESSAGE_BOX.w - YESNO.w / 2) / 2);
  return (
    <div className={d.msg} style={{ left: 0, top: 0 }} data-testid={testId}>
      <NineSlice spec={CLASSIC_FRAMES.messageBox} x={L.box.x} y={L.box.y} w={L.box.w} h={L.box.h} />
      <div
        className={d.msgText}
        style={{ ...TEXT.body, left: L.text.x, top: L.text.y, width: L.text.w, height: L.text.h }}
        data-testid={testId ? `${testId}-text` : undefined}
      >
        {children}
      </div>
      {btn && (
        <HalfButton
          half={half}
          x={bx}
          y={L.yesno.y}
          label={btn.label}
          onClick={btn.onClick}
          disabled={btn.disabled}
          testId={btn.testId}
        />
      )}
    </div>
  );
}

// ───────────────────────── 文字钮 ─────────────────────────

export interface PlateButtonProps {
  x: number;
  y: number;
  w: number;
  h?: number;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  tone?: 'wood' | 'red';
  testId?: string;
  children?: ReactNode;
  /** 手机热区的扩展方向（缺省 grow = 上下左右居中补；up = 只往上补，下方紧贴别的可点控件时用） */
  hitPad?: 'grow' | 'up';
}

/** 木框金边的文字钮（没有原版图的次要操作） */
export function PlateButton({
  x,
  y,
  w,
  h = 22,
  label,
  onClick,
  disabled = false,
  pressed,
  tone = 'wood',
  testId,
  children,
  hitPad = 'grow',
}: PlateButtonProps): ReactNode {
  return (
    <button
      type="button"
      className={d.plate}
      style={{ ...classicText({ size: 12 }), left: x, top: y, width: w, height: h }}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      disabled={disabled}
      data-tone={tone}
      data-hitpad={hitPad}
      data-testid={testId}
      onClick={onClick}
    >
      {children ?? label}
    </button>
  );
}

// ───────────────────────── 卡片欄 / 道具欄 ─────────────────────────

/** Panel#11 的格子几何（逐像素统计：竖线 x=5/84–85/164–165/244–245/324–325/404，横线 y=5/60–61/116–117/172） */
export const ITEM_BAR = {
  w: 412,
  h: 180,
  cols: 5,
  rows: 3,
  x0: 6,
  y0: 6,
  dx: 80,
  dy: 56,
  cw: 78,
  ch: 54,
  frames: { cards: 0, items: 1 },
} as const;

/** 道具图标（Panel#11 图2–14，帧 = 道具号 + 1） */
export function itemIconFrame(item: ItemId): number {
  return item + 1;
}

/** 第 i 格的矩形（相对欄左上角） */
export function gridCellRect(i: number): Rect {
  const c = i % ITEM_BAR.cols;
  const r = Math.floor(i / ITEM_BAR.cols);
  return { x: ITEM_BAR.x0 + c * ITEM_BAR.dx, y: ITEM_BAR.y0 + r * ITEM_BAR.dy, w: ITEM_BAR.cw, h: ITEM_BAR.ch };
}

export interface GridCell {
  key: string;
  /** 读屏名称 */
  label: string;
  content: ReactNode;
  /** 可用（false 时置灰，但仍可点选以查看说明，除非 disabled） */
  usable?: boolean;
  disabled?: boolean;
  selected?: boolean;
  testId?: string;
  title?: string;
  onClick?: () => void;
  onHover?: (on: boolean) => void;
}

export interface CardGridProps {
  kind: 'cards' | 'items';
  /** 欄左上角（场景坐标） */
  x: number;
  y: number;
  cells: readonly GridCell[];
  label: string;
  testId?: string;
}

/** 卡片欄 / 道具欄：最多 15 格，按顺序填 */
export function CardGrid({ kind, x, y, cells, label, testId }: CardGridProps): ReactNode {
  useEnsureSceneSprites([ITEM_BAR_SHEET]);
  return (
    <fieldset
      className={d.grid}
      style={{ left: x, top: y, width: ITEM_BAR.w, height: ITEM_BAR.h }}
      aria-label={label}
      data-testid={testId}
      data-kind={kind}
      data-interactive="true"
    >
      <Sprite sheet={ITEM_BAR_SHEET} frame={ITEM_BAR.frames[kind]} x={0} y={0} origin="topLeft" />
      {cells.slice(0, ITEM_BAR.cols * ITEM_BAR.rows).map((cell, i) => {
        const r = gridCellRect(i);
        return (
          <button
            key={cell.key}
            type="button"
            className={d.cell}
            style={{ ...TEXT.body, left: r.x, top: r.y, width: r.w, height: r.h }}
            aria-label={cell.label}
            aria-pressed={cell.selected ?? false}
            title={cell.title ?? cell.label}
            disabled={cell.disabled}
            data-usable={cell.usable === false ? 'false' : 'true'}
            data-testid={cell.testId}
            onClick={cell.onClick}
            onPointerEnter={() => cell.onHover?.(true)}
            onPointerLeave={() => cell.onHover?.(false)}
            onFocus={() => cell.onHover?.(true)}
            onBlur={() => cell.onHover?.(false)}
          >
            {cell.content}
          </button>
        );
      })}
    </fieldset>
  );
}

/** 道具格的内容：图标（格中心）+ 持有数 */
export function ItemCellContent({ item, count }: { item: ItemId; count: number }): ReactNode {
  return (
    <>
      <span className={d.cellIcon} style={{ width: ITEM_BAR.cw, height: ITEM_BAR.ch }} aria-hidden="true">
        <Sprite sheet={ITEM_BAR_SHEET} frame={itemIconFrame(item)} x={ITEM_BAR.cw / 2} y={ITEM_BAR.ch / 2 - 2} />
      </span>
      <span className={d.cellCount} style={TEXT.number}>
        ×{count}
      </span>
    </>
  );
}

// ───────────────────────── 选择玩家窗 ─────────────────────────

/** Data#477：2/3/4 格的窗宽（高 97，锚点居中），格子 72×72，左上 (12,12)，步距 80 */
export const PICKER = { widths: [177, 257, 337], h: 97, x0: 12, y0: 12, dx: 80, cell: 72 } as const;

export interface PlayerPickerProps {
  /** 窗的画点（锚点居中） */
  x: number;
  y: number;
  seats: readonly SeatIndex[];
  view: GameView;
  selected: SeatIndex | null;
  onPick: (seat: SeatIndex) => void;
  nameOf: (seat: SeatIndex) => string;
  testIdOf?: (seat: SeatIndex) => string;
  disabled?: boolean;
  label: string;
  /** 格下的附加说明（例如现金） */
  noteOf?: (seat: SeatIndex) => string | null;
}

/** 选择玩家窗：最多 4 格；候选只有 1 人时用 2 格的窗 */
export function PlayerPicker({
  x,
  y,
  seats,
  view,
  selected,
  onPick,
  nameOf,
  testIdOf,
  disabled = false,
  label,
  noteOf,
}: PlayerPickerProps): ReactNode {
  useEnsureSceneSprites([PICKER_SHEET, FACE_SHEET, CURSOR_SHEET]);
  const shown = seats.slice(0, 4);
  const frame = Math.max(0, Math.min(2, shown.length - 2));
  const w = PICKER.widths[frame]!;
  const left = x - Math.floor(w / 2);
  const top = y - Math.floor(PICKER.h / 2);
  return (
    <fieldset className={d.grid} style={{ left: 0, top: 0 }} aria-label={label} data-testid="classic-picker">
      <Sprite sheet={PICKER_SHEET} frame={frame} x={left} y={top} origin="topLeft" />
      {shown.map((seat, i) => {
        const cx = left + PICKER.x0 + i * PICKER.dx;
        const cy = top + PICKER.y0;
        const ch = characterOf(view, seat);
        const on = selected === seat;
        const note = noteOf?.(seat) ?? null;
        return (
          <div key={seat}>
            <Sprite
              sheet={FACE_SHEET}
              frame={ch}
              x={cx}
              y={cy}
              origin="topLeft"
              fallback={<span className={d.faceFallback} style={{ left: cx, top: cy, width: 64, height: 64 }} />}
            />
            <button
              type="button"
              className={d.pick}
              style={{ left: cx, top: cy, width: PICKER.cell, height: PICKER.cell }}
              aria-label={nameOf(seat)}
              aria-pressed={on}
              title={nameOf(seat)}
              disabled={disabled}
              data-seat={seat}
              data-testid={testIdOf?.(seat)}
              onClick={() => onPick(seat)}
            />
            <span
              className={d.pickName}
              style={{
                ...TEXT.small,
                left: cx - 4,
                top: top + PICKER.h + 2,
                width: PICKER.cell + 8,
                color: on ? '#ffe060' : '#fff',
              }}
            >
              {nameOf(seat)}
              {note && (
                <>
                  <br />
                  {note}
                </>
              )}
            </span>
            {on && <Sprite sheet={CURSOR_SHEET} frame={CURSOR.hand} x={cx + 58} y={cy + 56} className={d.pointer} />}
          </div>
        );
      })}
    </fieldset>
  );
}

// ───────────────────────── 卡片插画 ─────────────────────────

export const CARD_ART = { w: 165, h: 256 } as const;

/** 卡片插画的逻辑键（卡号 k = Data#529+k） */
export function cardArtKey(card: CardId): string {
  return `card.${card}`;
}

/** 整图（首次使用时取 URL；不可用为 null） */
export function useSceneImage(key: string | null): ImageAsset | null {
  const img = useClassicAssets((s) => (key ? (s.images[key] ?? null) : null));
  useEffect(() => {
    if (key) ensureClassicImage(key);
  }, [key]);
  return img;
}

export function CardArt({
  card,
  x,
  y,
  testId,
  scale = 1,
}: {
  card: CardId | null;
  x: number;
  y: number;
  testId?: string;
  scale?: number;
}): ReactNode {
  const img = useSceneImage(card === null ? null : cardArtKey(card));
  if (card === null || !img) return null;
  return (
    <span
      className={d.cardArt}
      style={{
        left: x,
        top: y,
        width: CARD_ART.w * scale,
        height: CARD_ART.h * scale,
        backgroundImage: `url("${img.url}")`,
      }}
      data-testid={testId}
      data-card={card}
      aria-hidden="true"
    />
  );
}

// ───────────────────────── 原版光标 ─────────────────────────

/** Data#0 里用作光标的帧（ui.md §2.1：准星、手形、8 向箭头；图41 为左上箭头，当普通指针用） */
export const CURSOR = { hand: 27, cross: 6, target: 9, arrow: 41 } as const;
export type CursorKind = keyof typeof CURSOR;

/** 棋盘视窗的挂点（经典舞台 ClassicStage 的 boardSlot） */
function boardSlot(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  return document.querySelector<HTMLElement>('[data-testid="classic-board-slot"]');
}

/**
 * 目标选择期间，棋盘视窗上的鼠标光标换成原版光标（热点 = 帧锚点）；kind 为 null 或抽帧失败时不改。
 * 卸载或换光标时还原。触屏没有光标，无影响。
 */
export function useBoardCursor(kind: CursorKind | null): void {
  useEnsureSceneSprites([CURSOR_SHEET]);
  const f = useSpriteFrame(CURSOR_SHEET, kind === null ? -1 : CURSOR[kind]);
  useEffect(() => {
    const el = boardSlot();
    if (!f || !el) return;
    let live = true;
    const prev = el.style.cursor;
    void frameObjectUrl(f).then((url) => {
      if (!live || !url) return;
      el.style.cursor = `url("${url}") ${f.ax} ${f.ay}, pointer`;
      el.dataset.classicCursor = kind ?? '';
    });
    return () => {
      live = false;
      el.style.cursor = prev;
      delete el.dataset.classicCursor;
    };
  }, [f, kind]);
}

/** 行内小图标（精灵，按帧尺寸占位） */
export function InlineSprite({
  sheet,
  frame,
  className,
}: {
  sheet: string;
  frame: number;
  className?: string;
}): ReactNode {
  const f = useSpriteFrame(sheet, frame);
  if (!f) return null;
  return (
    <span
      className={clsx(className)}
      style={{ ...spriteStyle(f, null, null), display: 'inline-block', verticalAlign: 'middle' }}
      aria-hidden="true"
      data-sprite={`${sheet}/${frame}`}
    />
  );
}
