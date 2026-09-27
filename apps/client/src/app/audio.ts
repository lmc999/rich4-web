// 音频入口（原版皮肤 A9）：首屏只放这个很轻的开关，音频引擎、导演层与接线（app/audioWiring.ts）在首次使用时懒加载。
// ?audio=off（E2E）或浏览器没有 Web Audio（jsdom）时不加载，GameClient 的事件声音钩子保持 null（静音）。
import type { GameClient } from '../net/client';
import { appFlags } from './flags';

let installing: Promise<void> | null = null;

/** 浏览器是否支持 Web Audio */
export function webAudioAvailable(g: object = globalThis): boolean {
  const w = g as { AudioContext?: unknown; webkitAudioContext?: unknown };
  return typeof w.AudioContext === 'function' || typeof w.webkitAudioContext === 'function';
}

/** 为全局 GameClient 装上音频（幂等；失败只告警，游戏照常无声进行） */
export function installAudio(client: GameClient): void {
  if (installing || appFlags().audioOff || !webAudioAvailable()) return;
  installing = import('./audioWiring')
    .then((m) => {
      m.wireAudio(client);
    })
    .catch((e: unknown) => {
      console.warn('[audio] 音频模块加载失败，本页静音', e);
    });
}
