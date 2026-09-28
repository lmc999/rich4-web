// 原版风格的存读档界面（original-skin.md §4.2「没有原版对应物的联机界面用原版素材风格搭建」；ui.md §2.3 LOAD/SAVE Data#479）：
// 原版 LOAD 窗（图0 555×451）/ SAVE 窗（图1 555×381）居中，左栏是窗上的 LOAD / SAVE 页签与本局地图缩图（图2–5：台 / 中 / 日 /
// 美，fixture 地图用台湾），右侧大框里放服务器存档列表与存档表单（ui/system 的 SaveLoadMenu：存档、导出、删除、导入，
// 逻辑不变；对局中不能读档，LOAD 窗只列出存档）。列表按 CSS 像素排版：外层按舞台倍率反向 zoom，字号与手机热区同程序化界面。
// data-testid 与经典外壳的存读档 Modal 相同（classic-saves），E2E 两种画法共用。
import type { RoomView } from '@rich4/shared/net';
import type { ReactNode } from 'react';
import { useTx } from '../../../i18n/tx';
import { formatDate } from '../../../presentation/names';
import { useGameStore } from '../../../store/gameStore';
import { SaveLoadMenu } from '../../system/SaveLoadMenu';
import { Stage4x3 } from '../common/Stage4x3';
import { classicText } from '../common/textStyles';
import { Sprite } from '../Sprite';
import { SAVELOAD_SHEET } from './layout';
import pp from './popups.module.css';

export const SAVELOAD_KEYS = [SAVELOAD_SHEET] as const;

/** 两种窗的尺寸（图0 LOAD、图1 SAVE）与右侧大框（逐像素统计：左栏 0..71 为色键透明，大框 x=74..552） */
export const SAVELOAD = {
  load: { frame: 0, w: 555, h: 451 },
  save: { frame: 1, w: 555, h: 381 },
  panel: { x: 84, y: 12, w: 460 },
  thumb: { frame0: 2, maps: ['taiwan', 'china', 'japan', 'usa'] as const },
} as const;

export type SaveLoadMode = 'load' | 'save';

export function mapThumbFrame(mapId: string | null): number {
  const i = SAVELOAD.thumb.maps.indexOf((mapId ?? 'taiwan') as (typeof SAVELOAD.thumb.maps)[number]);
  return SAVELOAD.thumb.frame0 + Math.max(0, i);
}

export function SaveLoadScreen({
  mode,
  room,
  onClose,
}: {
  mode: SaveLoadMode;
  room: RoomView;
  onClose: () => void;
}): ReactNode {
  const t = useTx();
  const date = useGameStore((s) => s.view?.clock.date ?? null);
  const mapId = useGameStore((s) => s.view?.dataRef.mapId ?? null);
  const win = SAVELOAD[mode];
  const x = Math.round((640 - win.w) / 2);
  const y = Math.round((480 - win.h) / 2);
  const P = SAVELOAD.panel;
  const panelH = win.h - 2 * P.y;
  return (
    <Stage4x3
      testId="classic-saves"
      label={mode === 'load' ? t('classic:tool.load') : t('classic:tool.save')}
      backdrop="dim"
      onClose={onClose}
      closeLabel={t('cmp.close')}
      attrs={{ 'data-classic': 'true', 'data-mode': mode }}
    >
      <Sprite sheet={SAVELOAD_SHEET} frame={win.frame} x={x} y={y} origin="topLeft" />
      <Sprite sheet={SAVELOAD_SHEET} frame={mapThumbFrame(mapId)} x={x} y={y + win.h - 80} origin="topLeft" />
      <div
        className={pp.savePanel}
        style={{ left: x + P.x, top: y + P.y, width: P.w, height: panelH }}
        data-testid="classic-saves-panel"
      >
        <div
          className={pp.saveZoom}
          style={{
            width: `calc(${P.w}px * var(--classic-scale, 1))`,
            height: `calc(${panelH}px * var(--classic-scale, 1))`,
          }}
        >
          <p style={classicText({ size: 16, color: '#ffe060', bold: true })}>
            {mode === 'load' ? t('classic:tool.load') : t('classic:tool.save')}
          </p>
          {mode === 'load' && (
            <p className={pp.saveNote} data-testid="classic-load-note">
              {t('classic:tool.loadNote')}
            </p>
          )}
          <SaveLoadMenu
            mode="game"
            isHost={room.you.isHost}
            defaultName={date ? formatDate(date) : ''}
            saveForm={mode === 'save'}
          />
        </div>
      </div>
    </Stage4x3>
  );
}
