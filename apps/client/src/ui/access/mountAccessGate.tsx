// 没有 AccessGateHost 的页面（首页、房间页）需要门禁时，动态挂一个全屏门禁浮层（只挂一次，之后常驻、按状态显示）。
import { createRoot } from 'react-dom/client';
import { AccessGateHost } from './AccessGateHost';
import { accessHostMounted } from './accessStore';

let mounted = false;

export function mountAccessGate(): void {
  if (mounted || accessHostMounted() || typeof document === 'undefined') return;
  mounted = true;
  const el = document.createElement('div');
  el.id = 'rich4-access-gate';
  document.body.appendChild(el);
  createRoot(el).render(<AccessGateHost />);
}
