// M11 调试：在本机用生产构建（apps/server/dist/main.mjs）起「部署实例」，给 E2E 远程模式与重启恢复用例当靶子，
// 也用作 E2E_RESTART_CMD（restart：SIGTERM 等优雅退出，再用同样的环境、同一个数据目录拉起，等 /readyz 200）。
//
// 用法：node test/m11-local-server.mjs <start|stop|restart|status|clean|passcode> <实例>
//   plain  3201：RICH4_TEST_MODE=1、无门禁、服务器自己托管 apps/client/dist
//   gated  3202：另加 NODE_ENV=production、ACCESS_MODE=passcode、真实素材包 rich4-assets（只读）——接近 compose 部署
//   synth  3203：同 gated，但挂合成素材包 .cache/synthetic-pack（fixture 地图 test 有绑定，给原版皮肤配置用）
//   prod   3204：NODE_ENV=production、不开测试模式（没有 debug:act）、无门禁——验证重启用例的正常掷骰路径
//   tls    3205：同 gated，但对外地址是 test/m11-tls-proxy.mjs 的 https://localhost:3243（Secure cookie、TRUST_PROXY=1），
//          只经反代访问——模拟 compose 里 Caddy + app 的形态
//   passcode 把门禁口令打到 stdout，只用于 E2E_PASSCODE="$(node test/m11-local-server.mjs passcode gated)"，不要回显。
// 状态、日志、随机生成的密钥都在 .cache/m11/（已被 .gitignore 忽略）；数据目录在系统临时目录，clean 时删除。
import { spawn } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = join(repoRoot, '.cache', 'm11');
const MAIN = join(repoRoot, 'apps', 'server', 'dist', 'main.mjs');
const STOP_TIMEOUT_MS = 35_000;
const READY_TIMEOUT_MS = 60_000;

const INSTANCES = {
  plain: { port: 3201, gated: false, pack: null, testMode: true },
  gated: { port: 3202, gated: true, pack: join(repoRoot, 'rich4-assets'), testMode: true },
  synth: { port: 3203, gated: true, pack: join(repoRoot, '.cache', 'synthetic-pack'), testMode: true },
  prod: { port: 3204, gated: false, pack: null, testMode: false, production: true },
  tls: {
    port: 3205,
    gated: true,
    pack: join(repoRoot, 'rich4-assets'),
    testMode: true,
    publicUrl: 'https://localhost:3243',
    trustProxy: true,
  },
};

