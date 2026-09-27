// 玩家状态徽章（design/client.md §3.6、§5.1）：坐牢 / 住院 / 住旅馆 / 不在场 / 冬眠 / 梦游 / 停留 / 乌龟、
// 拒绝往来、保险、身上的定时炸弹、同盟、贷款；附身神明用 GodBadge。计数按两段式计数器的显示天数。
// compact（玩家条）：只显示图标 + 数字，完整文案放进 title 与无障碍标签。
import type { SeatIndex } from '@rich4/shared/engine';
import type { PlayerView } from '@rich4/shared/view';
import type { CSSProperties, ReactNode } from 'react';
import { useTx } from '../../i18n/tx';
import { counterDays, formatDateShort, formatInt } from '../components/format';
import { GodBadge } from './GodBadge';

const COUNTERS = ['jail', 'hospital', 'hotel', 'away', 'hibernate', 'sleepwalk', 'stay', 'tortoise'] as const;

const ICONS: Readonly<Record<string, string>> = {
  jail: '🔒',
  hospital: '🏥',
  hotel: '🏨',
  away: '✈️',
  hibernate: '🧊',
  sleepwalk: '🌙',
  stay: '✋',
  tortoise: '🐢',
  bankReject: '🚫',
  insurance: '🛡️',
  alliance: '🤝',
  loan: '💳',
  bomb: '💣',
};

export interface StatusBadge {
  key: string;
  n: number | string;
  due?: string;
  /** 同盟对象 */
  seat?: SeatIndex;
}

/** 玩家当前的状态徽章（纯函数，HUD 与测试共用） */
export function statusBadges(p: PlayerView): StatusBadge[] {
  const out: StatusBadge[] = [];
  for (const k of COUNTERS) {
    const n = counterDays(p.st[k]);
    if (n > 0) out.push({ key: k, n });
  }
  if (p.bankReject > 0) out.push({ key: 'bankReject', n: counterDays(p.bankReject) });
  if (p.insuranceDays > 0) out.push({ key: 'insurance', n: counterDays(p.insuranceDays) });
  if (p.bomb) out.push({ key: 'bomb', n: p.bomb.fuse });
  if (p.alliance) out.push({ key: 'alliance', n: p.alliance.days, seat: p.alliance.seat });
  if (p.loan > 0) out.push({ key: 'loan', n: formatInt(p.loan), due: formatDateShort(p.loanDue) });
  return out;
}

const pill: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 3,
  padding: '0 8px',
  border: '2px solid var(--c-ink)',
  borderRadius: 999,
  background: 'var(--c-white)',
  fontSize: 12,
  whiteSpace: 'nowrap',
};

const pillCompact: CSSProperties = {
  ...pill,
  gap: 1,
  padding: '0 4px',
  borderWidth: 1.5,
  fontSize: 11,
  lineHeight: '16px',
};

export function StatusBadges({
  player,
  nameOf,
  showGod = true,
  compact = false,
  testId,
}: {
  player: PlayerView;
  /** 同盟对象的名字 */
  nameOf?: (seat: SeatIndex) => string;
  showGod?: boolean;
  /** 紧凑：图标 + 数字（玩家条） */
  compact?: boolean;
  /** 缺省 status-badges-<seat> */
  testId?: string;
}): ReactNode {
  const t = useTx();
  const list = statusBadges(player);
  if (list.length === 0 && !(showGod && player.god)) return null;
  const text = (s: StatusBadge): string =>
    s.key === 'alliance'
      ? t('hud:days', { n: s.n }) + (s.seat !== undefined && nameOf ? ` · ${nameOf(s.seat)}` : '')
      : t(`hud:status.${s.key}`, { n: s.n, due: s.due });
  return (
    <span
      style={{ display: 'flex', flexWrap: 'wrap', gap: compact ? 2 : 4 }}
      data-testid={testId ?? `status-badges-${player.seat}`}
      data-seat={player.seat}
    >
      {showGod && player.god && (
        <GodBadge kind={player.god.kind} days={player.god.days} size={compact ? 18 : 24} compact={compact} />
      )}
      {list.map((s) =>
        compact ? (
          <span key={s.key} style={pillCompact} data-status={s.key} title={text(s)} role="img" aria-label={text(s)}>
            <span aria-hidden="true">{ICONS[s.key]}</span>
            {s.key !== 'loan' && <span className="num">{s.n}</span>}
          </span>
        ) : (
          <span key={s.key} style={pill} data-status={s.key}>
            {ICONS[s.key] && s.key !== 'bomb' && <span aria-hidden="true">{ICONS[s.key]}</span>}
            {text(s)}
          </span>
        ),
      )}
    </span>
  );
}
