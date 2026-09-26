// 前端测试（design/client.md §12.1）：project 定义见 vitest.projects.ts。
// 本文件是在 apps/client 下运行（或 --root apps/client）时的「容器」配置；
// 仓库根 vitest.config.ts 不经过本文件，而是直接内联同一组 project，所以两处的 project 名都是 client-unit 等原名。
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';
import { clientTestProjects } from './vitest.projects.ts';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      name: 'client',
      projects: clientTestProjects({ extends: true }),
    },
  }),
);
