// 通用 UI 组件入口（design/client.md §2 ui/components）。决策对话框、面板与 HUD 共用。
export { AmountSlider, type AmountSliderProps } from './AmountSlider';
export { Avatar, type AvatarProps, PlayerChip, portraitUrl, SeatMark, seatColor } from './Avatar';
export { BuildingPreview, type BuildingPreviewProps, type PreviewKind, previewSpec } from './BuildingPreview';
export { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from './Button';
export { CardTile, type CardTileProps, ItemTile, type ItemTileProps, TileGrid } from './CardTile';
export { CountdownRing, type CountdownRingProps, type Remaining, URGENT_MS, useRemainingMs } from './Countdown';
export {
  CARD_CATEGORY,
  CARD_ICON,
  CATEGORY_COLOR,
  type CardCategory,
  cardCategory,
  ITEM_ICON,
  itemFrameColor,
  SEAT_COLOR_VARS,
  SEAT_MARKS,
} from './cardVisuals';
export * from './format';
export { BottomSheet, Modal, type ModalProps, NARROW_QUERY, useMediaQuery } from './Modal';
export { Money, type MoneyProps, Points } from './Money';
export { type GameText, type LooseT, makeGameText, useGameText } from './names';
export { Badge, KeyValues, Panel, type PanelProps } from './Panel';
export { Sparkline, type SparklineProps, sparkPath } from './Sparkline';
export { Stepper, type StepperProps } from './Stepper';
export { type TabDef, Tabs, type TabsProps } from './Tabs';
