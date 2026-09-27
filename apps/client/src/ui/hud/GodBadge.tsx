// 附身神明徽章（design/client.md §3.6「HUD 的 GodBadge 显示图标和剩余天数环」）：
// 神明立绘缩略图 + 神明配色光环 + 剩余天数环（total 给出时按比例，缺省满环）+ 天数数字。
// compact：只有头像环与天数（玩家条用），名字放进 title 与无障碍标签。
import { GOD_KEYS, type GodKind } from '@rich4/shared/engine';
import type { CSSProperties, ReactNode } from 'react';
import { GOD_PALETTES } from '../../game/actors/godPalettes';
import { useTx } from '../../i18n/tx';
import { godUrl } from '../popups/figureUrls';

export interface GodBadgeProps {
  kind: GodKind;
  days: number;
  /** 附身总天数（天数环的分母）；缺省不画比例 */
  total?: number;
  size?: number;
  /** 紧凑：不显示名字（玩家条） */
  compact?: boolean;
}

export function GodBadge({ kind, days, total, size = 36, compact = false }: GodBadgeProps): ReactNode {
  const t = useTx();
  const pal = GOD_PALETTES[kind];
  const name = t(`gods:${GOD_KEYS[kind]}.name`);
  const r = size / 2 - 3;
  const c = 2 * Math.PI * r;
  const frac = total && total > 0 ? Math.max(0, Math.min(1, days / total)) : 1;
  const wrap: CSSProperties = {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    gap: compact ? 2 : 4,
    padding: compact ? '0 5px 0 0' : '0 8px 0 0',
    border: '2px solid var(--c-ink)',
    borderRadius: 999,
    background: pal.good ? 'var(--c-sun)' : '#e6e0f5',
    fontSize: compact ? 11 : 12,
    lineHeight: 1,
    whiteSpace: 'nowrap',
  };
  const label = `${name} · ${t('hud:days', { n: days })}`;
  return (
    <span style={wrap} data-testid="god-badge" data-god={kind} data-days={days} title={label}>
      <span style={{ position: 'relative', width: size, height: size, display: 'inline-block' }}>
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          aria-hidden="true"
          style={{ position: 'absolute' }}
        >
          <circle cx={size / 2} cy={size / 2} r={r} fill={pal.auraCss} fillOpacity={0.45} />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="var(--c-ink)"
            strokeWidth={3}
            strokeDasharray={`${c * frac} ${c}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        </svg>
        <img
          src={godUrl(kind)}
          alt=""
          width={size}
          height={size}
          draggable={false}
          style={{ position: 'absolute', inset: 0, objectFit: 'cover', objectPosition: 'top', borderRadius: '50%' }}
        />
      </span>
      <span className={compact ? 'visually-hidden' : undefined}>{name}</span>
      <strong className="num">{compact ? days : t('hud:days', { n: days })}</strong>
    </span>
  );
}
