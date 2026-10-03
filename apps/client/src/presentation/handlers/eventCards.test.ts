// 随机事件的原版画面（handler 层）：命运板的节拍、原文与加持消息框、新闻板的节拍与跳过、卡片格 / 聖誕節得卡亮卡
// （含私密手牌下别人的消息框）、董事长赠品的文案。原版皮肤由登记的弹窗判定（popupStore.registerClassicPopupProbe）模拟，记录打开的弹窗、舞台与音频调用。
import { cardDef, type GameEvent, type GameEventOf, type GameEventType, type SeatIndex } from '@rich4/shared/engine';
import {
  CARD_GAIN_FOCUS_MS,
  CARD_SHOW_MS,
  FATE_VOICE_MS,
  fateShowMs,
  type GameView,
  NEWS_VOICE_MS,
  newsShowMs,
} from '@rich4/shared/view';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AnimClock } from '../../game/anim/AnimClock';
import { initI18n } from '../../i18n';
import { tx } from '../../i18n/tx';
import { useUiStore } from '../../store/uiStore';
import { selfPlay } from '../../test/selfPlay';
import { type OpenPopup, registerClassicPopupProbe, usePopupStore } from '../../ui/popups/popupStore';
import { makeNames } from '../names';
import { CARD_SHOW_SFX, cardGainVoice, NEWS_STING_SFX, SOUND_MAP } from '../soundMap';
import type { AudioPort, BoardPort, PresentationContext } from '../types';
import { createUiPresenter } from '../UiPresenter';
import { RAW_HANDLERS } from '.';
import { setPacingOverride } from './budget';
import { FATE_AFTER_BOARD, postShowsEffect } from './events';
import { FATE_LOT_FOCUS_MS } from './property';
import { recordingStage, type StageCall } from './testStage';

beforeAll(() => {
  initI18n('original');
});

beforeEach(() => {
  usePopupStore.getState().clear();
  useUiStore.getState().clear();
});

let unprobe: (() => void) | null = null;
afterEach(() => {
  unprobe?.();
  unprobe = null;
  setPacingOverride(null);
});

/** 原版皮肤：弹窗宿主挂着、素材就绪 */
function classicSkin(): void {
  unprobe = registerClassicPopupProbe(() => true);
}

type Call = [string, ...unknown[]];

const base = selfPlay({ seed: 3, steps: 2 }).initial.view;
const view: GameView = base;

interface Run {
  calls: Call[];
  stage: StageCall[];
  popups: OpenPopup[];
  audio: Call[];
  toasts: string[];
  /** 时间线：弹窗打开、音频、舞台调用按发生顺序 */
  order: string[];
  /** 更细的时间线：order 之外另记弹窗关闭（close:<kind>:<phase>）与每次等待（wait:<ms>） */
  trace: string[];
}

