// 工具列（Panel#1：图0 底条 439×40，图1–11 常态、图12–22 悬停；第 i 钮画点 (i·40+20, 20)）。
// 11 钮依原版顺序：说明 / 系统设定 / 托管 / LOAD / SAVE / 大地图 / 查询 / 道具 / 卡片 / 交易公布栏 / 股市。
// 托管钮沿用行动区的操作：点按切换托管，右键或长按打开托管设置。按钮都带 data-tool 与 data-testid（沿用原有的
// top-menu / action-* 测试钩子，E2E 在两种布局下用同一套选择器）。
// 触控目标（design-draft §4.5）：舞台缩小到 40 宽的钮不足 44 CSS 像素时（手机横屏 0.8125 倍只有 32.5）改为「紧凑」排法——
// 7 个常用钮 + 「更多」共 8 格、每格 55 宽（0.8125 倍时约 45 像素），热区照常向下补到 44；其余 4 钮（系统设定、LOAD、
// SAVE、交易公布栏）收进「更多」弹出的菜单，菜单项行高 56（约 45 像素），testid 不变。
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useTx } from '../../i18n/tx';
import { useClassicBox } from './ClassicStage';
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

/** 触控目标的最小边长（CSS 像素） */
export const TOOL_HIT_MIN_CSS = 44;
/** 紧凑排法：直接放在工具列上的 7 个钮（其余收进「更多」） */
export const COMPACT_TOOLS: readonly ToolId[] = ['help', 'autopilot', 'bigMap', 'info', 'items', 'cards', 'stock'];
/** 紧凑排法收进「更多」菜单的钮 */
export const MORE_TOOLS: readonly ToolId[] = TOOLS.filter((id) => !COMPACT_TOOLS.includes(id));
/** 紧凑排法每格宽（440 / 8） */
export const COMPACT_W = REGION.toolbar.w / (COMPACT_TOOLS.length + 1);
/** 「更多」菜单的行高（舞台逻辑像素） */
export const MORE_ROW_H = 56;

/** 舞台缩放后 40 宽的钮不足 44 CSS 像素：改用紧凑排法 */
export function compactToolbar(scale: number): boolean {
  return scale * TOOL_W < TOOL_HIT_MIN_CSS;
}

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
  const box = useClassicBox();
  const compact = box !== null && compactToolbar(box.scale);
  const [moreOpen, setMoreOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
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
  // 「更多」菜单：点菜单外、Esc 关闭；换回完整排法时收起
  useEffect(() => {
    if (!compact) setMoreOpen(false);
  }, [compact]);
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: PointerEvent): void => {
      if (e.target instanceof Node && navRef.current?.contains(e.target)) return;
      setMoreOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setMoreOpen(false);
      navRef.current?.querySelector<HTMLElement>('[data-tool="more"]')?.focus();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [moreOpen]);

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

  /** 工具钮：left / width 为工具列内的格子，图标画在格子中央 */
  const toolButton = (id: ToolId, left: number, width: number): ReactNode => {
    const i = TOOLS.indexOf(id);
    const p = toolPoint(i);
    const cx = p.x - i * TOOL_W + (width - TOOL_W) / 2;
    const isAuto = id === 'autopilot';
    const on = isAuto ? autopilotOn === true : pressed[id] === true;
    return (
      <button
        key={id}
        type="button"
        className={c.toolBtn}
        style={width === TOOL_W ? { left } : { left, width }}
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
            <Sprite sheet="ui.toolbar" frame={1 + i} x={cx} y={p.y} className={c.normal} />
            <Sprite sheet="ui.toolbar" frame={12 + i} x={cx} y={p.y} className={c.hover} />
          </>
        ) : (
          <span className={c.toolFallback} style={{ left: (width - TOOL_W) / 2 + 3 }} aria-hidden="true">
            {FALLBACK_GLYPH[id]}
          </span>
        )}
      </button>
    );
  };

  return (
    <nav
      ref={navRef}
      className={`${c.region} ${c.toolbar}`}
      style={regionStyle(REGION.toolbar)}
      aria-label={t('classic:tool.bar')}
      data-testid="classic-toolbar"
      data-art={art ? 'true' : 'false'}
      data-compact={compact ? 'true' : 'false'}
    >
      <Sprite sheet="ui.toolbar" frame={0} x={0} y={0} />
      {compact ? (
        <>
          {COMPACT_TOOLS.map((id, k) => toolButton(id, k * COMPACT_W, COMPACT_W))}
          <button
            type="button"
            className={`${c.toolBtn} ${c.toolMoreBtn}`}
            style={{ left: COMPACT_TOOLS.length * COMPACT_W, width: COMPACT_W }}
            aria-label={t('hud:action.more')}
            title={t('hud:action.more')}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            aria-controls="classic-tool-more"
            data-tool="more"
            data-testid="tool-more"
            onClick={() => setMoreOpen((o) => !o)}
          >
            <span className={c.toolFallback} style={{ left: (COMPACT_W - TOOL_W) / 2 + 3 }} aria-hidden="true">
              ⋯
            </span>
          </button>
          {moreOpen && (
            <div
              id="classic-tool-more"
              className={c.toolMenu}
              role="menu"
              aria-label={t('hud:action.more')}
              data-testid="tool-more-menu"
              style={{ width: 4 * COMPACT_W, top: REGION.toolbar.h }}
            >
              {MORE_TOOLS.map((id) => {
                const i = TOOLS.indexOf(id);
                return (
                  <button
                    key={id}
                    type="button"
                    role="menuitem"
                    className={c.toolMenuItem}
                    style={{ height: MORE_ROW_H }}
                    disabled={disabled[id] === true}
                    data-pressed={pressed[id] === true ? 'true' : undefined}
                    data-tool={id}
                    data-testid={TOOL_TEST_IDS[id]}
                    onClick={() => {
                      setMoreOpen(false);
                      onTool(id);
                    }}
                  >
                    <span className={c.toolMenuIcon} aria-hidden="true">
                      {art ? (
                        <Sprite sheet="ui.toolbar" frame={1 + i} x={20} y={20} />
                      ) : (
                        <span className={c.toolFallback}>{FALLBACK_GLYPH[id]}</span>
                      )}
                    </span>
                    <span>{label(id)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </>
      ) : (
        TOOLS.slice(0, TOOL_COUNT).map((id, i) => toolButton(id, i * TOOL_W, TOOL_W))
      )}
    </nav>
  );
}
