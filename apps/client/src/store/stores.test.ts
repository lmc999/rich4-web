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
import {
  DEFAULT_VOLUME,
  migrateSettings,
  normalizeNickname,
  normalizeVolume,
  SETTINGS_VERSION,
  useSettingsStore,
} from './settingsStore';
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

  it('relocalizeLog：只重排带来源的行；返回 null 或文字不变时保留原行（状态不变时不触发更新）', () => {
    const g = useGameStore.getState();
    g.clear();
    const src = { event: { type: 'MONEY' } as never, view: {} as never };
    g.pushLog([
      { seq: 1, type: 'MONEY', text: '简体', date: 0, src },
      { seq: 2, type: 'MONEY', text: '无来源', date: 0 },
    ]);
    useGameStore.getState().relocalizeLog(() => '繁體');
    expect(useGameStore.getState().log.map((l) => l.text)).toEqual(['繁體', '无来源']);
    const same = useGameStore.getState().log;
    useGameStore.getState().relocalizeLog(() => '繁體');
    useGameStore.getState().relocalizeLog(() => null);
    expect(useGameStore.getState().log).toBe(same);
    g.clear();
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
    s.setVolume({ ui: 5 });
    expect(useSettingsStore.getState().volume.ui).toBe(1);
    s.setVolume({ ...DEFAULT_VOLUME });
  });

  it('音频默认值：语音开、后台静音开、界面音 0.8', () => {
    const st = useSettingsStore.getState();
    expect(st.voiceEnabled).toBe(true);
    expect(st.muteInBackground).toBe(true);
    expect(DEFAULT_VOLUME.ui).toBe(0.8);
  });

  it('持久化 v1 → v2：界面音跟随音效，语音与后台静音缺省开启；已有值保留', () => {
    expect(SETTINGS_VERSION).toBe(2);
    const v1 = { nickname: '阿土', volume: { master: 0.5, bgm: 0.4, sfx: 0.3, voice: 0.2 }, muted: true };
    expect(migrateSettings(v1, 1)).toEqual({
      ...v1,
      volume: { master: 0.5, bgm: 0.4, sfx: 0.3, voice: 0.2, ui: 0.3 },
      voiceEnabled: true,
      muteInBackground: true,
    });
    expect(migrateSettings({ voiceEnabled: false, muteInBackground: false }, 1)).toMatchObject({
      volume: DEFAULT_VOLUME,
      voiceEnabled: false,
      muteInBackground: false,
    });
    const v2 = { volume: { ...DEFAULT_VOLUME, ui: 0.1 } };
    expect(migrateSettings(v2, 2)).toBe(v2);
    expect(normalizeVolume({ master: 'x', bgm: 3, sfx: 0.5 })).toEqual({
      master: DEFAULT_VOLUME.master,
      bgm: 1,
      sfx: 0.5,
      voice: DEFAULT_VOLUME.voice,
      ui: 0.5,
    });
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
