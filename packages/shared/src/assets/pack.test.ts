import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../util/canonicalJson';
import { AssetContractError, type ContractIssue, contentTypeForPath, hashedPath, pathExt, variantPath } from './common';
import { checkAtlasRefs, checkSpriteFrames } from './crossref';
import {
  atlasFrame,
  checkAtlas,
  checkPackManifest,
  computePackId,
  entryFileRefs,
  groupEntryKeys,
  type PackManifestV1,
  packServablePaths,
  parseAtlas,
  parsePackManifest,
  safeParseAtlas,
  safeParsePackManifest,
  withPackId,
} from './pack';
import { syntheticAtlas, syntheticManifest, syntheticManifestDraft, syntheticSha } from './testing/synthetic';

type Draft = Omit<PackManifestV1, 'packId'>;

/** 修改草稿后重算 packId，只看一致性问题 */
const issuesAfter = (mutate: (d: Draft) => void): string[] => {
  const d = structuredClone(syntheticManifestDraft());
  mutate(d);
  return checkPackManifest(withPackId(d)).map((i: ContractIssue) => `${i.path.join('.')}: ${i.message}`);
};

const parseIssues = (json: unknown): string[] => {
  const r = safeParsePackManifest(json);
  return r.ok ? [] : r.issues;
};

describe('路径工具', () => {
  it('hashedPath 在最后一个扩展名前插入哈希前 8 位', () => {
    const sha = 'ab'.repeat(32);
    expect(hashedPath('sprites/data/88.png', sha)).toBe('sprites/data/88.abababab.png');
    expect(hashedPath('sprites/map/27.mask.png', sha)).toBe('sprites/map/27.mask.abababab.png');
    expect(hashedPath('flic/data/482.flc', sha)).toBe('flic/data/482.abababab.flc');
    expect(hashedPath('data/noext', sha)).toBe('data/noext.abababab');
    expect(hashedPath('a.b/noext', sha)).toBe('a.b/noext.abababab');
  });

  it('扩展名白名单与 Content-Type', () => {
    expect(pathExt('a/b/c.PNG')).toBe('.png');
    expect(pathExt('a/.hidden')).toBe('');
    expect(contentTypeForPath('x.opus')).toBe('audio/ogg');
    expect(contentTypeForPath('x.m4a')).toBe('audio/mp4');
    expect(contentTypeForPath('x.flc')).toBe('application/octet-stream');
    expect(contentTypeForPath('x.html')).toBeNull();
    expect(contentTypeForPath('x.svg')).toBeNull();
    expect(contentTypeForPath('x.js')).toBeNull();
    expect(variantPath('flic/a.flc', 'br')).toBe('flic/a.flc.br');
    expect(variantPath('flic/a.flc', 'gzip')).toBe('flic/a.flc.gz');
  });
});

