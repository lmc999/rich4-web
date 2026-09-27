// 前端测试的三个 project（design/client.md §12.1），由两处共用：
// - apps/client/vitest.config.ts（在 apps/client 下运行或 --root apps/client）：extends: true 继承容器配置；
// - 仓库根 vitest.config.ts：以内联 project 的形式 extends apps/client/vite.config.ts、root 指向 apps/client。
//   这样从根目录跑 `--project client-unit` 也能命中原名（Vitest 5 会给「容器」配置的子 project 加前缀，
//   形如 "client (client-unit)"，内联 project 不加）。
//
// - client-unit    node：纯数学与纯逻辑（投影、深度、道路拼接、镜头、动画时钟、SVG 生成…）；
//                  globalSetup 先用 `npm run extract -- assets synth` 生成合成素材包（.cache/synthetic-pack，原版皮肤 A5）
// - client-dom     jsdom + Testing Library：路由、占位页、i18n
// - client-browser Vitest 浏览器模式 + Playwright Chromium：真实 WebGL 下的 GameRenderer 冒烟
//
// client-browser 只在本机装有 Playwright Chromium 时加入（否则 CI 的 npm test 会因缺浏览器失败）；
// 设 RICH4_BROWSER_TESTS=1 强制加入、=0 强制排除；命令行显式点名 client-browser 时也会加入。
// 安装浏览器：npx playwright install chromium
// 也可用 RICH4_CHROMIUM_PATH 指向本机已有的 Chrome/Chromium 可执行文件（不下载）。
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { playwright } from '@vitest/browser-playwright';
import type { TestProjectInlineConfiguration } from 'vitest/config';

const CHROMIUM_PATH = process.env.RICH4_CHROMIUM_PATH;

function chromiumInstalled(): boolean {
  if (CHROMIUM_PATH) return existsSync(CHROMIUM_PATH);
  try {
    const require = createRequire(import.meta.url);
    const { chromium } = require('playwright-core') as { chromium: { executablePath(): string } };
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

function wantBrowserProject(): boolean {
  const flag = process.env.RICH4_BROWSER_TESTS;
  if (flag === '1') return true;
  if (flag === '0') return false;
  if (process.argv.some((a) => a.includes('client-browser'))) return true;
  return chromiumInstalled();
}

/** base：容器内用 { extends: true }；根配置用 { extends: './apps/client/vite.config.ts', root: './apps/client' } */
export type ClientProjectBase = Pick<TestProjectInlineConfiguration, 'extends' | 'root'>;

export function clientTestProjects(base: ClientProjectBase): TestProjectInlineConfiguration[] {
  const out: TestProjectInlineConfiguration[] = [
    {
      ...base,
      test: {
        name: 'client-unit',
        environment: 'node',
        include: ['src/**/*.test.ts'],
        exclude: ['src/**/*.browser.test.ts', 'src/**/*.dom.test.ts'],
        globalSetup: ['src/skin/testing/synthPack.globalSetup.ts'],
      },
    },
    {
      ...base,
      test: {
        name: 'client-dom',
        environment: 'jsdom',
        include: ['src/**/*.dom.test.ts', 'src/**/*.dom.test.tsx'],
        setupFiles: ['src/test/setup.dom.ts'],
      },
    },
  ];
  if (wantBrowserProject()) {
    out.push({
      ...base,
      test: {
        name: 'client-browser',
        include: ['src/**/*.browser.test.ts'],
        testTimeout: 30_000,
        browser: {
          enabled: true,
          headless: true,
          // 失败截图会写到 .vitest/attachments（未被 .gitignore 忽略），默认关闭；调试时临时打开
          screenshotFailures: false,
          provider: playwright(CHROMIUM_PATH ? { launchOptions: { executablePath: CHROMIUM_PATH } } : {}),
          instances: [{ browser: 'chromium' as const }],
          viewport: { width: 1024, height: 768 },
        },
      },
    });
  }
  return out;
}
