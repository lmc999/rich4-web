/**
 * 服务器测试用的迷你素材包：以 shared 的合成 manifest 草稿（assets/testing/synthetic）为骨架，
 * 为每个文件生成确定性的真实字节（内容全是自造文本，不含任何原版数据），按内容哈希改写 path / sha256 / bytes，
 * .json 与 .flc 另写 br / gzip 预压缩变体，最后 withPackId 并过一遍契约校验。写到调用方给的临时目录（仓库外）。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import {
  hashedPath,
  type PackFile,
  type PackManifestV1,
  pathExt,
  safeParsePackManifest,
  sortedKeys,
  withPackId,
} from '@rich4/shared/assets';
import { syntheticManifestDraft } from '../../../../packages/shared/src/assets/testing/synthetic';

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** 逻辑路径 → 确定性内容：音视频 10000 字节（Range 测试用），JSON 为可压缩的文本，其余 300 字节 */
export function testContent(lp: string): Buffer {
  const ext = pathExt(lp);
  if (ext === '.json') {
    return Buffer.from(`${JSON.stringify({ test: lp, pad: 'abcdefgh'.repeat(200) })}\n`, 'utf8');
  }
  const size = ['.opus', '.m4a', '.mp4', '.ogg', '.webm', '.weba'].includes(ext) ? 10_000 : 300;
  const unit = Buffer.from(`${lp}|`, 'utf8');
  const out = Buffer.alloc(size);
  for (let i = 0; i < size; i++) out[i] = unit[i % unit.length]!;
  return out;
}

export interface TestPack {
  dir: string;
  manifest: PackManifestV1;
  manifestRaw: Buffer;
  /** 实际路径（带哈希，含变体）→ 内容 */
  contents: Map<string, Buffer>;
  /** 逻辑路径 → 实际路径 */
  pathOf(lp: string): string;
}

export function writeTestPack(dir: string): TestPack {
  const draft = syntheticManifestDraft();
  const files: Record<string, PackFile> = {};
  const contents = new Map<string, Buffer>();
  for (const lp of sortedKeys(draft.files)) {
    const f = draft.files[lp]!;
    const body = testContent(lp);
    const sha = sha256(body);
    const path = hashedPath(lp, sha);
    const next: PackFile = { path, bytes: body.length, sha256: sha, kind: f.kind, contentType: f.contentType };
    contents.set(path, body);
    const ext = pathExt(lp);
    if (ext === '.json' || ext === '.flc') {
      const br = brotliCompressSync(body);
      const gz = gzipSync(body, { level: 9 });
      next.variants = {
        br: { bytes: br.length, sha256: sha256(br) },
        gzip: { bytes: gz.length, sha256: sha256(gz) },
      };
      contents.set(`${path}.br`, br);
      contents.set(`${path}.gz`, gz);
    }
    files[lp] = next;
  }
  const groups = structuredClone(draft.groups);
  for (const g of Object.values(groups)) g.bytes = g.files.reduce((n, lp) => n + files[lp]!.bytes, 0);
  const manifest = withPackId({ ...draft, files, groups });
  const check = safeParsePackManifest(manifest);
  if (!check.ok) throw new Error(`test pack manifest invalid: ${check.issues.join('; ')}`);
  for (const [p, body] of contents) {
    const abs = join(dir, ...p.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  const manifestRaw = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  writeFileSync(join(dir, 'manifest.json'), manifestRaw);
  // 包目录里的杂散文件：不在白名单内，不能被提供
  writeFileSync(join(dir, '.rich4-extract.json'), '{"generator":"test"}\n');
  return { dir, manifest, manifestRaw, contents, pathOf: (lp) => files[lp]!.path };
}
