// 跨包一致性（architecture §8「viewFold.test.ts」）：真实引擎自对弈，每个 batch 都满足
// fold(applyPostPatch, 上一批的 view, 本批事件) ≡ 本批的 view（= projectState）。客户端 viewReducer 就是 shared 的 applyPostPatch。
// 另外让同样的批次流过 EventPlayer（instant 模式、开发对账开启），断言没有对账告警、最终显示态等于最后一批的 view。
import type { GameView } from '@rich4/shared/view';
import { applyPostPatch, findHandLeaks } from '@rich4/shared/view';
import { describe, expect, it } from 'vitest';
import { AnimClock } from '../game/anim/AnimClock';
import { selfPlay } from '../test/selfPlay';
import { EventPlayer } from './EventPlayer';
import type { HandlerMap } from './types';

const SEEDS = 20;
const STEPS = 300;

function fold(view: GameView, events: readonly { post?: Parameters<typeof applyPostPatch>[1] }[]): GameView {
  let v = view;
  for (const e of events) v = applyPostPatch(v, e.post);
  return v;
}

describe('viewFold：fold(applyPostPatch) == projectState', () => {
  it(`${SEEDS} 个种子 × ${STEPS} 个 action（公开手牌，座位 0 视角）`, { timeout: 120_000 }, () => {
    let batches = 0;
    let events = 0;
    for (let seed = 0; seed < SEEDS; seed++) {
      const sp = selfPlay({ seed, steps: STEPS });
      let view = sp.initial.view;
      for (const b of sp.batches) {
        const folded = fold(view, b.events);
        expect(folded, `seed ${seed} seq ${b.seq}`).toEqual(b.view);
        expect(b.events.some((e) => e.type === 'SYNC')).toBe(false);
        view = b.view;
        batches++;
        events += b.events.length;
      }
    }
    expect(batches).toBeGreaterThan(SEEDS * 100);
    expect(events).toBeGreaterThan(batches);
  });

  it('私密手牌：座位视角与观战视角都能折叠一致（cards / items 改写为 null + 张数与总数，pools 为 null），且逐批没有泄漏', {
    timeout: 60_000,
  }, () => {
    const redacted = new Set<string>();
    for (const viewer of [{ kind: 'seat', seat: 1 } as const, { kind: 'spectator' } as const]) {
      const own = viewer.kind === 'seat' ? viewer.seat : null;
      for (let seed = 0; seed < 4; seed++) {
        const sp = selfPlay({ seed, steps: 200, viewer, handVisibility: 'private' });
        let view = sp.initial.view;
        expect(findHandLeaks({ view }, own)).toEqual([]);
        for (const b of sp.batches) {
          expect(fold(view, b.events), `${viewer.kind} seed ${seed} seq ${b.seq}`).toEqual(b.view);
          // 深度扫描这一批下发的视图与事件：别人手牌的卡号、道具号、牌堆张数一律不出现
          expect(
            findHandLeaks({ view: b.view, events: b.events }, own),
            `${viewer.kind} seed ${seed} seq ${b.seq}`,
          ).toEqual([]);
          for (const e of b.events) {
            if ((e.type === 'ITEM_GAINED' || e.type === 'ITEM_LOST') && e.item === null) redacted.add(e.type);
            if ((e.type === 'CARD_GAINED' || e.type === 'CARD_LOST') && e.card === null) redacted.add(e.type);
          }
          view = b.view;
        }
        // 私密模式下对手的卡片与道具不可见，张数与总数照常
        expect(view.pools).toBeNull();
        for (const p of view.players) {
          if (p.seat === own) {
            expect(p.cards).not.toBeNull();
            expect(p.items).not.toBeNull();
          } else {
            expect(p.cards).toBeNull();
            expect(p.items).toBeNull();
          }
          expect(typeof p.itemCount).toBe('number');
        }
      }
    }
    // 自对弈里确实出现过被脱敏的得失事件（否则这条测试没有覆盖到事件脱敏）
    expect([...redacted].sort()).toEqual(expect.arrayContaining(['CARD_GAINED']));
  });

  it('同样的批次流过 EventPlayer（instant）：没有批尾对账告警，显示态等于最后一批的 view', async () => {
    const warns: string[] = [];
    const clock = new AnimClock();
    let last: GameView | null = null;
    const noop = async (): Promise<void> => {};
    const handlers = new Proxy({}, { get: () => noop }) as HandlerMap;
    const player = new EventPlayer({
      handlers,
      clock,
      dev: true,
      warn: (m) => warns.push(m),
      requestResync: () => warns.push('resync'),
      context: () => {
        throw new Error('instant 模式不应调用 handler');
      },
      sink: {
        reset: (s) => {
          last = s.view;
        },
        commitView: (v) => {
          last = v;
        },
        commitBatch: (b) => {
          last = b.view;
        },
        commitPending: () => {},
        setAnim: () => {},
      },
    });
    player.setInstant(true);
    for (let seed = 0; seed < 3; seed++) {
      const sp = selfPlay({ seed, steps: 150 });
      player.reset(sp.initial);
      for (const b of sp.batches) player.enqueue(b);
      await player.whenIdle();
      expect(warns).toEqual([]);
      expect(last).toEqual(sp.batches.at(-1)?.view);
    }
  });
});
