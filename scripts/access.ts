// 访问门禁管理 CLI（docs/design/original-skin.md U4；实现在 apps/server/src/access/cli.ts）。
// 用法：npx tsx scripts/access.ts <hash|secret|invite|list|revoke> [选项]；不带参数显示帮助。
//   hash    交互输入两次口令（不回显），输出 ACCESS_PASSCODE_HASH；--stdin 从标准输入读第一行（口令不进命令行历史）
//   secret  输出一个 ACCESS_SECRET
//   invite  生成邀请码（--uses、--days / --no-expiry、--note）；list 列出；revoke 吊销全部（或 --invite <id> 撤销一个）
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

// node:sqlite 在 Node 24.9 仍会打印 ExperimentalWarning（服务器的 start 脚本同样关闭它）；先装过滤器再动态加载实现
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name !== 'ExperimentalWarning') process.stderr.write(`${w.name}: ${w.message}\n`);
});
const { runAccessCli } = await import('../apps/server/src/access/cli');

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** 不回显地读一行（终端里输入口令） */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let muted = false;
    const output = new Writable({
      write(chunk, _enc, cb) {
        if (!muted) process.stderr.write(chunk);
        cb();
      },
    });
    const rl = createInterface({ input: process.stdin, output, terminal: true });
    rl.on('SIGINT', () => {
      rl.close();
      reject(new Error('已取消'));
    });
    rl.question(question, (answer) => {
      rl.close();
      process.stderr.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

const code = await runAccessCli(process.argv.slice(2), {
  out: (l) => process.stdout.write(`${l}\n`),
  err: (l) => process.stderr.write(`${l}\n`),
  readStdin,
  promptHidden: process.stdin.isTTY ? promptHidden : null,
  env: process.env,
  cwd: process.cwd(),
});
process.exitCode = code;
