// 事件声音钩子的接入（原版皮肤 A9）：用一层薄包装包住全部 handler，handler 开始前取当前钩子（运行时可替换：音频模块懒加载、
// ?audio=off 时一直为 null），开始时放音效 / 语音、结束（含封顶与中止）时收起事件场景曲。
// 声音永远不能打断演出：钩子抛错只记一条告警，handler 照常运行。
// 按需包装（取用某个事件类型时才包一层并缓存）：测试替身常用 Proxy 充当 HandlerMap，没有可枚举的键。
import type { GameEvent } from '@rich4/shared/engine';
import type { AnyHandler, EventAudioHook, HandlerMap, PresentationContext } from './types';

function wrap(h: AnyHandler, hook: () => EventAudioHook | null): AnyHandler {
  return async (e: GameEvent, ctx: PresentationContext) => {
    const a = hook();
    let end: (() => void) | null = null;
    if (a) {
      try {
        end = a.onEvent(e, ctx);
      } catch (err) {
        console.warn('[audio] event hook failed', e.type, err);
      }
    }
    try {
      await h(e, ctx);
    } finally {
      try {
        end?.();
      } catch (err) {
        console.warn('[audio] event end failed', e.type, err);
      }
    }
  };
}

export function withEventAudio(handlers: HandlerMap, hook: () => EventAudioHook | null): HandlerMap {
  const src = handlers as unknown as Record<string, unknown>;
  const cache = new Map<string, { h: AnyHandler; w: AnyHandler }>();
  // 以空对象为代理目标：原表可能被冻结，直接代理时返回包装后的函数会违反 Proxy 不变式
  return new Proxy({} as HandlerMap, {
    get(_t, prop) {
      if (typeof prop !== 'string') return undefined;
      const h = src[prop];
      if (typeof h !== 'function') return h;
      const hit = cache.get(prop);
      if (hit && hit.h === h) return hit.w;
      const w = wrap(h as AnyHandler, hook);
      cache.set(prop, { h: h as AnyHandler, w });
      return w;
    },
  });
}
