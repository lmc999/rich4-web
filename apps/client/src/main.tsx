// 前端入口：字体、主题、i18n，然后挂载 React 应用
import './ui/theme/fonts';
import './ui/theme/tokens.css';
import './ui/theme/global.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { initI18n } from './i18n';

initI18n();

const host = document.getElementById('root');
if (!host) throw new Error('#root not found');

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
