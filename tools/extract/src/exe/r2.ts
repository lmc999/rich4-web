import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hexVa, type PeFile } from '../pe/scan';
import { decodeAt } from './x86';

/**
 * 可选的 radare2 交叉核对（`exe diff --r2`，data-pipeline.md §6.4 第 2、6 条）：
 * 用 r2 的线性反汇编（`pD`）与本项目 x86 解码器的线性扫描逐条比较指令边界。
 * 只读：r2 以默认只读方式打开 exe，不写 project 文件。r2 不可用时返回 available = false。
 */

const run = promisify(execFile);

export interface R2Check {
  available: boolean;
  version: string | null;
  /** 本项目解码器线性扫描的指令数 */
  insns: number;
  /** r2 给出的指令起点里本项目没有的个数（边界不一致） */
  mismatches: number;
  firstMismatches: string[];
  error: string | null;
}

export async function r2LinearCheck(exePath: string, file: PeFile, timeoutMs = 120_000): Promise<R2Check> {
  const base: R2Check = { available: false, version: null, insns: 0, mismatches: 0, firstMismatches: [], error: null };
  let version: string;
  try {
    version = (await run('r2', ['-v'], { timeout: 10_000 })).stdout.split('\n')[0]!.trim();
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
  const sp = file.spans('code')[0];
  if (!sp) return { ...base, available: true, version, error: '没有代码节' };
  const len = sp.end - sp.off;
  let out: string;
  try {
    out = (
      await run(
        'r2',
        [
          '-q',
          '-e',
          'scr.color=0',
          '-e',
          'asm.bytes=false',
          '-e',
          'asm.comments=false',
          '-e',
          'asm.lines=false',
          '-e',
          'asm.flags=false',
          '-e',
          'asm.functions=false',
          '-c',
          `pD ${len} @ ${hexVa(sp.va)}`,
          exePath,
        ],
        { timeout: timeoutMs, maxBuffer: 1 << 30 },
      )
    ).stdout;
  } catch (e) {
    return { ...base, available: true, version, error: e instanceof Error ? e.message : String(e) };
  }
  const ours = new Set<number>();
  for (let off = sp.off; off < sp.end; ) {
    const va = sp.va + (off - sp.off);
    ours.add(va);
    off += decodeAt(file.bytes, off, va, sp.end).len;
  }
  let mismatches = 0;
  const first: string[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*0x([0-9a-f]+)\s/.exec(line);
    if (!m) continue;
    const va = Number.parseInt(m[1]!, 16);
    if (!ours.has(va)) {
      mismatches++;
      if (first.length < 5) first.push(hexVa(va));
    }
  }
  return { available: true, version, insns: ours.size, mismatches, firstMismatches: first, error: null };
}
