// 建筑外观预览（加盖对话框「当前 → 下一级」、买地对话框）。
// 真实浏览器里懒加载 Pixi 生成器出图；没有 WebGL（jsdom、渲染失败）时退回 DOM 画的楼层示意。
import type { FacilityType, LotLevel, SeatIndex } from '@rich4/shared/engine';
import { type CSSProperties, type ReactNode, useEffect, useState } from 'react';
import type { BuildingSpec } from '../../game/procedural/building/generate';
import { seatColor } from './Avatar';
import s from './components.module.css';

export type PreviewKind = { t: 'house'; chain?: boolean } | { t: 'facility'; type: FacilityType | null };

export interface BuildingPreviewProps {
  kind: PreviewKind;
  level: LotLevel;
  owner: SeatIndex | null;
  label: string;
  size?: number;
  /** 测试或低画质时强制使用 DOM 示意图 */
  fallbackOnly?: boolean;
}

/** 预览参数 → 生成器 BuildingSpec（纯函数） */
export function previewSpec(kind: PreviewKind, level: LotLevel, owner: SeatIndex | null): BuildingSpec {
  if (kind.t === 'house') {
    return { kind: 'house', level, w: 1, d: 1, owner, variant: 0, door: 'left' };
  }
  const style = level === 0 || kind.type === null ? 'vacant' : kind.type;
  return { kind: `facility:${style}`, level, w: 2, d: 2, owner, variant: 0, door: 'left' };
}

/** 能否用 WebGL 出图（jsdom 的 UA 含 jsdom；没有 canvas 的环境直接退回） */
function canRender(): boolean {
  if (typeof document === 'undefined' || typeof navigator === 'undefined') return false;
  return !/jsdom/i.test(navigator.userAgent);
}

export function BuildingPreview({
  kind,
  level,
  owner,
  label,
  size = 120,
  fallbackOnly = false,
}: BuildingPreviewProps): ReactNode {
  const [url, setUrl] = useState<string | null>(null);
  const spec = previewSpec(kind, level, owner);
  const specKey = JSON.stringify(spec);
  // biome-ignore lint/correctness/useExhaustiveDependencies: specKey 概括了 spec
  useEffect(() => {
    setUrl(null);
    if (fallbackOnly || !canRender()) return;
    let alive = true;
    import('./buildingPreviewImage')
      .then((m) => m.buildingPreviewImage(spec))
      .then(
        (u) => {
          if (alive) setUrl(u);
        },
        (e: unknown) => {
          console.warn('[BuildingPreview]', e);
        },
      );
    return () => {
      alive = false;
    };
  }, [specKey, fallbackOnly]);
  const style = { '--preview-w': `${size}px`, '--preview-h': `${size}px`, '--seat': seatColor(owner) } as CSSProperties;
  return (
    <figure className={s.preview} style={style} data-testid="building-preview" data-level={level} aria-label={label}>
      {url ? (
        <img src={url} alt={label} />
      ) : (
        <span className={s.previewFallback} aria-hidden="true">
          {Array.from({ length: Math.max(level, 0) }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 楼层示意无身份
            <span key={i} className={s.previewFloor} />
          ))}
          {level > 0 ? <span className={s.previewRoof} /> : <span style={{ fontSize: 28 }}>🌱</span>}
        </span>
      )}
    </figure>
  );
}
