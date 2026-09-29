// 骰子（原版：滚骰 Panel#4/5/6 FLC 189×285，1/2/3 颗，绿色色键；定格 Panel#3 SPR 3 种角度 × 6 面）。
// 由 uiStore.dice 驱动（UiPresenter：rolling → 落定 → 停留），按原版掷骰函数 fcn.00418d0b 摆放与播放：
// - 位置：FLC 画点 (136,48) + 表 0x4730ac[方向槽]，相对人物锚点 (220,260) 换算（layout.diceFlcPlacement）：方向槽由棋盘的
//   throwDice 给出，人物在画面上的位置与镜头缩放由 actorScreen 给出——原版镜头每 tick 对准行动者，FLC 落在人物头顶一带；
//   我们的镜头可能偏移、拖动、关闭跟随，棋盘缩放也可能与舞台缩放不同，所以按人物实际的画面位置摆，FLC 与点数面按
//   棋盘缩放 / 舞台缩放同比缩放（人物不在视窗里时按人物在视窗中心摆）；显示期间逐帧读取人物位置（DiceState.locate），
//   镜头在这期间移动（拖动后恢复跟随、窗口缩放）时骰子仍贴着人物；
// - 滚动：颗数 = faces.length 选 FLC，36 帧只播一遍，每帧 DiceState.frameMs（原版按游戏速度 30 / 20 ms，覆盖 FLC 头部的
//   14 ms），动画时钟驱动（倍速与 instant 一致）；
// - 落定：换成 Panel#3 的点数面，第 i 颗画帧 6i+点数−1、画点为 FLC 左上 +(0x55,0x91)（0x418de8–0x418e1c），三套角度的锚点把
//   它们摆到 FLC 底部的左、中、右，与 FLC 末帧的骰子重合；素材缺失时在同样的位置画 CSS 骰子；
// - 收起：落定后停留 holdMs（原版忙等 500 ms 后起步、棋盘重画把它擦掉）。原版没有点数合计的文字，只留给读屏。
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useClient } from '../../app/services';
import { useTx } from '../../i18n/tx';
import { DICE_HOLD_MS } from '../../presentation/UiPresenter';
import type { FlicPlayer } from '../../skin/flic';
import { type DiceAnchor, type DiceState, useUiStore } from '../../store/uiStore';
import { diceFlicKey, useClassicAssets } from './assets';
import c from './classic.module.css';
import { DICE_FACE_FALLBACK, DICE_FACE_POINT, DICE_FLC_H, DICE_FLC_W, diceFlcPlacement } from './layout';
import { Sprite } from './Sprite';

/** 定格面的帧：第 i 颗用第 i 套角度（3 套 × 6 面） */
export function diceFaceFrame(i: number, face: number): number {
  return (i % 3) * 6 + ((((face - 1) % 6) + 6) % 6);
}

function sameAnchor(a: DiceAnchor | null, b: DiceAnchor | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a.x - b.x) < 0.25 && Math.abs(a.y - b.y) < 0.25 && a.w === b.w && a.h === b.h && a.zoom === b.zoom;
}

/**
 * 骰子显示期间人物在画布上的位置：先用掷骰时取的 at，再逐帧读 locate（位置变了才重画）；没有 locate 或没有 rAF 时只用 at。
 * 读到的位置记着来自哪一次掷骰的 locate：换成下一次掷骰时不会先用上一次的位置画一帧
 */
