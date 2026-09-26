#!/usr/bin/env node
// 并行启动服务端（tsx watch，:3000）与前端（Vite，:5173），输出加 [server]/[client] 前缀；
// Ctrl+C 或任一进程退出时一并结束两者。用法：npm run dev
import { spawn } from 'node:child_process';
import process from 'node:process';

const isWin = process.platform === 'win32';
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);

const TASKS = [
  { name: 'server', color: 36, args: ['-w', '@rich4/server', 'run', 'dev'] },
  { name: 'client', color: 35, args: ['-w', '@rich4/client', 'run', 'dev'] },
];
const width = Math.max(...TASKS.map((t) => t.name.length));

/** 按行转发子进程输出，保留不完整的尾行直到下一块数据或流结束 */
function pipeLines(stream, out, prefix) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    const lines = (pending + chunk).split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) out.write(`${prefix} ${line}\n`);
  });
  stream.on('end', () => {
    if (pending) out.write(`${prefix} ${pending}\n`);
    pending = '';
  });
}

const children = new Map();
let shuttingDown = false;
let exitCode = 0;

function killTree(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (isWin) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      // detached 启动的子进程自成进程组，负 pid 可连同 npm → sh → node 一起结束
      process.kill(-child.pid, signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      // 已退出
    }
  }
}

function shutdown(code, reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  exitCode = code;
  if (reason) process.stderr.write(`${paint(33, '[dev]')} ${reason}，正在结束全部进程…\n`);
  for (const child of children.values()) killTree(child, 'SIGTERM');
  // 5 秒内没退干净就强杀
  setTimeout(() => {
    for (const child of children.values()) killTree(child, 'SIGKILL');
    process.exit(exitCode);
  }, 5000).unref();
}

for (const task of TASKS) {
  const prefix = paint(task.color, `[${task.name}]`.padEnd(width + 2));
  const child = spawn(isWin ? 'npm.cmd' : 'npm', task.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !isWin,
    shell: isWin,
    env: { ...process.env, ...(useColor ? { FORCE_COLOR: '1' } : {}) },
  });
  children.set(task.name, child);
  pipeLines(child.stdout, process.stdout, prefix);
  pipeLines(child.stderr, process.stderr, prefix);
  child.on('error', (err) => {
    process.stderr.write(`${prefix} 启动失败：${err.message}\n`);
    shutdown(1, `${task.name} 启动失败`);
  });
  child.on('exit', (code, signal) => {
    children.delete(task.name);
    if (!shuttingDown) {
      const how = signal ? `被信号 ${signal} 结束` : `退出码 ${code}`;
      shutdown(code === 0 ? 0 : (code ?? 1), `${task.name} 已退出（${how}）`);
    }
    if (children.size === 0) process.exit(exitCode);
  });
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => shutdown(sig === 'SIGINT' ? 130 : 143, sig === 'SIGINT' ? '收到 Ctrl+C' : `收到 ${sig}`));
}
