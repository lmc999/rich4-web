import { isMainThread, Worker } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';
if (isMainThread) {
  const self = pathToFileURL(fileURLToPath(import.meta.url)).href;
  const api = import.meta.resolve('tsx/esm/api');
  console.log(api);
  const boot = `import { register } from ${JSON.stringify(api)}; register(); await import(${JSON.stringify(self)});`;
  const w = new Worker(new URL(`data:text/javascript,${encodeURIComponent(boot)}`));
  w.on('error', (e) => console.log('err', e.message));
  w.on('exit', (c) => console.log('exit', c));
} else {
  const m = await import('../packages/shared/src/ai/index');
  console.log('worker ok', Object.keys(m).length);
}
