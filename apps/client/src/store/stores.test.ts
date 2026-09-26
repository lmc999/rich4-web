// store 与纯函数：房间派生查询、决策锁定、设置、聊天未读、建房草稿
import { describe, expect, it } from 'vitest';
import { ai, human, roomView, seat } from '../test/roomFixtures';
import { selfPlay } from '../test/selfPlay';
import {
  applyQuickPreset,
  defaultDraft,
  draftFromSettings,
  draftToPatch,
  fetchMapList,
} from '../ui/lobby/settingsDraft';
import { useChatStore } from './chatStore';
import { currentSeat, playerOf, useGameStore } from './gameStore';
import { canStart, isHost, mySeat, seatDisplayName } from './roomStore';
import { normalizeNickname, useSettingsStore } from './settingsStore';
import { TOAST_LIMIT, useUiStore } from './uiStore';

describe('roomStore 派生查询', () => {
  it('mySeat / isHost / seatDisplayName', () => {
    const r = roomView();
    expect(mySeat(r)).toBe(0);
    expect(isHost(r)).toBe(true);
    expect(seatDisplayName(r, 0)).toBe('房主');
    expect(seatDisplayName(r, 1)).toBeNull();
    expect(mySeat(roomView({ you: { role: 'spectator', id: 'x', isHost: false } }))).toBeNull();
  });

  it('canStart：房主、≥2 名参与者、其他真人都已准备', () => {
    expect(canStart(roomView())).toBe(false);
    const withAi = roomView({ seats: [human(0, 'A', { host: true, isYou: true }), ai(1), seat(2), seat(3)] });
    expect(canStart(withAi)).toBe(true);
    const unready = roomView({ seats: [human(0, 'A', { host: true }), human(1, 'B'), seat(2), seat(3)] });
    expect(canStart(unready)).toBe(false);
    const ready = roomView({
      seats: [human(0, 'A', { host: true }), human(1, 'B', { ready: true }), seat(2), seat(3)],
    });
    expect(canStart(ready)).toBe(true);
    expect(canStart({ ...ready, you: { role: 'player', seat: 1, isHost: false } })).toBe(false);
    expect(canStart({ ...ready, phase: 'playing' })).toBe(false);
  });
});

describe('gameStore', () => {
  const sp = selfPlay({ seed: 9, steps: 20 });
  const withDecision = sp.batches.find((b) => b.yourDecision)!;

  it('提交锁定：同一决策保持锁定，新决策或无决策时解锁', () => {
    const g = useGameStore.getState();
    g.resetTo({ epoch: 1, seq: 0, view: sp.initial.view, pending: [], decision: null });
    g.setSubmitting('d1');
    useGameStore.getState().commitBatch({
      epoch: 1,
      seq: 1,
      view: sp.initial.view,
      pending: [],
      decision: { ...withDecision.yourDecision!, decisionId: 'd1' },
      cause: null,
    });
    expect(useGameStore.getState().submitting).toBe('d1');
    useGameStore.getState().commitPending([], { ...withDecision.yourDecision!, decisionId: 'd2' });
    expect(useGameStore.getState().submitting).toBeNull();
    useGameStore.getState().clear();
  });

  it('beginBatch：过时的决策收起；同一座位重发的回合菜单 / 商店保留到批尾', () => {
    const menu = sp.batches.find((b) => b.yourDecision?.kind === 'TURN_MENU')!.yourDecision!;
    const g = useGameStore.getState();
    g.resetTo({ epoch: 1, seq: 0, view: sp.initial.view, pending: [], decision: { ...menu, decisionId: 'm1' } });
    useGameStore.getState().beginBatch({ ...menu, decisionId: 'm2' });
    expect(useGameStore.getState().decision?.decisionId).toBe('m1');
    useGameStore.getState().beginBatch({ ...menu, seat: ((menu.seat + 1) % 4) as typeof menu.seat, decisionId: 'x' });
    expect(useGameStore.getState().decision).toBeNull();
    useGameStore.getState().resetTo({
      epoch: 1,
      seq: 0,
      view: sp.initial.view,
      pending: [],
      decision: { ...menu, decisionId: 'm3' },
    });
    useGameStore.getState().beginBatch(null);
    expect(useGameStore.getState().decision).toBeNull();
    useGameStore.getState().clear();
  });

  it('日志最多保留 200 条；playerOf / currentSeat', () => {
    const g = useGameStore.getState();
    g.pushLog(Array.from({ length: 250 }, (_, i) => ({ seq: i, type: 'MONEY' as const, text: `#${i}`, date: 0 })));
    expect(useGameStore.getState().log).toHaveLength(200);
    expect(useGameStore.getState().log[0]?.text).toBe('#50');
    expect(playerOf(sp.initial.view, 0)?.seat).toBe(0);
    expect(playerOf(sp.initial.view, null)).toBeNull();
    expect(currentSeat(sp.initial.view)).toBe(0);
    useGameStore.getState().clear();
  });
});