async function run<T extends GameEventType>(
  e: GameEventOf<T>,
  o: { me?: SeatIndex | null; gm?: number | null; skipBoard?: boolean } = {},
): Promise<Run> {
  const calls: Call[] = [];
  const stage: StageCall[] = [];
  const popups: OpenPopup[] = [];
  const audio: Call[] = [];
  const order: string[] = [];
  const trace: string[] = [];
  const tag = (p: OpenPopup): string => `${p.kind}:${'phase' in p ? (p.phase ?? '') : ''}`;
  useUiStore.getState().clear();
  const off = usePopupStore.subscribe((st, prev) => {
    if (prev.current && prev.current.popupId !== st.current?.popupId) trace.push(`close:${tag(prev.current)}`);
    if (st.current && popups.at(-1)?.popupId !== st.current.popupId) {
      popups.push(st.current);
      order.push(`popup:${tag(st.current)}`);
      trace.push(`popup:${tag(st.current)}`);
      // 模拟玩家在命运板 / 新闻板上按键跳过
      if (o.skipBoard && ((st.current.kind === 'fate' && st.current.phase === 'board') || st.current.kind === 'news')) {
        const id = st.current.popupId;
        queueMicrotask(() => usePopupStore.getState().skip(id));
      }
    }
  });
  const clock = new AnimClock();
  clock.instant = true;
  const rec =
    (name: string, ret?: unknown) =>
    (...a: unknown[]) => {
      calls.push([name, ...a.filter((x) => !(x instanceof AbortSignal))]);
      order.push(name);
      trace.push(name);
      return ret;
    };
  const board = {
    ready: true,
    syncView: rec('syncView'),
    walk: rec('walk', Promise.resolve()),
    placeActor: rec('placeActor'),
    hop: rec('hop', Promise.resolve()),
    setActorPose: rec('setActorPose'),
    setLot: rec('setLot'),
    focus: rec('focus', Promise.resolve()),
    follow: rec('follow'),
    floatText: rec('floatText'),
    coinFlight: rec('coinFlight', Promise.resolve()),
    plantFlag: rec('plantFlag', Promise.resolve()),
    popBuilding: rec('popBuilding', Promise.resolve()),
    pulseTile: rec('pulseTile'),
    shake: rec('shake'),
    clearFx: rec('clearFx'),
    stage: {
      ...recordingStage(stage),
      eventFlic: (x: GameEvent) => {
        stage.push(['eventFlic', x.type]);
        order.push('eventFlic');
        return Promise.resolve();
      },
    },
  } as unknown as BoardPort;
  const port: AudioPort = {
    play: (id) => audio.push(['play', id]),
    cue: (c) => {
      // 没有原版音效的提示（只有 ZzFX 预设）记成 zzfx:<预设>
      const id = c.cue ?? `zzfx:${c.zzfx}`;
      audio.push(['cue', id]);
      order.push(`cue:${id}`);
      trace.push(`cue:${id}`);
    },
    voices: (x) => {
      audio.push(['voices', x.type]);
      order.push('voices');
    },
    stopVoice: () => {
      audio.push(['stopVoice']);
      order.push('stopVoice');
    },
  };
  const me = o.me === undefined ? 0 : o.me;
  const gm = o.gm ?? null;
  const ctx: PresentationContext = {
    signal: new AbortController().signal,
    wait: (ms) => {
      trace.push(`wait:${ms}`);
      return clock.wait(ms);
    },
    board,
    ui: createUiPresenter({ wait: (ms, s) => clock.wait(ms, s) }),
    audio: port,
    me,
    role: me === null ? 'spectator' : 'player',
    view: () => view,
    map: null,
    names: { ...makeNames({ t: tx, view: () => view, map: () => null }), globalMapId: () => gm },
    t: tx,
  };
  // 不经封顶包装（假时钟 instant 下包装的预算计时会立刻到点、把后半段中止）
  const h = RAW_HANDLERS[e.type] as unknown as (x: GameEvent, c: PresentationContext) => Promise<void>;
  await h(e as GameEvent, ctx);
  off();
  const toasts = useUiStore.getState().toasts.map((t) => t.text);
  return { calls, stage, popups, audio, toasts, order, trace };
}

const names = (xs: readonly { 0: string }[]): string[] => xs.map((x) => x[0]);

// ───────────────────────── 命运板 ─────────────────────────

