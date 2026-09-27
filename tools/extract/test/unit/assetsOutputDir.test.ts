/**
 * 派生物输出目录守卫（审查修复）：仓库外须显式放行、其他 git 工作树按同样规则判定、任何位置的 apps/*\/public 拒绝、
 * 嵌套仓库再判定一次；目录归属标记（认领、旧版产物识别、删除前检查）。
 * 只用临时目录与合成文件；不读原版文件、不需要 ffmpeg。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PackManifestV1 } from '@rich4/shared/assets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pruneStale, resolveOutputDir as resolveViaAudio } from '../../src/assets/audio';
import { pruneStalePack, resolvePackOutputDir } from '../../src/assets/manifest';
import {
  assertOwnedOutputDir,
  claimOutputDir,
  gitWorktreeOf,
  hasOwnerMarker,
  OUTPUT_OWNER_MARKER,
  outputDirState,
  resolveOutputDir,
} from '../../src/assets/outputDir';
import { buildPreview } from '../../src/assets/preview';
import { buildSyntheticPack } from '../../src/assets/synthetic';
import { main } from '../../src/cli';
import { ExitCode, ExtractContext, ExtractError, realpathLoose } from '../../src/context';

const quiet = { out: () => {}, err: () => {} };
const hasGit = spawnSync('git', ['--version']).status === 0;

function gitInit(dir: string, ignore: string): void {
  mkdirSync(dir, { recursive: true });
  const g = spawnSync('git', ['init', '-q'], { cwd: dir });
  if (g.status !== 0) throw new Error(`git init 失败：${dir}`);
  writeFileSync(path.join(dir, '.gitignore'), ignore);
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return 'ok';
  } catch (e) {
    return e instanceof ExtractError ? e.code : String(e);
  }
}

async function codeOfAsync(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof ExtractError ? e.code : String(e);
  }
}

let base: string;
beforeAll(() => {
  base = realpathLoose(mkdtempSync(path.join(tmpdir(), 'rich4-outdir-')));
});
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe.skipIf(!hasGit)('resolveOutputDir：仓库外与其他 git 工作树', () => {
  let repo: string;
  let other: string;
  let ctx: ExtractContext;
  beforeAll(() => {
    repo = path.join(base, 'repo');
    gitInit(repo, 'rich4-assets/\n.cache/\n');
    mkdirSync(path.join(repo, 'original'), { recursive: true });
    ctx = new ExtractContext({ root: repo, logger: quiet });
    // 另一份检出：apps/client/public 未被忽略
    other = path.join(base, 'otherclone');
    gitInit(other, 'rich4-assets/\n.cache/\nother-ignored/\n');
    mkdirSync(path.join(other, 'apps', 'client', 'public'), { recursive: true });
  });

  it('另一份检出的 apps/client/public/pack：无论是否 allowOutsideRepo 都拒绝（审查复现用例）', () => {
    const target = path.join(other, 'apps', 'client', 'public', 'pack');
    expect(codeOf(() => resolvePackOutputDir(ctx, target))).toBe('E_ASSETS_OUT_PUBLIC');
    expect(codeOf(() => resolvePackOutputDir(ctx, target, { allowOutsideRepo: true }))).toBe('E_ASSETS_OUT_PUBLIC');
    expect(codeOf(() => resolveViaAudio(ctx, target, { allowOutsideRepo: true }))).toBe('E_ASSETS_OUT_PUBLIC');
  });

  it('仓库外默认拒绝；显式放行后按所在工作树再判定（未忽略、非 rich4-assets/.cache、工作树根都拒绝）', () => {
    const allow = { allowOutsideRepo: true };
    expect(codeOf(() => resolveOutputDir(ctx, path.join(other, 'rich4-assets')))).toBe('E_ASSETS_OUT_OUTSIDE');
    expect(resolveOutputDir(ctx, path.join(other, 'rich4-assets'), allow)).toBe(path.join(other, 'rich4-assets'));
    expect(resolveOutputDir(ctx, path.join(other, '.cache', 'p'), allow)).toBe(path.join(other, '.cache', 'p'));
    expect(codeOf(() => resolveOutputDir(ctx, path.join(other, 'src', 'out'), allow))).toBe('E_ASSETS_OUT_NOT_IGNORED');
    expect(codeOf(() => resolveOutputDir(ctx, path.join(other, 'other-ignored', 'x'), allow))).toBe(
      'E_ASSETS_OUT_POLICY',
    );
    expect(codeOf(() => resolveOutputDir(ctx, other, allow))).toBe('E_ASSETS_OUT_ROOT');
    // 不在任何工作树里的普通目录：显式放行后可用
    const plain = path.join(base, 'plain', 'pack');
    expect(codeOf(() => resolveOutputDir(ctx, plain))).toBe('E_ASSETS_OUT_OUTSIDE');
    expect(resolveOutputDir(ctx, plain, allow)).toBe(plain);
  });

  it('git worktree / 子模块式的 .git 文件也算工作树（git 判断不了时只认 rich4-assets/ 与 .cache/）', () => {
    const wt = path.join(base, 'wt');
    mkdirSync(wt, { recursive: true });
    writeFileSync(path.join(wt, '.git'), 'gitdir: /nonexistent/.git/worktrees/wt\n');
    expect(gitWorktreeOf(path.join(wt, 'src', 'x'))).toBe(wt);
    const allow = { allowOutsideRepo: true };
    expect(codeOf(() => resolveOutputDir(ctx, path.join(wt, 'src', 'x'), allow))).toBe('E_ASSETS_OUT_NOT_IGNORED');
    expect(resolveOutputDir(ctx, path.join(wt, 'rich4-assets'), allow)).toBe(path.join(wt, 'rich4-assets'));
  });

  it('仓库内任何层级的 apps/<x>/public 都拒绝；嵌套仓库按它自己再判定一次', () => {
    expect(codeOf(() => resolveOutputDir(ctx, '.cache/mirror/apps/web/public/pack'))).toBe('E_ASSETS_OUT_PUBLIC');
    expect(codeOf(() => resolveOutputDir(ctx, 'rich4-assets/Apps/x/PUBLIC'))).toBe('E_ASSETS_OUT_PUBLIC');
    const nested = path.join(repo, '.cache', 'nested');
    gitInit(nested, 'rich4-assets/\n');
    expect(codeOf(() => resolveOutputDir(ctx, '.cache/nested/src'))).toBe('E_ASSETS_OUT_NOT_IGNORED');
    expect(resolveOutputDir(ctx, '.cache/nested/rich4-assets')).toBe(path.join(nested, 'rich4-assets'));
    expect(resolveOutputDir(ctx, '.cache/plain')).toBe(path.join(repo, '.cache', 'plain'));
  });

  it('CLI：assets synth 输出到仓库外须加 --allow-outside-repo', async () => {
    const out: string[] = [];
    const logger = { out: (l: string) => out.push(l), err: (l: string) => out.push(l) };
    const run = (...args: string[]) => main([...args, '--root', repo], { logger, cwd: repo });
    const foreign = path.join(base, 'cli-foreign');
    mkdirSync(foreign, { recursive: true });
    writeFileSync(path.join(foreign, 'keep.txt'), 'x');
    expect(await run('assets', 'synth', '--out', foreign)).toBe(ExitCode.STRUCTURE);
    expect(out.join('\n')).toMatch(/E_ASSETS_OUT_OUTSIDE/);
    out.length = 0;
    // 放行后通过位置检查，但目录非空且不是 rich4-extract 生成的 → 拒绝认领，原文件不动
    expect(await run('assets', 'synth', '--out', foreign, '--allow-outside-repo')).toBe(ExitCode.STRUCTURE);
    expect(out.join('\n')).toMatch(/E_ASSETS_OUT_FOREIGN/);
    expect(readFileSync(path.join(foreign, 'keep.txt'), 'utf8')).toBe('x');
  });
});

describe('目录归属：认领、旧版产物识别、删除前检查', () => {
  let root: string;
  let ctx: ExtractContext;
  beforeAll(() => {
    root = path.join(base, 'own');
    mkdirSync(path.join(root, 'original'), { recursive: true });
    ctx = new ExtractContext({ root, logger: quiet });
  });

  it('不存在或为空 = fresh，认领后写入标记 = owned；非空无标记 = foreign 且拒绝认领', async () => {
    const fresh = path.join(root, '.cache', 'fresh');
    expect(await outputDirState(fresh)).toBe('fresh');
    expect(await claimOutputDir(ctx, fresh)).toBe('fresh');
    expect(hasOwnerMarker(fresh)).toBe(true);
    expect(await outputDirState(fresh)).toBe('owned');
    expect(await claimOutputDir(ctx, fresh)).toBe('owned');
    const foreign = path.join(root, '.cache', 'foreign');
    mkdirSync(path.join(foreign, 'images'), { recursive: true });
    writeFileSync(path.join(foreign, 'images', 'logo.1a2b3c4d.png'), 'x');
    expect(await outputDirState(foreign)).toBe('foreign');
    expect(await codeOfAsync(claimOutputDir(ctx, foreign))).toBe('E_ASSETS_OUT_FOREIGN');
    expect(existsSync(path.join(foreign, OUTPUT_OWNER_MARKER))).toBe(false);
  });

  it('标记出现之前的 rich4-extract 产物（素材包 manifest、A3 暂存映射表、预览页）算 owned', async () => {
    const pack = path.join(root, '.cache', 'legacy-pack');
    mkdirSync(pack, { recursive: true });
    writeFileSync(
      path.join(pack, 'manifest.json'),
      '{"generator":"rich4-extract/assets@1","schema":"rich4.assets/1"}\n',
    );
    expect(await outputDirState(pack)).toBe('owned');
    const other = path.join(root, '.cache', 'other-pack');
    mkdirSync(other, { recursive: true });
    writeFileSync(path.join(other, 'manifest.json'), '{"generator":"someone-else"}\n');
    expect(await outputDirState(other)).toBe('foreign');
    const staging = path.join(root, '.cache', 'legacy-staging');
    mkdirSync(path.join(staging, 'data'), { recursive: true });
    writeFileSync(path.join(staging, 'data', 'voice-map.0123abcd.json'), '{"schema":"rich4.voice-map/1"}\n');
    expect(await outputDirState(staging)).toBe('owned');
    const preview = path.join(root, '.cache', 'legacy-preview');
    mkdirSync(preview, { recursive: true });
    writeFileSync(path.join(preview, 'index.html'), '<head><title>素材包预览（本机私用）</title></head>');
    expect(await outputDirState(preview)).toBe('owned');
  });

  it('pruneStalePack / pruneStale 在没有标记的目录里拒绝删除，文件保持原样', async () => {
    const dir = path.join(root, '.cache', 'unowned');
    const f = path.join(dir, 'images', 'x.1a2b3c4d.png');
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, 'x');
    const empty = { files: {} } as unknown as PackManifestV1;
    expect(await codeOfAsync(pruneStalePack(ctx, dir, empty))).toBe('E_ASSETS_OUT_NOT_OWNED');
    expect(await codeOfAsync(pruneStale(ctx, dir, 'images', /\.png$/, new Set()))).toBe('E_ASSETS_OUT_NOT_OWNED');
    expect(existsSync(f)).toBe(true);
    expect(codeOf(() => assertOwnedOutputDir(ctx, dir))).toBe('E_ASSETS_OUT_NOT_OWNED');
    // 认领过（fresh 时写标记）的目录可以清理
    const mine = path.join(root, '.cache', 'mine');
    await claimOutputDir(ctx, mine);
    const g = path.join(mine, 'images', 'y.1a2b3c4d.png');
    mkdirSync(path.dirname(g), { recursive: true });
    writeFileSync(g, 'y');
    expect(await pruneStalePack(ctx, mine, empty)).toEqual(['images/y.1a2b3c4d.png']);
    expect(existsSync(g)).toBe(false);
  });

  it('合成包与预览：foreign 目录在写任何文件之前就被拒绝，其中的文件（含 sheets/）不被删', async () => {
    const foreign = path.join(root, '.cache', 'foreign-synth');
    const f = path.join(foreign, 'sprites', 'a.1a2b3c4d.png');
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, 'keep');
    expect(await codeOfAsync(buildSyntheticPack({ ctx, outDir: foreign, log: quiet }))).toBe('E_ASSETS_OUT_FOREIGN');
    expect(existsSync(f)).toBe(true);
    expect(existsSync(path.join(foreign, 'manifest.json'))).toBe(false);

    const pack = path.join(root, '.cache', 'pack-for-preview');
    mkdirSync(pack, { recursive: true });
    writeFileSync(path.join(pack, 'manifest.json'), '{}\n');
    const prev = path.join(root, '.cache', 'foreign-preview');
    const sheet = path.join(prev, 'sheets', 'someone.png');
    mkdirSync(path.dirname(sheet), { recursive: true });
    writeFileSync(sheet, 'keep');
    expect(await codeOfAsync(buildPreview({ ctx, packDir: pack, outDir: prev, log: quiet }))).toBe(
      'E_ASSETS_OUT_FOREIGN',
    );
    expect(existsSync(sheet)).toBe(true);
  });
});