function useDiceAnchor(d: DiceState | null): DiceAnchor | null {
  const locate = d?.locate;
  const [live, setLive] = useState<{ from: () => DiceAnchor | null; at: DiceAnchor } | null>(null);
  useEffect(() => {
    if (!locate || typeof requestAnimationFrame !== 'function') return;
    let last: DiceAnchor | null = null;
    let raf = 0;
    const tick = (): void => {
      const a = locate();
      if (a !== null && !sameAnchor(a, last)) {
        last = a;
        setLive({ from: locate, at: a });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [locate]);
  return live !== null && live.from === locate ? live.at : (d?.at ?? null);
}

/** 滚骰 FLC 只播一遍的计划：36 帧，每帧 frameMs */
function oncePlan(frames: number, frameMs: number) {
  const list = Array.from({ length: frames }, (_, i) => i);
  return { frames: list, frameMs, speed: 1, trimmed: false, skipped: false, durationMs: frames * frameMs };
}

export function ClassicDice(): ReactNode {
  const t = useTx();
  const client = useClient();
  const d = useUiStore((s) => s.dice);
  const loadFlic = useClassicAssets((s) => s.loadFlic);
  const host = useRef<HTMLDivElement>(null);
  const players = useRef(new Map<string, FlicPlayer | null>());
  const [flicOn, setFlicOn] = useState(false);
  const at = useDiceAnchor(d);

  // 落定后停留 holdMs（动画时钟）就收起：原版起步时棋盘重画把骰子擦掉（下一次掷骰会替换）
  useEffect(() => {
    if (!d || d.rolling) return;
    const ac = new AbortController();
    void client.anim.wait(d.holdMs ?? DICE_HOLD_MS, ac.signal).then(() => {
      if (!ac.signal.aborted && useUiStore.getState().dice?.id === d.id) useUiStore.getState().setDice(null);
    });
    return () => ac.abort();
  }, [d, client]);

  // 预取三段 FLC 的播放器：第一次掷骰不因下载、解析而晚于「咚」
  useEffect(() => {
    if (!loadFlic) return;
    const ac = new AbortController();
    const cache = players.current;
    for (const n of [1, 2, 3]) {
      const key = diceFlicKey(n);
      if (cache.has(key)) continue;
      void loadFlic(key, client.anim)
        .then((p) => {
          // 换了素材包（或卸载）之后才载完、或滚动时已经载好了同一段：丢掉这一个
          if (ac.signal.aborted || cache.has(key)) p?.destroy();
          else cache.set(key, p);
        })
        .catch(() => {});
    }
    return () => ac.abort();
  }, [loadFlic, client]);

  // 滚动：FLC 只播一遍（停在末帧），直到落定或卸载
  const rollingId = d?.rolling ? d.id : null;
  const count = d?.faces.length ?? 1;
  const frameMs = d?.frameMs ?? null;
  useEffect(() => {
    if (rollingId === null || !loadFlic) return;
    const ac = new AbortController();
    const key = diceFlicKey(count);
    const cache = players.current;
    void (async () => {
      let p = cache.get(key);
      if (p === undefined) {
        p = await loadFlic(key, client.anim);
        if (cache.has(key)) p?.destroy();
        else cache.set(key, p);
        p = cache.get(key);
      }
      const el = host.current;
      if (!p || !el || ac.signal.aborted) return;
      const canvas = p.canvas;
      if (!canvas || !(canvas instanceof HTMLCanvasElement)) return;
      el.replaceChildren(canvas);
      setFlicOn(true);
      await p.playPlan(oncePlan(p.frames, frameMs ?? p.frameMs), ac.signal);
    })().catch((e: unknown) => console.warn('[classic] 骰子 FLC 播放失败', e));
    return () => {
      ac.abort();
      setFlicOn(false);
      host.current?.replaceChildren();
    };
  }, [rollingId, count, frameMs, loadFlic, client]);

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
  const place = diceFlcPlacement(d.slot, at);
  return (
    <div
      className={c.dice}
      style={{
        left: place.x,
        top: place.y,
        width: DICE_FLC_W,
        height: DICE_FLC_H,
        ...(place.scale !== 1 ? { transform: `scale(${place.scale})`, transformOrigin: '0 0' } : {}),
      }}
      data-testid="dice-overlay"
      data-rolling={d.rolling ? 'true' : 'false'}
      data-sum={sum}
      data-seat={d.seat}
      data-count={d.faces.length}
      data-slot={d.slot ?? ''}
      data-scale={place.scale}
      data-tracked={place.tracked ? 'true' : 'false'}
      data-flic={flicOn ? 'true' : 'false'}
    >
      <div ref={host} hidden={!d.rolling} />
      {(!d.rolling || !flicOn) && (
        <div className={c.diceFaces}>
          {d.faces.map((f, i) => {
            const face = d.rolling ? ((i * 2 + 3) % 6) + 1 : f;
            const [fx, fy] = DICE_FACE_FALLBACK[i % 3]!;
            return (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: 骰子位置固定
                key={i}
                data-testid="dice-face"
                data-index={i}
                data-face={d.rolling ? '' : f}
                data-frame={diceFaceFrame(i, face)}
              >
                <Sprite
                  sheet="ui.diceFaces"
                  frame={diceFaceFrame(i, face)}
                  x={DICE_FACE_POINT.x}
                  y={DICE_FACE_POINT.y}
                  fallback={
                    <span
                      className={c.dieFallback}
                      style={{ left: fx, top: fy }}
                      data-rolling={d.rolling ? 'true' : 'false'}
                    >
                      {d.rolling ? '?' : f}
                    </span>
                  }
                />
              </span>
            );
          })}
        </div>
      )}
      {!d.rolling && <span className={c.srOnly}>{t('hud:dice.sum', { n: sum })}</span>}
    </div>
  );
}
