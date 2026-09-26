// 信息面板入口（design/client.md §5.4）
export { BankPanel, type BankPanelProps } from './BankPanel';
export { assetLabel, type BoardIntent, BoardPanel, type BoardPanelProps } from './BoardPanel';
export { InventoryPanel, type InventoryPanelProps, type InventoryTab } from './InventoryPanel';
export {
  counterDays,
  PlayerInfoPanel,
  type PlayerInfoPanelProps,
  type PlayerSummary,
  summarizePlayer,
} from './PlayerInfoPanel';
export {
  filterRows,
  type OwnerFilter,
  PropertyListPanel,
  type PropertyListPanelProps,
  type PropertyRow,
  propertyRows,
} from './PropertyListPanel';
export {
  holdingValue,
  SPARK_DAYS,
  StockPanel,
  type StockPanelProps,
  type StockTradeIntent,
  viewStockRows,
} from './StockPanel';
export { TileInfoContent, TileInfoPopover, type TileInfoPopoverProps } from './TileInfoPopover';
