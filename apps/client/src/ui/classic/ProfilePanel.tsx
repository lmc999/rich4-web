// 个人资料栏（Panel#0，贴 (440,0) 200×280）：右缘竖页签切换 資金 / 地產 / 股票 / 其他 四页（图0–3），
// 头像 Data#2（72×72，帧 = 角色号）、角色代表色条、物价指数行；数值用 DOM 文字叠加（原版为 GDI 文字）。
// 查看对象：点左栏座位切换（uiStore.inspectSeat），否则跟随当前行动者，再否则是自己。
// 页内坐标按页图目视取值：三条数值条 y = 96 / 160 / 224（高 34，x 8..169），页签 x 176..199、每页 70 高。

import type { MapIndex } from '@rich4/shared/data';
import { characterDef } from '@rich4/shared/data';
import { CHARACTER_KEYS, type SeatIndex } from '@rich4/shared/engine';
import type { RoomView } from '@rich4/shared/net';
import type { GameView } from '@rich4/shared/view';
import clsx from 'clsx';
import { type ReactNode, useState } from 'react';
import { type LooseT, useTx } from '../../i18n/tx';
import { formatMoney } from '../../presentation/names';
import { currentSeat } from '../../store/gameStore';
import { useUiStore } from '../../store/uiStore';
import { portraitUrl } from '../common/Avatar';
import { seatName } from '../hud/PlayerChips';
import c from './classic.module.css';
import { REGION, regionStyle } from './layout';
import { PROFILE_PAGES, type ProfilePage, type ProfileRow, profileNumbers, profileRows } from './profileStats';
import { Sprite, useSheetStatus } from './Sprite';

/** 三条数值条的顶边 */
export const PROFILE_STRIP_Y = [96, 160, 224] as const;
/** 页签：x 176..199，第 i 页 y = i·70 起、高 70 */
export const PROFILE_TAB_H = 70;
/** 页签颜色（回退画法；与原版页图的青 / 蓝 / 红 / 金一致） */
const TAB_COLORS = ['#29d6ad', '#4a5ace', '#d24a4a', '#d6a84a'] as const;

/** 查看对象：inspectSeat → 当前行动者 → 自己 → 第一个玩家 */
export function profileSeat(view: GameView, room: RoomView, inspect: SeatIndex | null): SeatIndex | null {
  const me = room.you.role === 'player' ? room.you.seat : null;
  const cur = currentSeat(view) as SeatIndex | null;
  const pick = inspect ?? cur ?? me ?? view.players[0]?.seat ?? null;
  return pick !== null && view.players.some((p) => p.seat === pick) ? pick : (view.players[0]?.seat ?? null);
}

export function formatRow(t: LooseT, r: ProfileRow): string {
  if (typeof r.value === 'string') return r.value.replace('/', ' / ');
  switch (r.format) {
    case 'money':
      return formatMoney(r.value);
    case 'lots':
      return t('classic:profile.unitLots', { n: r.value });
    case 'houses':
      return t('classic:profile.unitHouses', { n: r.value });
    case 'shares':
      return t('classic:profile.unitShares', { n: formatMoney(r.value) });
    default:
      return String(r.value);
  }
}

