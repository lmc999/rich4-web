// 服务容器（design/client.md §2 app/services.ts）：全局唯一的 GameClient（socket.io 传输 + EventPlayer + 路由）。
// React 通过 ClientContext 取用；组件测试用 ClientProvider 注入假传输的 GameClient。
import { createContext, createElement, type ReactNode, useContext } from 'react';
import { tx } from '../i18n/tx';
import { GameClient, handshakeAuth } from '../net/client';
import { createSocketTransport } from '../net/socketTransport';
import { appFlags } from './flags';
import { installTestHooks } from './testHooksInstall';

// 开发期 HMR：本模块（或它依赖的客户端核心、store）更新时整页刷新，而不是在同一页面里再建一个 GameClient
// （否则同一 token 会建立第二条连接，把第一条顶掉）
if (import.meta.hot) import.meta.hot.accept(() => location.reload());

let singleton: GameClient | null = null;

export function getGameClient(): GameClient {
  if (!singleton) {
    const flags = appFlags();
    singleton = new GameClient({
      transport: createSocketTransport({ getAuth: () => handshakeAuth() }),
      t: tx,
      // ?test=1（E2E 用的生产构建）也开批尾对账；对账不一致走 console.error，E2E 夹具据此判失败
      dev: import.meta.env.DEV || flags.test,
      ...(flags.test ? { error: (m: string, d?: unknown) => console.error(m, d ?? '') } : {}),
      instant: flags.animInstant,
    });
    installTestHooks(singleton);
  }
  return singleton;
}

/** 测试替换全局客户端（传 null 清除） */
export function setGameClient(c: GameClient | null): void {
  singleton = c;
}

export const ClientContext = createContext<GameClient | null>(null);

export function ClientProvider({ client, children }: { client: GameClient; children: ReactNode }): ReactNode {
  return createElement(ClientContext.Provider, { value: client }, children);
}

export function useClient(): GameClient {
  return useContext(ClientContext) ?? getGameClient();
}
