// 前端入口：字体、主题、i18n、访问门禁检查，然后挂载 React 应用
import './ui/theme/fonts';
import './ui/theme/tokens.css';
import './ui/theme/global.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { initI18n } from './i18n';
import { bootstrapAccess } from './ui/access/bootstrap';

initI18n();
// 访问门禁（原版皮肤 U4）：地址栏带邀请授权片段 #g= 时兑换；门禁开启而本浏览器未通过时显示门禁页
void bootstrapAccess();

const host = document.getElementById('root');
if (!host) throw new Error('#root not found');

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