describe('PackManifestV1', () => {
  it('合成 manifest 通过结构与一致性校验，JSON 往返后仍通过', () => {
    const m = syntheticManifest();
    expect(checkPackManifest(m)).toEqual([]);
    expect(parseIssues(m)).toEqual([]);
    const round = JSON.parse(JSON.stringify(m)) as unknown;
    expect(parsePackManifest(round)).toEqual(m);
  });

  it('packId 由规范化内容决定，与键顺序无关', () => {
    const a = syntheticManifestDraft();
    const reversed = Object.fromEntries(Object.entries(a).reverse()) as Draft;
    reversed.files = Object.fromEntries(Object.entries(a.files).reverse());
    expect(computePackId(reversed)).toBe(computePackId(a));
    expect(canonicalJson(withPackId(reversed))).toBe(canonicalJson(withPackId(a)));
    expect(computePackId(a)).toMatch(/^[0-9a-f]{16}$/);
    const changed = structuredClone(a);
    changed.entries['char.0.walk'] = { ...changed.entries['char.0.walk']!, confidence: 'guess' };
    expect(computePackId(changed)).not.toBe(computePackId(a));
  });

  it('packId 被篡改时拒绝', () => {
    const m = { ...syntheticManifest(), packId: '0123456789abcdef' };
    expect(parseIssues(m)).toEqual(['packId: packId 与内容不符']);
    expect(() => parsePackManifest(m)).toThrow(AssetContractError);
  });

  it('顶层结构：schema、license、未知键、路径穿越、危险 Content-Type 一律拒绝', () => {
    const m = syntheticManifest();
    expect(parseIssues({ ...m, schema: 'rich4.assets/2' }).length).toBeGreaterThan(0);
    expect(parseIssues({ ...m, license: 'cc0' }).length).toBeGreaterThan(0);
    expect(parseIssues({ ...m, extra: 1 }).length).toBeGreaterThan(0);
    const traversal = structuredClone(m);
    traversal.files['../etc/passwd.png'] = traversal.files['images/data/530.png']!;
    expect(parseIssues(traversal).some((s) => s.includes('包内路径格式不正确'))).toBe(true);
    const html = structuredClone(m) as unknown as { files: Record<string, { contentType: string }> };
    html.files['images/data/530.png']!.contentType = 'text/html';
    expect(parseIssues(html).length).toBeGreaterThan(0);
    expect(parseIssues('not json').length).toBeGreaterThan(0);
    expect(parseIssues(null).length).toBeGreaterThan(0);
  });

  it('files：路径必须带内容哈希，扩展名、Content-Type 与 kind 一致', () => {
    expect(
      issuesAfter((d) => {
        d.files['images/data/530.png']!.path = 'images/data/530.png';
      }),
    ).toEqual([
      `files.images/data/530.png.path: path 必须为 ${hashedPath('images/data/530.png', syntheticSha('images/data/530.png'))}`,
    ]);
    expect(
      issuesAfter((d) => {
        d.files['images/data/530.png']!.contentType = 'application/json';
      }),
    ).toEqual([
      'files.images/data/530.png.contentType: 扩展名要求 image/png',
      'files.images/data/530.png.contentType: image 不允许 application/json',
    ]);
    expect(
      issuesAfter((d) => {
        d.files['masks/panel/8.png']!.kind = 'audio';
      }),
    ).toContain('files.masks/panel/8.png.contentType: audio 不允许 image/png');
  });

  it('groups：文件存在、升序、字节数闭合，没有孤儿文件', () => {
    expect(
      issuesAfter((d) => {
        d.groups.card!.bytes += 1;
      }),
    ).toEqual(['groups.card.bytes: bytes 应为 80']);
    expect(
      issuesAfter((d) => {
        d.groups['sfx.board']!.files.reverse();
      }),
    ).toEqual(['groups.sfx.board.files: files 必须升序且唯一']);
    const orphan = issuesAfter((d) => {
      d.groups.video!.files = [];
      d.groups.video!.bytes = 0;
    });
    expect(orphan).toContain('files.video/start.mp4: 文件不属于任何组');
    expect(
      issuesAfter((d) => {
        d.groups.card!.files.push('images/data/999.png');
      }),
    ).toContain('groups.card.files.1: 文件 images/data/999.png 不在 files 中');
  });

  it('entries：组存在、引用文件存在且同组、kind 匹配', () => {
    expect(
      issuesAfter((d) => {
        d.entries['card.1'] = { ...d.entries['card.1']!, group: 'nope' };
      }),
    ).toEqual(['entries.card.1.group: 组 nope 不存在', 'entries.card.1.file: 文件 images/data/530.png 不在组 nope 中']);
    const wrongKind = issuesAfter((d) => {
      const e = d.entries['card.1']!;
      if (e.type === 'image') e.file = 'masks/panel/8.png';
    });
    expect(wrongKind).toEqual(['entries.card.1.file: 文件 masks/panel/8.png 的 kind 应为 image']);
    const otherGroup = issuesAfter((d) => {
      const e = d.entries['char.0.walk']!;
      if (e.type === 'sprite') e.atlas = ['sprites/map/27.json'];
    });
    expect(otherGroup).toEqual(['entries.char.0.walk.atlas.0: 文件 sprites/map/27.json 不在组 char.0 中']);
  });

  it('entries：按类型的自洽检查', () => {
    expect(
      issuesAfter((d) => {
        const e = d.entries['char.0.walk']!;
        if (e.type === 'sprite') e.frames.count = 70;
      }),
    ).toEqual(['entries.char.0.walk.frames.count: 帧数必须是 dirs=8 的整数倍']);
    expect(
      issuesAfter((d) => {
        const e = d.entries['fx.fireworks']!;
        if (e.type === 'flic') e.durationMs += 1;
      }),
    ).toEqual(['entries.fx.fireworks.durationMs: durationMs 必须等于 frames × frameMs']);
    expect(
      issuesAfter((d) => {
        const e = d.entries['fx.fireworks']!;
        if (e.type === 'flic') e.sfx = 'card.1';
      }),
    ).toEqual(['entries.fx.fireworks.sfx: 音效条目 card.1 不存在或不是 audio']);
    expect(
      issuesAfter((d) => {
        const e = d.entries['music.title']!;
        if (e.type === 'audio') e.loop = { startMs: 10, endMs: 999_999 };
      }),
    ).toEqual(['entries.music.title.loop: 循环区间必须满足 0 ≤ startMs < endMs ≤ durationMs']);
    expect(
      issuesAfter((d) => {
        const e = d.entries['voice.1074']!;
        if (e.type === 'audio') e.files = {};
      }),
    ).toEqual(['entries.voice.1074.files: 至少需要一种音频格式']);
    expect(
      issuesAfter((d) => {
        const e = d.entries['sfx.090']!;
        if (e.type === 'audio') e.files = { opus: 'audio/sfx/090.m4a' };
      }),
    ).toEqual(['entries.sfx.090.files.opus: 文件 audio/sfx/090.m4a 的 Content-Type 应为 audio/ogg 或 audio/webm']);
    expect(
      issuesAfter((d) => {
        const e = d.entries['data.voice-map']!;
        if (e.type === 'data') e.schema = 'rich4.flicmap/1';
      }),
    ).toEqual(['entries.data.voice-map.schema: data.voice-map 的 schema 应为 rich4.voicemap/1']);
  });

  it('maps：skin 必须是同组的 mapskin 文件', () => {
    expect(
      issuesAfter((d) => {
        d.maps.test!.skin = 'ground/test/0_0.png';
      }),
    ).toEqual(['maps.test.skin: 文件 ground/test/0_0.png 的 kind 应为 mapskin']);
  });

  it('entryFileRefs / groupEntryKeys / packServablePaths', () => {
    const m = syntheticManifest();
    expect(entryFileRefs(m.entries['sfx.090']!).map((r) => r.file)).toEqual([
      'audio/sfx/090.opus',
      'audio/sfx/090.m4a',
    ]);
    expect(entryFileRefs(m.entries['char.0.walk']!)).toEqual([
      { field: ['atlas', 0], file: 'sprites/data/88.json', kind: 'atlas' },
    ]);
    expect(groupEntryKeys(m, 'map.test')).toEqual(['board.house']);
    const paths = packServablePaths(m);
    expect(paths).toContain(m.files['flic/data/482.flc']!.path);
    expect(paths).toContain(`${m.files['flic/data/482.flc']!.path}.br`);
    expect(paths).not.toContain('flic/data/482.flc');
    expect(paths.length).toBe(Object.keys(m.files).length + 1);
    expect([...paths].sort()).toEqual(paths);
  });
});

