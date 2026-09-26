// 在开发 / 测试模式下把 store、EventPlayer、客户端挂到 window.__rich4（见 dev/testHooks.ts）
import { testHooks } from '../dev/testHooks';
import type { GameClient } from '../net/client';
import { useChatStore } from '../store/chatStore';
import { useConnectionStore } from '../store/connectionStore';
import { useGameStore } from '../store/gameStore';
import { useMapStore } from '../store/mapStore';
import { useRoomStore } from '../store/roomStore';
import { useSettingsStore } from '../store/settingsStore';
import { useUiStore } from '../store/uiStore';
import { testHooksEnabled } from './flags';

export function installTestHooks(client: GameClient): void {
  if (!testHooksEnabled()) return;
  const h = testHooks();
  if (!h) return;
  h.store = {
    game: useGameStore,
    room: useRoomStore,
    ui: useUiStore,
    connection: useConnectionStore,
    chat: useChatStore,
    settings: useSettingsStore,
    map: useMapStore,
  };
  const p = client.player;
  h.eventPlayer = {
    get idle() {
      return p.idle;
    },
    whenIdle: () => p.whenIdle(),
    skipAll: () => p.skipAll(),
  };
  h.client = client;
}