describe('FATE：原版命运板（fcn.0044c4a0）', () => {
  /** 本人（座位 0）现金变化 delta 的 post（showAllDeltas 会飘字 floatText） */
  const cashPost = (delta: number) => ({
    players: [{ seat: 0 as SeatIndex, set: { cash: view.players[0]!.cash + delta } }],
  });

  it('原版皮肤 · original：板子停「语音 ≥ 1.6 秒」（第 4 条留到 0.8 秒停顿结束），带 slot；没有头顶问号；程序化皮肤照旧翻面卡', async () => {
    setPacingOverride('original');
    classicSkin();
    const r = await run({ type: 'FATE', seat: 0, id: 4, amount: 1000, blessing: null });
    expect(r.popups).toHaveLength(1);
    const p = r.popups[0]!;
    expect(p).toMatchObject({ kind: 'fate', id: 4, slot: 4, phase: 'board', blessingText: null });
    expect(p.ms).toBe(FATE_VOICE_MS[4]! + 800);
    expect(r.stage.filter((c) => c[0] === 'bubble')).toHaveLength(0);
    unprobe?.();
    unprobe = null;
    const proc = await run({ type: 'FATE', seat: 0, id: 4, amount: 1000, blessing: null });
    expect(proc.stage.filter((c) => c[0] === 'bubble')).toHaveLength(1);
    expect(proc.popups[0]!.ms).toBe(FATE_VOICE_MS[4]! + 800);
  });

  it('处理函数参数 1 的画面（exe 0x473d14 逐项）：0、1 移镜头；2、3、4、5、8 留板；其余一开始就重画地图', () => {
    expect(FATE_AFTER_BOARD).toHaveLength(49);
    expect(FATE_AFTER_BOARD.slice(0, 9)).toEqual([
      'focusLot',
      'focusLot',
      'keep',
      'keep',
      'keep',
      'keep',
      'redraw',
      'redraw',
      'keep',
    ]);
    expect(FATE_AFTER_BOARD.slice(9).every((m) => m === 'redraw')).toBe(true);
  });

  it('重画地图的命运（第 14 条闯红灯）：板子只停语音长度 → 关板；罚金在随后的 MONEY 里，FATE 不再空等 0.8 秒', async () => {
    setPacingOverride('original');
    classicSkin();
    const t = fateShowMs(14, false, 'original');
    // 真实引擎：FATE 的 post 是空的（先发 FATE 再付罚金 → MONEY）
    const r = await run({ type: 'FATE', seat: 0, id: 14, amount: 3000, blessing: null });
    expect(r.popups.map((p) => p.ms)).toEqual([t.holdMs]);
    const i = r.trace.indexOf('close:fate:board');
    expect(i).toBeGreaterThan(0);
    expect(r.trace.slice(i)).toEqual(['close:fate:board', 'setActorPose', `wait:${t.endMs}`]);
  });

  it('重画地图、效果就在 FATE 的 post 里（第 32 条卡片道具折点券）：关板后立即飘字，再在地图上停 0.8 秒', async () => {
    setPacingOverride('original');
    classicSkin();
    const t = fateShowMs(32, false, 'original');
    const r = await run({ type: 'FATE', seat: 0, id: 32, amount: 300, blessing: null, post: cashPost(-3000) });
    expect(r.popups.map((p) => p.ms)).toEqual([t.holdMs]);
    const i = r.trace.indexOf('close:fate:board');
    expect(r.trace.slice(i)).toEqual([
      'close:fate:board',
      'floatText',
      `wait:${t.tailMs}`,
      'setActorPose',
      `wait:${t.endMs}`,
    ]);
    expect(postShowsEffect(undefined)).toBe(false);
    expect(postShowsEffect({ econ: {} })).toBe(false);
    expect(postShowsEffect(cashPost(1))).toBe(true);
  });

  it('留板的命运（第 3 条支票跳票）：板子留到 0.8 秒停顿结束，之后才同步', async () => {
    setPacingOverride('original');
    classicSkin();
    const t = fateShowMs(3, false, 'original');
    const r = await run({ type: 'FATE', seat: 0, id: 3, amount: null, blessing: null, post: cashPost(-500) });
    expect(r.popups.map((p) => p.ms)).toEqual([t.holdMs + t.tailMs]);
    const i = r.trace.indexOf('close:fate:board');
    expect(r.trace.slice(i)).toEqual(['close:fate:board', 'floatText', 'setActorPose', `wait:${t.endMs}`]);
  });

  it('拆屋（第 0 条）：板子只停语音长度、关板后不空等（镜头与拆除交给随后的 LOT_MUTATED）', async () => {
    setPacingOverride('original');
    classicSkin();
    const t = fateShowMs(0, false, 'original');
    const r = await run({ type: 'FATE', seat: 0, id: 0, amount: 4000, blessing: null });
    expect(r.popups.map((p) => p.ms)).toEqual([t.holdMs]);
    const i = r.trace.indexOf('close:fate:board');
    expect(r.trace.slice(i)).toEqual(['close:fate:board', 'setActorPose', `wait:${t.endMs}`]);
  });

  it('LOT_MUTATED：命运引起的先把镜头移到地块（原版 0x44a940 / 0x44aad8），震屏、变样期间镜头一直停在地块上；别的原因不移', async () => {
    const lot = view.lands[0]!.id;
    const r = await run({ type: 'LOT_MUTATED', lot, mode: 2, cause: { k: 'fate', ref: 0, by: null } });
    expect(r.calls.filter((c) => c[0] === 'focus')).toEqual([
      ['focus', { lot }, FATE_LOT_FOCUS_MS],
      ['focus', { lot }, 400],
      ['focus', { lot }, 300],
    ]);
    expect(r.trace.indexOf('focus')).toBeLessThan(r.trace.indexOf('shake'));
    // 总长 = 镜头 0.3 + 0.4 + 0.3 秒（≤ LOT_MUTATED 的预算 1.2 秒）
    expect(r.trace.filter((x) => x.startsWith('wait:'))).toEqual(['wait:400', 'wait:300']);
    const g = await run({ type: 'LOT_MUTATED', lot, mode: 2, cause: { k: 'god', ref: 1, by: null } });
    expect(names(g.calls)).not.toContain('focus');
    expect(g.trace.filter((x) => x.startsWith('wait:'))).toEqual(['wait:400', 'wait:300']);
  });

  it('有加持：板子停完 → 加持消息框 1.5 秒（phase blessing）→ 之后才同步金额（效果在消息框之后）→ 停 0.8 秒', async () => {
    setPacingOverride('original');
    classicSkin();
    const r = await run({ type: 'FATE', seat: 0, id: 25, amount: 10000, blessing: 'low', post: cashPost(-20000) });
    expect(r.popups.map((p) => (p.kind === 'fate' ? p.phase : p.kind))).toEqual(['board', 'blessing']);
    const t = fateShowMs(25, true, 'original');
    expect(r.popups[0]!.ms).toBe(t.holdMs);
    expect(r.popups[1]!.ms).toBe(1500);
    const i = r.trace.indexOf('close:fate:blessing');
    expect(r.trace.slice(i)).toEqual([
      'close:fate:blessing',
      'floatText',
      `wait:${t.tailMs}`,
      'setActorPose',
      `wait:${t.endMs}`,
    ]);
    expect(r.trace.indexOf('floatText')).toBeGreaterThan(r.trace.indexOf('popup:fate:blessing'));
    // 留板类（第 3 条）有加持时同样先重画再出消息框：板子不留到停顿结束
    const k = await run({ type: 'FATE', seat: 0, id: 3, amount: null, blessing: 'high' });
    expect(k.popups.map((p) => p.ms)).toEqual([fateShowMs(3, true, 'original').holdMs, 1500]);
    const h = await run({ type: 'FATE', seat: 0, id: 25, amount: 10000, blessing: 'high' });
    expect(h.popups[1]).toMatchObject({ kind: 'fate', blessingText: tx('events:blessing.reward_high') });
  });

  it('33–36 按地图换 slot（插图、表情、语音跟着换）：日本图第 33 条 → slot 41', async () => {
    setPacingOverride('original');
    classicSkin();
    const r = await run({ type: 'FATE', seat: 0, id: 33, amount: null, blessing: null }, { gm: 2 });
    expect(r.popups[0]).toMatchObject({ kind: 'fate', id: 33, slot: 41 });
    // 坐牢类重画地图：板子只停语音长度，0.8 秒停在地图上
    expect(r.popups[0]!.ms).toBe(Math.max(1600, FATE_VOICE_MS[41]!));
    const tw = await run({ type: 'FATE', seat: 0, id: 33, amount: null, blessing: null }, { gm: 0 });
    expect(tw.popups[0]).toMatchObject({ slot: 33 });
  });

  it('跳过命运板时连语音一起停（原版 fcn.00452c39 → fcn.00452bd6）；没跳过不停', async () => {
    setPacingOverride('original');
    classicSkin();
    const r = await run({ type: 'FATE', seat: 0, id: 3, amount: null, blessing: null }, { skipBoard: true });
    expect(r.audio).toContainEqual(['stopVoice']);
    const n = await run({ type: 'FATE', seat: 0, id: 3, amount: null, blessing: null });
    expect(n.audio).not.toContainEqual(['stopVoice']);
  });

  it('原版命运板只有语音、不放翻牌声；程序化翻面卡一开始放 ZzFX card（soundMap 标 timed，事件开始时不放）', async () => {
    expect(SOUND_MAP.FATE.sfx).toMatchObject({ zzfx: 'card', timed: true });
    expect(SOUND_MAP.FATE.sfx).not.toHaveProperty('cue');
    setPacingOverride('original');
    classicSkin();
    const r = await run({ type: 'FATE', seat: 0, id: 14, amount: 3000, blessing: null });
    expect(r.audio.filter((a) => a[0] === 'cue')).toEqual([]);
    unprobe?.();
    unprobe = null;
    const proc = await run({ type: 'FATE', seat: 0, id: 14, amount: 3000, blessing: null });
    expect(proc.audio.filter((a) => a[0] === 'cue')).toEqual([['cue', 'zzfx:card']]);
    expect(proc.order.indexOf('cue:zzfx:card')).toBeLessThan(proc.order.indexOf('popup:fate:board'));
  });

  it('compact：总长 2.25 秒不变（有加持时板子 1.35 + 消息框 0.9）', async () => {
    setPacingOverride('compact');
    classicSkin();
    const r = await run({ type: 'FATE', seat: 0, id: 25, amount: 10000, blessing: 'high' });
    expect(r.popups.map((p) => p.ms)).toEqual([1350, 900]);
    // 没有加持：重画类板子 2.25 秒（compact 没有停顿段），留板类同样 2.25 秒
    const n = await run({ type: 'FATE', seat: 0, id: 14, amount: 3000, blessing: null });
    expect(n.popups.map((p) => p.ms)).toEqual([2250]);
    const k = await run({ type: 'FATE', seat: 0, id: 3, amount: null, blessing: null });
    expect(k.popups.map((p) => p.ms)).toEqual([2250]);
    unprobe?.();
    unprobe = null;
    const proc = await run({ type: 'FATE', seat: 0, id: 25, amount: 10000, blessing: 'high' });
    expect(proc.popups.map((p) => p.ms)).toEqual([2250]);
  });
});