describe('图集与 manifest 交叉检查', () => {
  it('图集页位图在同目录、同组；精灵条目的帧都能找到', () => {
    const m = syntheticManifest();
    const atlas = syntheticAtlas();
    expect(checkAtlasRefs(m, 'sprites/data/88.json', atlas)).toEqual([]);
    const walk = m.entries['char.0.walk']!;
    if (walk.type !== 'sprite') throw new Error('unreachable');
    expect(checkSpriteFrames(walk, [atlas])).toEqual([]);
    expect(checkSpriteFrames({ ...walk, frames: { ...walk.frames, count: 80 } }, [atlas])).toEqual([
      { path: ['frames'], message: '图集中缺少帧 Data#88/72、Data#88/73、Data#88/74 等 8 帧' },
    ]);
    expect(checkSpriteFrames({ ...walk, ownerMask: true }, [atlas]).map((i) => i.path)).toEqual([['ownerMask']]);
  });

  it('图集页位图缺失、不在同组或图集本身不在 manifest 时报告', () => {
    const m = syntheticManifest();
    const atlas = syntheticAtlas();
    const missing = { ...atlas, meta: { ...atlas.meta, image: '88.00000000.png' } };
    expect(checkAtlasRefs(m, 'sprites/data/88.json', missing).map((i) => i.message)).toEqual([
      'sprites/data/88.00000000.png 不在 manifest.files 中',
    ]);
    const maskName = m.files['sprites/map/27.mask.png']!.path.split('/').pop()!;
    const withMask = { ...atlas, meta: { ...atlas.meta, r4: { ...atlas.meta.r4, mask: maskName } } };
    expect(checkAtlasRefs(m, 'sprites/data/88.json', withMask).map((i) => i.message)).toEqual([
      `sprites/data/${maskName} 不在 manifest.files 中`,
    ]);
    expect(checkAtlasRefs(m, 'images/data/530.png', atlas)).toEqual([
      { path: ['atlas'], message: 'images/data/530.png 不是 manifest 中的图集' },
    ]);
  });
});

