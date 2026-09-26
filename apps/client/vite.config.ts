// 前端构建与开发服务器配置（design/client.md §2、net.md §9：开发期 /socket.io 与 /api 代理到 :3000）
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { type Alias, defineConfig, type Plugin } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const sharedDir = join(repoRoot, 'packages/shared');
const API_TARGET = process.env.RICH4_API_TARGET ?? 'http://localhost:3000';

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 按 packages/shared/package.json 的 exports 生成精确别名：直接解析到 TS 源码，不走 node_modules 预构建 */
export function sharedAliases(): Alias[] {
  const pkg = JSON.parse(readFileSync(join(sharedDir, 'package.json'), 'utf8')) as { exports: Record<string, string> };
  return Object.entries(pkg.exports).map(([sub, target]) => ({
    find: sub === '.' ? /^@rich4\/shared$/ : new RegExp(`^@rich4/shared/${escapeRe(sub.slice(2))}$`),
    replacement: join(sharedDir, target),
  }));
}

/**
 * 开发期便利：服务端未启动时，/dev/map 可退回到 /__dev/maps/:id 直接读取本机 rich4-data（或 RICH4_DATA_DIR）。
 * 只在 vite serve 下生效，绝不进入构建产物；正式路径仍是服务端的 GET /api/maps/:id。
 */
function devLocalMaps(): Plugin {
  return {
    name: 'rich4:dev-local-maps',
    apply: 'serve',
    configureServer(server) {
      const dataDir = resolve(repoRoot, process.env.RICH4_DATA_DIR ?? 'rich4-data');
      server.middlewares.use('/__dev/maps', (req, res, next) => {
        const id = (req.url ?? '').replace(/^\//, '').split('?')[0] ?? '';
        if (!/^[a-z0-9-]+$/.test(id)) return next();
        const file = join(dataDir, 'maps', `${id}.map.json`);
        if (!existsSync(file)) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'MAP_UNAVAILABLE', id }));
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(readFileSync(file));
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), devLocalMaps()],
  resolve: { alias: sharedAliases() },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/socket.io': { target: API_TARGET, ws: true, changeOrigin: true },
      '/api': { target: API_TARGET, ws: true, changeOrigin: true },
    },
  },
  preview: { port: 4173 },
  build: {
    target: 'es2023',
    sourcemap: true,
    // Pixi 单独成 chunk（只由懒加载的棋盘/开发页引用），体积告警阈值按 Pixi 调高
    chunkSizeWarningLimit: 900,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            // Vite 的预加载辅助模块单独放：否则会被并进 pixi chunk，导致首屏静态依赖 Pixi
            { name: 'preload', test: /preload-helper/, priority: 50 },
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 30 },
            { name: 'pixi', test: /node_modules[\\/](pixi\.js|@pixi)[\\/]/, priority: 20 },
            { name: 'i18n', test: /node_modules[\\/](i18next|react-i18next)[\\/]/, priority: 10 },
            // 棋盘渲染与程序化美术（纯 Pixi），只由懒加载的页面引用
            { name: 'game', test: /apps[\\/]client[\\/]src[\\/]game[\\/]/, priority: 5 },
          ],
        },
      },
    },
  },
});
