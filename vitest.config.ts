import { defineConfig } from 'vitest/config';
import { clientTestProjects } from './apps/client/vitest.projects.ts';

export default defineConfig({
  test: {
    projects: [
      'packages/shared',
      'apps/server',
      // 服务端集成测试再用真实引擎（createEngine + BasicAiPolicy）跑一遍；'server' project 默认走 stubEngine
      {
        extends: false,
        root: './apps/server',
        test: {
          name: 'server-real',
          environment: 'node',
          include: ['test/integration/**/*.test.ts'],
          env: { RICH4_TEST_ENGINE: 'real' },
        },
      },
      'tools/extract',
      'scripts',
      // 前端三个 project 以内联形式加入（不经 apps/client 容器），保持 client-unit / client-dom / client-browser 原名
      ...clientTestProjects({ extends: './apps/client/vite.config.ts', root: './apps/client' }),
    ],
  },
});