describe('settings', () => {
  it('昵称清洗；音量夹到 0..1；速度持久', () => {
    expect(normalizeNickname('  小​美  ')).toBe('小美');
    expect(normalizeNickname('   ')).toBeNull();
    const s = useSettingsStore.getState();
    s.setNickname('阿土');
    expect(useSettingsStore.getState().nickname).toBe('阿土');
    s.setNickname('   ');
    expect(useSettingsStore.getState().nickname).toBe('阿土');
    s.setVolume({ master: 2, bgm: -1 });
    expect(useSettingsStore.getState().volume.master).toBe(1);
    expect(useSettingsStore.getState().volume.bgm).toBe(0);
    s.setSpeed(3);
    expect(useSettingsStore.getState().speed).toBe(3);
    s.setSpeed(1);
  });
});

describe('chat / ui', () => {
  it('未读计数：面板不可见时累计，系统消息不计；可见时清零；消息去重', () => {
    const c = useChatStore.getState();
    c.clear();
    c.setVisible(false);
    const m = { id: 'a', ts: 1, from: { kind: 'seat', seat: 0, nickname: 'A' }, text: 'hi', audience: 'all' } as const;
    c.add(m);
    c.add(m);
    c.add({ id: 'b', ts: 2, from: { kind: 'system' }, system: { key: 'gameResumed', params: {} }, audience: 'all' });
    expect(useChatStore.getState().messages).toHaveLength(2);
    expect(useChatStore.getState().unread).toBe(1);
    expect(useChatStore.getState().bubbles[0]?.text).toBe('hi');
    useChatStore.getState().setVisible(true);
    expect(useChatStore.getState().unread).toBe(0);
  });

  it('toast 最多同时 5 条；横幅按 id 收起', () => {
    const u = useUiStore.getState();
    u.clear();
    for (let i = 0; i < 8; i++) u.toast(`t${i}`);
    expect(useUiStore.getState().toasts).toHaveLength(TOAST_LIMIT);
    const id = u.showBanner({ kind: 'turn', title: 'x' });
    u.hideBanner(id + 1);
    expect(useUiStore.getState().banner).not.toBeNull();
    u.hideBanner(id);
    expect(useUiStore.getState().banner).toBeNull();
    u.togglePanel('info');
    expect(useUiStore.getState().panel).toBe('info');
    u.togglePanel('info');
    expect(useUiStore.getState().panel).toBeNull();
  });
});

describe('建房草稿', () => {
  it('draft ↔ patch；快速局；从房间设置回填', () => {
    const d = applyQuickPreset(defaultDraft('test'));
    expect(d.timeLimitDays).toBe(365);
    expect(d.winMultiple).toBe(10);
    const p = draftToPatch({ ...d, rulePreset: 'manual', visibility: 'public', timerPreset: 'fast' });
    expect(p).toMatchObject({
      visibility: 'public',
      timerPreset: 'fast',
      game: { mapId: 'test', timeLimitDays: 365, winMultiple: 10, rules: { preset: 'manual' } },
    });
    const back = draftFromSettings(roomView().settings);
    expect(back.mapId).toBe('test');
    expect(back.aiCount).toBe(0);
  });

  it('地图目录：服务器不可达时退回 fixture；过滤不可开局的地图', async () => {
    const off = await fetchMapList(() => Promise.reject(new Error('down')));
    expect(off.maps.map((m) => m.id)).toEqual(['test', 'test-allkinds']);
    const on = await fetchMapList(async () => ({
      ok: true,
      json: async () => ({
        defaultMap: 'taiwan',
        maps: [
          { id: 'taiwan', mapHash: 'a', playable: true },
          { id: 'x', mapHash: 'b', playable: false },
        ],
      }),
    }));
    expect(on).toEqual({ defaultMap: 'taiwan', maps: [{ id: 'taiwan', mapHash: 'a', playable: true }] });
  });
});