export function ProfilePanel({
  view,
  room,
  map,
  page: pageProp,
  onPageChange,
}: {
  view: GameView;
  room: RoomView;
  map: MapIndex | null;
  /** 受控页（可省略：组件自己记） */
  page?: ProfilePage;
  onPageChange?(p: ProfilePage): void;
}): ReactNode {
  const t = useTx();
  const inspect = useUiStore((s) => s.inspectSeat);
  const [own, setOwn] = useState<ProfilePage>('funds');
  const page = pageProp ?? own;
  const setPage = (p: ProfilePage): void => {
    setOwn(p);
    onPageChange?.(p);
  };
  const sideStatus = useSheetStatus('ui.sidebar');
  const art = sideStatus === 'ready';
  const faceStatus = useSheetStatus('portrait.face72');
  const faceArt = faceStatus === 'ready';
  const seat = profileSeat(view, room, inspect);
  const p = seat === null ? null : view.players.find((x) => x.seat === seat);
  const nums = p && seat !== null ? profileNumbers(view, map, seat) : null;
  const pageIndex = PROFILE_PAGES.indexOf(page);
  const rows = nums ? profileRows(page, nums) : null;
  const mine = room.you.role === 'player' && room.you.seat === seat;

  return (
    <section
      className={`${c.region} ${c.profile}`}
      style={regionStyle(REGION.profile)}
      aria-label={t('classic:profile.title')}
      data-testid="classic-profile"
      data-seat={seat ?? ''}
      data-page={page}
      data-art={art ? 'true' : 'false'}
    >
      {sideStatus === 'loading' ? null : art ? (
        <Sprite sheet="ui.sidebar" frame={pageIndex} x={0} y={0} />
      ) : (
        <div className={c.profileFallback} aria-hidden="true">
          {PROFILE_STRIP_Y.map((y) => (
            <span key={y} className={c.fbStrip} style={{ top: y }} />
          ))}
          {TAB_COLORS.map((col, i) => (
            <span
              key={col}
              className={c.fbTab}
              style={{ top: i * PROFILE_TAB_H + 1, background: col, opacity: i === pageIndex ? 1 : 0.55 }}
            />
          ))}
        </div>
      )}
      <div role="tablist" aria-label={t('classic:profile.title')}>
        {PROFILE_PAGES.map((pg, i) => (
          <button
            key={pg}
            type="button"
            role="tab"
            aria-selected={pg === page}
            aria-label={t(`classic:profile.tabs.${pg}`)}
            title={t(`classic:profile.tabs.${pg}`)}
            className={c.tabBtn}
            style={{ top: i * PROFILE_TAB_H }}
            onClick={() => setPage(pg)}
            data-testid={`classic-tab-${pg}`}
            data-art={art ? 'true' : 'false'}
          />
        ))}
      </div>
      {sideStatus === 'missing' &&
        PROFILE_PAGES.map((pg, i) => (
          <span
            key={pg}
            className={clsx(c.tabLabel, c.outline)}
            style={{ top: i * PROFILE_TAB_H + 12 }}
            aria-hidden="true"
          >
            {t(`classic:profile.tabs.${pg}`)}
          </span>
        ))}
      {p && (
        <>
          <span className={c.avatarBox} data-testid="classic-avatar" data-character={p.character}>
            {faceStatus === 'loading' ? null : faceArt ? (
              <Sprite sheet="portrait.face72" frame={p.character} x={0} y={0} />
            ) : (
              <span className={c.avatarFallback}>
                <img src={portraitUrl(p.character, p.alive ? 'normal' : 'sad')} alt="" draggable={false} />
              </span>
            )}
          </span>
          {!p.alive && <span className={clsx(c.outTag, c.outline)}>{t('classic:profile.out')}</span>}
          <span className={c.ppName} data-testid="classic-profile-name">
            {t(`characters:${CHARACTER_KEYS[p.character]}.name`)}
          </span>
          <span className={c.ppNick}>
            {seatName(room, p.seat)}
            {mine ? `（${t('classic:profile.you')}）` : ''}
          </span>
          <span
            className={c.colorBar}
            style={{ background: characterDef(p.character).color }}
            data-testid="classic-color-bar"
            data-color={characterDef(p.character).color}
          />
          <span className={c.priceIndex} data-testid="classic-price-index" data-value={view.econ.priceIndex}>
            {t('classic:profile.priceIndex', { n: view.econ.priceIndex })}
          </span>
        </>
      )}
      <div role="tabpanel" aria-label={t(`classic:profile.tabs.${page}`)} data-testid={`classic-page-${page}`}>
        {rows?.map((r, i) => {
          const y = PROFILE_STRIP_Y[i]!;
          const neg = typeof r.value === 'number' && r.value < 0;
          return (
            <div key={r.field}>
              <span className={c.rowLabel} style={{ top: y - 16 }}>
                {t(`classic:profile.${page}.${r.field}`)}
              </span>
              <span
                className={clsx(c.rowValue, c.outline, c.num)}
                style={{ top: y }}
                data-testid={`classic-val-${page}-${r.field}`}
                data-value={r.value}
                data-neg={neg ? 'true' : 'false'}
              >
                {formatRow(t, r)}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
