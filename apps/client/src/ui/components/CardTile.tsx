// 卡片 / 道具格（design/client.md §5.4、§6.3）：卡框按类别配色，中间图标，下方名称，角标点券价；
// 不可用时置灰并在下方显示原因（同时写进 title，悬停可见）。有 onClick 时渲染为按钮。
import type { CardId, ItemId } from '@rich4/shared/engine';
import clsx from 'clsx';
import { motion, useReducedMotion } from 'motion/react';
import type { CSSProperties, ReactNode } from 'react';
import { CARD_ICON, CATEGORY_COLOR, cardCategory, ITEM_ICON, itemFrameColor } from './cardVisuals';
import s from './components.module.css';

interface TileBaseProps {
  name: string;
  /** 角标价格（点券） */
  price?: number | null;
  /** 数量徽标（道具） */
  count?: number | null;
  disabled?: boolean;
  /** 不可用原因（已翻译） */
  reason?: string | null;
  selected?: boolean;
  onClick?: () => void;
  /** 额外说明（例如卖出价） */
  caption?: ReactNode;
  description?: string;
  testId?: string;
  width?: number;
}

function TileBody({
  icon,
  frame,
  name,
  price,
  count,
  disabled,
  reason,
  selected,
  onClick,
  caption,
  description,
  testId,
  width,
  kind,
}: TileBaseProps & { icon: string; frame: string; kind: 'card' | 'item' }): ReactNode {
  const reduce = useReducedMotion();
  const style = { '--frame': frame, ...(width ? { '--tile-w': `${width}px` } : {}) } as CSSProperties;
  const title = [name, description, disabled && reason ? reason : null].filter(Boolean).join('\n');
  const inner = (
    <>
      {price !== undefined && price !== null && <span className={s.tilePrice}>{price}</span>}
      {count !== undefined && count !== null && <span className={s.tileCount}>{count}</span>}
      <span className={s.tileIcon} aria-hidden="true">
        {icon}
      </span>
      <span className={s.tileName}>{name}</span>
      {disabled && reason ? <small className={s.tileReason}>{reason}</small> : caption}
    </>
  );
  const common = {
    className: clsx(s.tile),
    style,
    title,
    'data-testid': testId,
    'data-kind': kind,
    'data-disabled': disabled ? 'true' : 'false',
    'data-selected': selected ? 'true' : 'false',
  };
  if (onClick) {
    return (
      <motion.button
        type="button"
        {...common}
        disabled={disabled}
        aria-pressed={selected}
        onClick={onClick}
        whileHover={reduce || disabled ? undefined : { rotate: -1.5 }}
      >
        {inner}
      </motion.button>
    );
  }
  return <div {...common}>{inner}</div>;
}

export interface CardTileProps extends TileBaseProps {
  card: CardId;
}

export function CardTile({ card, ...rest }: CardTileProps): ReactNode {
  return <TileBody {...rest} kind="card" icon={CARD_ICON[card]} frame={CATEGORY_COLOR[cardCategory(card)]} />;
}

export interface ItemTileProps extends TileBaseProps {
  item: ItemId;
}

export function ItemTile({ item, ...rest }: ItemTileProps): ReactNode {
  return <TileBody {...rest} kind="item" icon={ITEM_ICON[item]} frame={itemFrameColor(item)} />;
}

/** 卡片 / 道具网格 */
export function TileGrid({ children, label }: { children: ReactNode; label?: string }): ReactNode {
  return (
    <fieldset className={s.tileGrid}>
      {label && <legend className="visually-hidden">{label}</legend>}
      {children}
    </fieldset>
  );
}