function die(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

/** 本机随机生成的密钥（首次使用时生成，权限 600）；口令哈希与 scripts/access.ts 的格式、默认参数相同 */
function secrets() {
  const file = join(cacheDir, 'local-secrets.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const passcode = randomBytes(18).toString('base64url');
  const salt = randomBytes(16);
  const [N, r, p] = [1 << 15, 8, 3];
  const hash = scryptSync(passcode.normalize('NFC'), salt, 32, { N, r, p, maxmem: 128 * N * r + 32 * 1024 * 1024 });
  const s = {
    passcode,
    passcodeHash: ['scrypt', N, r, p, salt.toString('base64url'), hash.toString('base64url')].join(':'),
    accessSecret: randomBytes(48).toString('base64url'),
    adminToken: randomBytes(48).toString('base64url'),
    saveHmacSecret: randomBytes(48).toString('base64url'),
  };
  writeFileSync(file, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return s;
}

const statePath = (name) => join(cacheDir, `local-${name}.json`);
const logPath = (name) => join(cacheDir, `local-${name}.log`);

function readState(name) {
  try {
    return JSON.parse(readFileSync(statePath(name), 'utf8'));
  } catch {
    return null;
  }
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function envOf(name, inst, dataDir) {
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    PORT: String(inst.port),
    HOST: '127.0.0.1',
    PUBLIC_URL: inst.publicUrl ?? `http://localhost:${inst.port}`,
    STATIC_DIR: join(repoRoot, 'apps', 'client', 'dist'),
    RICH4_DATA_DIR: join(repoRoot, 'rich4-data'),
    RICH4_TEST_MODE: inst.testMode ? '1' : '0',
    DATA_DIR: dataDir,
    LOG_LEVEL: 'info',
    LOG_PRETTY: '0',
    TRUST_PROXY: inst.trustProxy ? '1' : '0',
  };
  if (inst.production) Object.assign(env, { NODE_ENV: 'production', SAVE_HMAC_SECRET: secrets().saveHmacSecret });
  if (inst.gated) {
    const s = secrets();
    Object.assign(env, {
      NODE_ENV: 'production',
      SAVE_HMAC_SECRET: s.saveHmacSecret,
      ACCESS_MODE: 'passcode',
      ACCESS_PASSCODE_HASH: s.passcodeHash,
      ACCESS_SECRET: s.accessSecret,
      ADMIN_TOKEN: s.adminToken,
      RICH4_ASSETS_DIR: inst.pack,
    });
  }
  return env;
}

async function httpStatus(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return r.status;
  } catch {
    return 0;
  }
}

async function start(name, inst) {
  mkdirSync(cacheDir, { recursive: true });
  if (!existsSync(MAIN)) die(`没有 ${MAIN}：先 npm run build`);
  const st = readState(name);
  if (st && alive(st.pid)) die(`${name} 已在运行（pid ${st.pid}）`);
  if ((await httpStatus(`http://127.0.0.1:${inst.port}/healthz`)) !== 0) die(`端口 ${inst.port} 已被占用`);
  // restart 沿用同一个数据目录（房间快照与 journal 在里面）
  const dataDir = st?.dataDir && existsSync(st.dataDir) ? st.dataDir : mkdtempSync(join(tmpdir(), `rich4-m11-${name}-`));
  const out = openSync(logPath(name), 'a');
  const t0 = Date.now();
  const child = spawn(process.execPath, [MAIN], {
    cwd: repoRoot,
    env: envOf(name, inst, dataDir),
    detached: true,
    stdio: ['ignore', out, out],
  });
  let exited = null;
  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });
  writeFileSync(statePath(name), `${JSON.stringify({ pid: child.pid, dataDir, port: inst.port }, null, 2)}\n`);
  while (Date.now() - t0 < READY_TIMEOUT_MS) {
    if (exited) die(`${name} 启动即退出（${JSON.stringify(exited)}），见 ${logPath(name)}`);
    if ((await httpStatus(`http://127.0.0.1:${inst.port}/readyz`)) === 200) {
      child.unref();
      process.stdout.write(`${name} ready: pid ${child.pid} port ${inst.port} (${Date.now() - t0}ms)\n`);
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  die(`${name} ${READY_TIMEOUT_MS}ms 内 /readyz 没有返回 200，见 ${logPath(name)}`);
}

async function stop(name) {
  const st = readState(name);
  if (!st || !alive(st.pid)) {
    process.stdout.write(`${name} 未运行\n`);
    return;
  }
  const t0 = Date.now();
  process.kill(st.pid, 'SIGTERM');
  while (alive(st.pid)) {
    if (Date.now() - t0 > STOP_TIMEOUT_MS) {
      process.kill(st.pid, 'SIGKILL');
      die(`${name} ${STOP_TIMEOUT_MS}ms 内没有优雅退出，已 SIGKILL`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  process.stdout.write(`${name} stopped: pid ${st.pid} (${Date.now() - t0}ms)\n`);
}

const [cmd, name] = process.argv.slice(2);
const inst = INSTANCES[name];
if (!inst) die(`用法：node test/m11-local-server.mjs <start|stop|restart|status|clean|passcode> <${Object.keys(INSTANCES).join('|')}>`);
switch (cmd) {
  case 'start':
    await start(name, inst);
    break;
  case 'stop':
    await stop(name);
    break;
  case 'restart':
    await stop(name);
    await start(name, inst);
    break;
  case 'status': {
    const st = readState(name);
    const ready = await httpStatus(`http://127.0.0.1:${inst.port}/readyz`);
    process.stdout.write(`${name}: pid ${st?.pid ?? '-'} alive=${alive(st?.pid)} readyz=${ready} data=${st?.dataDir ?? '-'}\n`);
    break;
  }
  case 'clean': {
    await stop(name);
    const st = readState(name);
    if (st?.dataDir) rmSync(st.dataDir, { recursive: true, force: true });
    rmSync(statePath(name), { force: true });
    process.stdout.write(`${name} cleaned\n`);
    break;
  }
  case 'passcode':
    if (!inst.gated) die(`${name} 没有门禁`);
    process.stdout.write(secrets().passcode);
    break;
  default:
    die(`未知命令 ${cmd}`);
}
