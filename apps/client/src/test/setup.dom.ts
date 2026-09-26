// client-dom 的全局准备：jest-dom 断言、i18n 初始化、每个用例后卸载组件
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { initI18n } from '../i18n';

initI18n('original');

afterEach(() => {
  cleanup();
});