describe('AtlasV1', () => {
  it('合成图集通过校验', () => {
    const a = syntheticAtlas();
    expect(checkAtlas(a)).toEqual([]);
    expect(parseAtlas(JSON.parse(JSON.stringify(a)))).toEqual(a);
  });

  it('atlasFrame 的 anchor = 锚点像素 / 帧尺寸（允许负值）', () => {
    expect(atlasFrame({ x: 0, y: 0, w: 58, h: 64 }, 29, 63).anchor).toEqual({ x: 0.5, y: 63 / 64 });
    expect(atlasFrame({ x: 0, y: 0, w: 189, h: 285 }, 84, -98).anchor).toEqual({ x: 84 / 189, y: -98 / 285 });
  });

  it('锚点不一致、帧超出页面、键不一致、旋转帧一律拒绝', () => {
    const bad = (mutate: (a: ReturnType<typeof syntheticAtlas>) => void): string[] => {
      const a = syntheticAtlas();
      mutate(a);
      const r = safeParseAtlas(a);
      return r.ok ? [] : r.issues;
    };
    expect(
      bad((a) => {
        a.frames['Data#88/0']!.anchor = { x: 0.4, y: 0.5 };
      }),
    ).toEqual(['frames.Data#88/0.anchor: anchor 必须等于 anchorsPx / 帧尺寸']);
    expect(
      bad((a) => {
        a.meta.size = { w: 500, h: 512 };
      }).length,
    ).toBeGreaterThan(0);
    expect(
      bad((a) => {
        delete a.meta.r4.anchorsPx['Data#88/71'];
      }),
    ).toEqual(['meta.r4.anchorsPx: anchorsPx 的键必须与 frames 完全一致']);
    expect(
      bad((a) => {
        (a.frames['Data#88/0'] as { rotated: boolean }).rotated = true;
      }).length,
    ).toBeGreaterThan(0);
    expect(
      bad((a) => {
        a.meta.image = '../x.png';
      }).length,
    ).toBeGreaterThan(0);
  });
});