describe('FATE：原版原文（exe 各命运处理函数参数 0 分支的格式串）', () => {
  it('正文是原文整句，金额 / 天数是加持之前的（奖金 high、罚金 low 时事件金额已加倍）；金额行写实际收付', async () => {
    const r = await run({ type: 'FATE', seat: 0, id: 25, amount: 20000, blessing: 'high' });
    expect(r.popups[0]).toMatchObject({
      kind: 'fate',
      title: '继承遗产',
      text: '意外获得遗产10000元',
      textAmount: '10000',
      amountText: '+20,000',
    });
    const fine = await run({ type: 'FATE', seat: 0, id: 15, amount: 6000, blessing: 'low' });
    expect(fine.popups[0]).toMatchObject({ text: '骑机车未戴安全帽\n罚款3000元', textAmount: '3000' });
    const jail = await run({ type: 'FATE', seat: 0, id: 33, amount: null, blessing: 'low' });
    expect(jail.popups[0]).toMatchObject({ text: '酒醉大闹警局坐牢3天', textAmount: null });
    // 日本图的第 33 条（slot 41）
    const jp = await run({ type: 'FATE', seat: 0, id: 33, amount: null, blessing: null }, { gm: 2 });
    expect(jp.popups[0]).toMatchObject({ slot: 41, text: '诱骗未成年少女拘役3天' });
    // 原文不带金额的（第 0 条拆屋）：金额只在程序化翻面卡的金额行
    const demolish = await run({ type: 'FATE', seat: 0, id: 0, amount: 4000, blessing: null });
    expect(demolish.popups[0]).toMatchObject({ text: '强制拆除房屋一栋', textAmount: null, amountText: '+4,000' });
  });
});

