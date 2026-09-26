// 服务端生产构建（design/net.md §10.2）：esbuild 把 src 与 @rich4/shared（TS 源码）打成单个 ESM 文件，
// 第三方依赖保持 external（运行时从 node_modules 加载）。用法：node apps/server/build.mjs
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, 'package.json'), 'utf8'));
const external = Object.keys(pkg.dependencies ?? {}).filter((d) => !d.startsWith('@rich4/'));

await build({
  entryPoints: [resolve(here, 'src/main.ts')],
  outfile: resolve(here, 'dist/main.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  external: [...external, ...external.map((d) => `${d}/*`)],
  // 允许打进来的 CJS 依赖在 ESM 产物里使用 require
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});
