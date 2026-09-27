// 工具列（Panel#1：图0 底条 439×40，图1–11 常态、图12–22 悬停；第 i 钮画点 (i·40+20, 20)）。
// 11 钮依原版顺序：说明 / 系统设定 / 托管 / LOAD / SAVE / 大地图 / 查询 / 道具 / 卡片 / 交易公布栏 / 股市。
// 托管钮沿用行动区的操作：点按切换托管，右键或长按打开托管设置。按钮都带 data-tool 与 data-testid（沿用原有的
// top-menu / action-* 测试钩子，E2E 在两种布局下用同一套选择器）。
import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import { useTx } from '../../i18n/tx';
import c from './classic.module.css';
import { REGION, regionStyle, TOOL_COUNT, TOOL_W, toolPoint } from './layout';
import { Sprite, useSheetStatus } from './Sprite';

export const TOOLS = [
  'help',
  'settings',
  'autopilot',
  'load',
  'save',
  'bigMap',
  'info',
  'items',
  'cards',
  'board',
  'stock',
] as const;
export type ToolId = (typeof TOOLS)[number];

/** 各钮的测试钩子：沿用程序化布局里同一功能按钮的 data-testid */
export const TOOL_TEST_IDS: Readonly<Record<ToolId, string>> = {
  help: 'tool-help',
  settings: 'top-menu',
  autopilot: 'action-autopilot',
  load: 'tool-load',
  save: 'tool-save',
  bigMap: 'tool-bigmap',
  info: 'action-info',
  items: 'action-items',
  cards: 'action-cards',
  board: 'action-board',
  stock: 'action-stock',
};

/** 回退画法的字（素材缺失时） */
const FALLBACK_GLYPH: Readonly<Record<ToolId, string>> = {
  help: '?',
  settings: '⚙',
  autopilot: '💡',
  load: 'LOAD',
  save: 'SAVE',
  bigMap: '▦',
  info: '🔍',
  items: '🔨',
  cards: 'CARD',
  board: 'SALE',
  stock: '📈',
};

/** 有开 / 关状态的钮（aria-pressed，CSS 按下态显示悬停帧）：托管、大地图，以及打开面板的查询 / 道具 / 卡片 / 公佈欄 / 股市 */
export const TOGGLE_TOOLS: ReadonlySet<ToolId> = new Set<ToolId>([
  'autopilot',
  'bigMap',
  'info',
  'items',
  'cards',
  'board',
  'stock',
]);

/** 托管钮长按多久打开托管设置（与行动区一致） */
export const TOOL_LONG_PRESS_MS = 550;

export interface ToolbarProps {
  onTool(id: ToolId): void;
  /** 托管钮的右键 / 长按 */
  onAutopilotSettings(): void;
  pressed?: Partial<Record<ToolId, boolean>>;
  disabled?: Partial<Record<ToolId, boolean>>;
  /** 托管中（钮上显示亮灯） */
  autopilotOn?: boolean;
}

export function Toolbar({
  onTool,
  onAutopilotSettings,
  pressed = {},
  disabled = {},
  autopilotOn,
}: ToolbarProps): ReactNode {
  const t = useTx();
  const status = useSheetStatus('ui.toolbar');
  const art = status === 'ready';
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = useRef(false);
  const clear = (): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const openSettings = (): void => {
    clear();
    longPressed.current = true;
    onAutopilotSettings();
  };

  const label = (id: ToolId): string => {
    if (id === 'autopilot') return autopilotOn ? t('classic:tool.autopilotOn') : t('classic:tool.autopilot');
    if (id === 'bigMap' && pressed.bigMap) return t('classic:tool.bigMapOff');
    return t(`classic:tool.${id}`);
  };

  return (
    <nav
      className={`${c.region} ${c.toolbar}`}
      style={regionStyle(REGION.toolbar)}
      aria-label={t('classic:tool.bar')}
      data-testid="classic-toolbar"
      data-art={art ? 'true' : 'false'}
    >
      <Sprite sheet="ui.toolbar" frame={0} x={0} y={0} />
      {TOOLS.slice(0, TOOL_COUNT).map((id, i) => {
        const p = toolPoint(i);
        const isAuto = id === 'autopilot';
        const on = isAuto ? autopilotOn === true : pressed[id] === true;
        return (
          <button
            key={id}
            type="button"
            className={c.toolBtn}
            style={{ left: i * TOOL_W }}
            title={
              isAuto
                ? `${label(id)}（${t('classic:tool.autopilotHint')}）`
                : id === 'load'
                  ? `${label(id)}（${t('classic:tool.loadHint')}）`
                  : label(id)
            }
            aria-label={label(id)}
            aria-pressed={TOGGLE_TOOLS.has(id) ? on : undefined}
            disabled={disabled[id] === true}
            data-tool={id}
            data-testid={TOOL_TEST_IDS[id]}
            onPointerDown={
              isAuto
                ? (e) => {
                    longPressed.current = false;
                    clear();
                    if (e.button > 0) return;
                    timer.current = setTimeout(openSettings, TOOL_LONG_PRESS_MS);
                  }
                : undefined
            }
            onPointerUp={isAuto ? clear : undefined}
            onPointerLeave={isAuto ? clear : undefined}
            onPointerCancel={isAuto ? clear : undefined}
            onContextMenu={
              isAuto
                ? (e) => {
                    e.preventDefault();
                    openSettings();
                  }
                : undefined
            }
            onClick={(e) => {
              if (isAuto && longPressed.current && e.detail !== 0) {
                longPressed.current = false;
                return;
              }
              onTool(id);
            }}
          >
            {status === 'loading' ? null : art ? (
              <>
                <Sprite sheet="ui.toolbar" frame={1 + i} x={p.x - i * TOOL_W} y={p.y} className={c.normal} />
                <Sprite sheet="ui.toolbar" frame={12 + i} x={p.x - i * TOOL_W} y={p.y} className={c.hover} />
              </>
            ) : (
              <span className={c.toolFallback} aria-hidden="true">
                {FALLBACK_GLYPH[id]}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
