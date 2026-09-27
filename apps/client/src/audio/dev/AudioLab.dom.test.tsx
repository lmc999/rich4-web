// /dev/audio 试听页：无素材包时只列 ZzFX；注入映射表后列出场景曲、音效集、角色语音与事件映射，点击可播放。
import { GAME_EVENT_TYPES } from '@rich4/shared/engine';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { createAudioSystem } from '../index';
import { FakeAudioWorld, flushMicrotasks } from '../testing/fakeAudio';
import { testAudioMaps } from '../testing/fixtures';
import { AudioLab } from './AudioLab';

function renderLab(withMaps: boolean) {
  const world = new FakeAudioWorld();
  const system = createAudioSystem({ env: world.env(), unlockOnGesture: false });
  if (withMaps) system.director.setMaps(testAudioMaps());
  const { hook } = memoryLocation({ path: '/dev/audio' });
  const view = render(
    <Router hook={hook}>
      <AudioLab system={system} loadManifest={() => Promise.resolve(null)} />
    </Router>,
  );
  return { world, system, view };
}

describe('AudioLab', () => {
  it('无素材包：显示回退状态，事件映射覆盖全部事件类型，ZzFX 预设可播', async () => {
    const { world, system } = renderLab(false);
    await waitFor(() => expect(screen.getByTestId('audio-pack')).toHaveTextContent('无'));
    fireEvent.click(screen.getByTestId('audio-tab-events'));
    const rows = screen.getByTestId('audio-events').querySelectorAll('tr[data-event]');
    expect(rows.length).toBe(GAME_EVENT_TYPES.length);
    fireEvent.click(screen.getByTestId('audio-tab-sfx'));
    await act(async () => {
      await system.engine.unlock();
    });
    expect(system.engine.state).toBe('running');
    const coin = screen.getByTestId('audio-sfx').querySelector('button[data-key="zzfx.coin"]')!;
    expect(coin).not.toBeNull();
    system.dispose();
    expect(world.ctx!.state).toBe('closed');
  });

  it('有映射表：场景曲进出、角色语音与音效集列表', async () => {
    const { system } = renderLab(true);
    // loadManifest 返回 null 会把映射表清空；等它完成后重新注入
    await waitFor(() => expect(screen.getByTestId('audio-pack')).toHaveTextContent('无'));
    act(() => system.director.setMaps(testAudioMaps()));
    await act(async () => {
      await system.engine.unlock();
      await flushMicrotasks();
    });
    const bank = screen.getByTestId('audio-music').querySelector('tr[data-scene="bank"] button')!;
    fireEvent.click(bank);
    expect(system.engine.musicSnapshot()?.layers).toEqual(['music.scene-bank']);
    fireEvent.click(bank);
    expect(system.engine.musicSnapshot()?.layers).toEqual([]);
    fireEvent.click(screen.getByTestId('audio-tab-voice'));
    expect(screen.getByTestId('audio-voice').querySelector('button[data-key="voice.c0.s26"]')).not.toBeNull();
    fireEvent.click(screen.getByTestId('audio-tab-sfx'));
    expect(screen.getByText('cue.land.buy')).toBeInTheDocument();
    system.dispose();
  });

  it('不注入 system：自建一套；StrictMode 的先卸载再挂载后引擎仍可用（不是 disposed），卸载时释放', async () => {
    const { hook } = memoryLocation({ path: '/dev/audio' });
    const view = render(
      <StrictMode>
        <Router hook={hook}>
          <AudioLab loadManifest={() => Promise.resolve(null)} />
        </Router>
      </StrictMode>,
    );
    await waitFor(() => expect(screen.getByTestId('audio-pack')).toHaveTextContent('无'));
    // jsdom 没有 Web Audio：引擎为 disabled，但不能是被 StrictMode 第一次卸载 dispose 掉的那一套
    expect(screen.getByTestId('audio-state')).not.toHaveTextContent('disposed');
    view.unmount();
  });
});