// ───────────────────────── 新闻板 ─────────────────────────

describe('NEWS：原版新闻板（fcn.0044a173：fcn.00452c39(2400)，之后没有停顿）', () => {
  const news = (id: number): GameEventOf<'NEWS'> => ({ type: 'NEWS', id: id as never, params: {}, affected: [] });

  it('原版皮肤 · original：停「语音 ≥ 2.4 秒」、没有最短时间（任意键跳过）、不放提示音；之后收尾 0.2 秒', async () => {
    setPacingOverride('original');
    classicSkin();
    const r = await run(news(29));
    expect(r.popups).toHaveLength(1);
    expect(r.popups[0]).toMatchObject({ kind: 'news', id: 29, ms: NEWS_VOICE_MS[29], minMs: 0 });
    expect(r.audio.filter((a) => a[0] === 'cue')).toEqual([]);
    const i = r.trace.indexOf('close:news:');
    expect(r.trace.slice(i)).toEqual(['close:news:', `wait:${newsShowMs(29, 'original').endMs}`]);
    const short = await run(news(11));
    expect(short.popups[0]!.ms).toBe(2400);
  });

  it('跳过新闻板时连语音一起停；没跳过不停', async () => {
    setPacingOverride('original');
    classicSkin();
    const r = await run(news(11), { skipBoard: true });
    expect(r.audio).toContainEqual(['stopVoice']);
    const n = await run(news(11));
    expect(n.audio).not.toContainEqual(['stopVoice']);
  });

  it('程序化新闻弹窗：开头放 ZzFX news（soundMap 标 timed，事件开始时不放）、最短 1.5 秒；compact 3.4 秒', async () => {
    expect(SOUND_MAP.NEWS.sfx).toBe(NEWS_STING_SFX);
    expect(NEWS_STING_SFX).toMatchObject({ zzfx: 'news', timed: true });
    setPacingOverride('original');
    const proc = await run(news(5));
    expect(proc.audio.filter((a) => a[0] === 'cue')).toEqual([['cue', 'zzfx:news']]);
    expect(proc.popups[0]).toMatchObject({ ms: NEWS_VOICE_MS[5], minMs: 1500 });
    setPacingOverride('compact');
    const c = await run(news(5));
    expect(c.popups[0]).toMatchObject({ ms: 3400, minMs: 1500 });
    classicSkin();
    const cc = await run(news(5));
    expect(cc.popups[0]).toMatchObject({ ms: 3400, minMs: 0 });
  });

  it('标题是原文（%s / %d 照原位插值，数字不带千分位）；分类名是原版的', async () => {
    const who = makeNames({ t: tx, view: () => view, map: () => null }).seat(1);
    const r = await run({ type: 'NEWS', id: 8, params: { seat: 1, amount: 12000 }, affected: [1] });
    expect(r.popups[0]).toMatchObject({
      kind: 'news',
      categoryLabel: '政府公告',
      headline: `公开表扬第一大地主\n${who}获得12000元奖励`,
    });
    const s = await run(news(16));
    expect(s.popups[0]).toMatchObject({ categoryLabel: '路况报导', headline: '豪雨特报\n行人休息一回合' });
  });
});

