// S2C 分发（design/client.md §2 router）：把服务器推送按事件名交给 store、EventPlayer、聊天与提示。
// 路由表对 ServerToClientEvents 穷举（satisfies），协议新增事件时编译失败。
import type { S2CEventName, S2CPayload } from '@rich4/shared/net';
import type { Transport } from './transport';

export type S2CRoutes = { readonly [E in S2CEventName]: (p: S2CPayload<E>) => void };

/** 注册全部路由；返回注销函数 */
export function attachRouter(transport: Pick<Transport, 'on'>, routes: S2CRoutes): () => void {
  const offs: (() => void)[] = [];
  for (const ev of Object.keys(routes) as S2CEventName[]) {
    const fn = routes[ev] as (p: unknown) => void;
    offs.push(
      transport.on(ev, (p) => {
        try {
          fn(p);
        } catch (err) {
          console.error(`[rich4] route ${ev} threw`, err);
        }
      }),
    );
  }
  return () => {
    for (const off of offs) off();
  };
}
