// 骰子（原版：滚骰 Panel#4/5/6 FLC 189×285，1/2/3 颗，绿色色键；定格 Panel#3 SPR 3 种角度 × 6 面）。
// 由 uiStore.dice 驱动（UiPresenter：rolling → 落定 → 停留）：滚动时用 skin/flic 的播放器循环播放对应颗数的 FLC
// （动画时钟驱动，倍速与 instant 一致），落定后换成定格面；素材缺失时画 CSS 骰子。落定 1.5 秒后自动收起。
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useClient } from '../../app/services';
import { useTx } from '../../i18n/tx';
import type { FlicPlayer } from '../../skin/flic';
import { useUiStore } from '../../store/uiStore';
import { diceFlicKey, useClassicAssets } from './assets';
import c from './classic.module.css';
import { DICE_FLC_RECT, regionStyle } from './layout';
import { Sprite } from './Sprite';

/** 落定后停留（真实时间）后收起 */
export const DICE_LINGER_MS = 1500;

/** 定格面的帧：第 i 颗用第 i 套角度（3 套 × 6 面） */
export function diceFaceFrame(i: number, face: number): number {
  return (i % 3) * 6 + ((((face - 1) % 6) + 6) % 6);
}

export function ClassicDice(): ReactNode {
  const t = useTx();
  const client = useClient();
  const d = useUiStore((s) => s.dice);
  const loadFlic = useClassicAssets((s) => s.loadFlic);
  const host = useRef<HTMLDivElement>(null);
  const players = useRef(new Map<string, FlicPlayer | null>());
  const [flicOn, setFlicOn] = useState(false);

  // 落定后自动收起（下一次掷骰会替换）
  useEffect(() => {
    if (!d || d.rolling) return;
    const id = setTimeout(() => {
      if (useUiStore.getState().dice?.id === d.id) useUiStore.getState().setDice(null);
    }, DICE_LINGER_MS);
    return () => clearTimeout(id);
  }, [d]);

  // 滚动：循环播放 FLC，直到落定或卸载
  const rollingId = d?.rolling ? d.id : null;
  const count = d?.faces.length ?? 1;
  useEffect(() => {
    if (rollingId === null || !loadFlic) return;
    const ac = new AbortController();
    const key = diceFlicKey(count);
    const cache = players.current;
    void (async () => {
      let p = cache.get(key);
      if (p === undefined) {
        p = await loadFlic(key, client.anim);
        cache.set(key, p);
      }
      const el = host.current;
      if (!p || !el || ac.signal.aborted) return;
      const canvas = p.canvas;
      if (!canvas || !(canvas instanceof HTMLCanvasElement)) return;
      el.replaceChildren(canvas);
      setFlicOn(true);
      await p.play({ loop: true, signal: ac.signal });
    })().catch((e: unknown) => console.warn('[classic] 骰子 FLC 播放失败', e));
    return () => {
      ac.abort();
      setFlicOn(false);
      host.current?.replaceChildren();
    };
  }, [rollingId, count, loadFlic, client]);

  // 换了素材包（加载器）或卸载：释放已建的播放器
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只随加载器变化
  useEffect(() => {
    const cache = players.current;
    return () => {
      for (const p of cache.values()) p?.destroy();
      cache.clear();
    };
  }, [loadFlic]);

  if (!d) return null;
  const sum = d.faces.reduce((a, b) => a + b, 0);
  return (
    <div
      className={c.dice}
      style={regionStyle(DICE_FLC_RECT)}
      data-testid="dice-overlay"
      data-rolling={d.rolling ? 'true' : 'false'}
      data-sum={sum}
      data-flic={flicOn ? 'true' : 'false'}
    >
      <div ref={host} hidden={!d.rolling} />
      {(!d.rolling || !flicOn) && (
        <div className={c.diceFaces}>
          {d.faces.map((f, i) => (
            <Sprite
              // biome-ignore lint/suspicious/noArrayIndexKey: 骰子位置固定
              key={i}
              sheet="ui.diceFaces"
              frame={diceFaceFrame(i, d.rolling ? ((i * 2 + 3) % 6) + 1 : f)}
              fallback={
                <span className={c.dieFallback} data-rolling={d.rolling ? 'true' : 'false'}>
                  {d.rolling ? '?' : f}
                </span>
              }
            />
          ))}
        </div>
      )}
      {!d.rolling && <span className={`${c.diceSum} ${c.outline}`}>{t('hud:dice.sum', { n: sum })}</span>}
    </div>
  );
}