// ───────────────────────── 得卡亮卡 ─────────────────────────

describe('CARD_GAINED：卡片格 / 聖誕節亮卡（原版 0x41abfa / 0x450e29 → fcn.00440bac）', () => {
  it('卡片格 · 原版皮肤：FLIC → Effect#62 → 亮卡 1.5 秒（得到XX！）→ 按卡价说台词；不弹 toast、不飘 🃏', async () => {
    setPacingOverride('original');
    classicSkin();
    const r = await run({ type: 'CARD_GAINED', seat: 0, card: 17, source: 'square' });
    expect(r.popups).toHaveLength(1);
    expect(r.popups[0]).toMatchObject({
      kind: 'cardCast',
      variant: 'gain',
      gainFrom: 'square',
      card: 17,
      cardName: tx('cards:frame.name'),
    });
    expect(r.popups[0]!.ms).toBe(CARD_SHOW_MS.original.gainMs);
    expect(r.order.filter((x) => x !== 'focus')).toEqual(['eventFlic', 'cue:card.use', 'popup:cardCast:', 'voices']);
    expect(r.toasts).toEqual([]);
    expect(names(r.calls)).not.toContain('floatText');
  });

  it('私密手牌下别人：只有消息框（card null，没有卡图），不说按卡价分档的台词，时长相同', async () => {
    setPacingOverride('original');
    classicSkin();
    const r = await run({ type: 'CARD_GAINED', seat: 1, card: null, source: 'square' }, { me: 0 });
    expect(r.popups[0]).toMatchObject({ kind: 'cardCast', variant: 'gain', card: null, cardName: '' });
    expect(r.popups[0]!.ms).toBe(CARD_SHOW_MS.original.gainMs);
    expect(r.audio).not.toContainEqual(['voices', 'CARD_GAINED']);
    // 观战者同样
    const w = await run({ type: 'CARD_GAINED', seat: 1, card: null, source: 'holiday' }, { me: null });
    expect(w.popups[0]).toMatchObject({ card: null, gainFrom: 'holiday' });
  });

  it('聖誕節：镜头移到得卡的人（fcn.0041cc56）→ 亮卡「聖誕節…得到XX！」', async () => {
    setPacingOverride('original');
    classicSkin();
    const r = await run({ type: 'CARD_GAINED', seat: 2, card: 6, source: 'holiday' });
    expect(r.calls).toContainEqual(['focus', { seat: 2 }, CARD_GAIN_FOCUS_MS]);
    expect(r.popups[0]).toMatchObject({ variant: 'gain', gainFrom: 'holiday', card: 6 });
    expect(r.order.indexOf('focus')).toBeLessThan(r.order.indexOf('popup:cardCast:'));
    expect(r.stage.filter((c) => c[0] === 'eventFlic')).toHaveLength(0);
  });

  it('其他得卡途径（魔法屋、福神、抢夺…）原版不亮卡：toast 照旧；原版皮肤不飘 🃏，程序化皮肤照旧', async () => {
    setPacingOverride('original');
    classicSkin();
    const r = await run({ type: 'CARD_GAINED', seat: 0, card: 3, source: 'magic' });
    expect(r.popups).toHaveLength(0);
    expect(r.toasts).toHaveLength(1);
    expect(names(r.calls)).not.toContain('floatText');
    unprobe?.();
    unprobe = null;
    const proc = await run({ type: 'CARD_GAINED', seat: 0, card: 3, source: 'square' });
    expect(proc.popups).toHaveLength(0);
    expect(proc.calls).toContainEqual(['floatText', { seat: 0 }, '🃏', 'info']);
    expect(proc.toasts).toHaveLength(1);
    // 程序化皮肤也说按卡价的台词（与原版同序：得卡之后）
    expect(proc.audio).toContainEqual(['voices', 'CARD_GAINED']);
  });

  it('soundMap：卡片格 FLIC 带音效；聖誕節的 Effect#62 由 handler 放（timed）；台词按卡价分档、看不到卡号不说', () => {
    const rules = SOUND_MAP.CARD_GAINED;
    const sfx = rules.sfx as (e: GameEventOf<'CARD_GAINED'>) => unknown;
    expect(sfx({ type: 'CARD_GAINED', seat: 0, card: 3, source: 'square' })).toMatchObject({ flicCovered: true });
    expect(sfx({ type: 'CARD_GAINED', seat: 0, card: 3, source: 'holiday' })).toBe(CARD_SHOW_SFX);
    const voice = rules.voice as (e: GameEventOf<'CARD_GAINED'>) => unknown;
    expect(voice({ type: 'CARD_GAINED', seat: 1, card: null, source: 'square' })).toEqual([]);
    expect(voice({ type: 'CARD_GAINED', seat: 1, card: 3, source: 'shop' })).toEqual([]);
    expect(voice({ type: 'CARD_GAINED', seat: 1, card: 3, source: 'square' })).toEqual(cardGainVoice(1, 3));
    // 卡价分档：>100 槽 0；51–100 槽 0 / 1 二选一；1–50 槽 2（fcn.0044db5f）
    for (let k = 1; k <= 30; k++) {
      const price = cardDef(k as never).price;
      const [c] = cardGainVoice(0, k as never);
      expect(c?.timed).toBe(true);
      if (price > 100) expect(c).toMatchObject({ slot: 'pointsHigh' });
      else if (price > 50) expect(c).toMatchObject({ slot: 'pointsHigh', alt: ['pointsMid'] });
      else expect(c).toMatchObject({ slot: 'pointsLow' });
    }
  });
});

describe('CHAIRMAN_GIFT：toast 写明送的是什么（看得到的人）', () => {
  it('本人看到卡名 / 道具名；私密下别人只看到获得赠礼；原版皮肤不飘 🎁', async () => {
    classicSkin();
    const card = await run({ type: 'CHAIRMAN_GIFT', seat: 0, card: 17, item: null });
    expect(card.toasts[0]).toBe(
      tx('events:log.CHAIRMAN_GIFT_gift', {
        who: makeNames({ t: tx, view: () => view, map: () => null }).seat(0),
        gift: tx('cards:frame.name'),
      }),
    );
    expect(names(card.calls)).not.toContain('floatText');
    const hidden = await run({ type: 'CHAIRMAN_GIFT', seat: 1, card: null, item: null }, { me: 1 });
    expect(hidden.toasts.at(-1)).not.toContain('：');
  });
});
