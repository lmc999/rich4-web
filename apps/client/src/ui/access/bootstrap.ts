// 应用启动时的门禁检查（供入口 main.tsx 调用一次；本模块很轻，不引入 React 组件）：
// - 地址栏带房间邀请授权片段 #g=<token> → 显示门禁页（它会立刻清掉片段并兑换，成功后进入对应房间）；
// - 否则 GET /api/access：门禁开启而本浏览器未通过 → 显示门禁页。门禁关闭或旧服务器时什么都不做。
// Socket.IO 握手收到 ACCESS_REQUIRED、其他 /api 返回 401 时，net 层同样调用 requireAccess（见 accessStore）。
import { parseAccessGrantFragment } from '@rich4/shared/net';
import { requireAccess, useAccessStore } from './accessStore';

export async function bootstrapAccess(loc: { hash: string } | undefined = globalThis.location): Promise<void> {
  if (!loc) return;
  if (parseAccessGrantFragment(loc.hash) !== null) {
    requireAccess('startup');
    return;
  }
  const s = await useAccessStore.getState().refresh();
  if (s && s.mode !== 'off' && !s.granted) requireAccess('startup');
}
