import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'server',
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    // node:sqlite 在 Node 24.9 仍会打印 ExperimentalWarning（生产 start 脚本同样关闭）
    execArgv: ['--disable-warning=ExperimentalWarning'],
  },
});
