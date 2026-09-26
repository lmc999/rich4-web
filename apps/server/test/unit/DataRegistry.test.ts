import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTestMapAllKinds, fixtureRegistry, type MapDef, tablesHash, withDataHash } from '@rich4/shared/data';
import { afterEach, describe, expect, it } from 'vitest';
import { fixtureCatalog, isPendingIssue, loadMapCatalog } from '../../src/data/DataRegistry';
import { createLogger, type LogLevel } from '../../src/infra/logger';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

function capture() {
  const lines: { level: LogLevel; line: string }[] = [];
  return { lines, log: createLogger({ level: 'debug', sink: (line, level) => lines.push({ level, line }) }) };
}

const SOURCE = { id: 'synthetic', fileSha256: '0'.repeat(64), resourceSha256: '0'.repeat(64) };

/** 以 test-allkinds 为底构造一张「数据待补」的地图：去掉股票，企业的 stockIndex 悬空 */
function pendingMap(id: string): MapDef {
  const base = buildTestMapAllKinds();
  return withDataHash({ ...base, id, nameKey: `map.${id}.name`, stocks: [], meta: { ...base.meta, source: SOURCE } });
}

async function writeData(maps: { def: MapDef; pending?: string[]; badSha?: boolean }[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rich4-data-'));
  dirs.push(dir);
  await mkdir(join(dir, 'maps'));
  const entries = [];
  for (const m of maps) {
    const text = JSON.stringify(m.def);
    await writeFile(join(dir, 'maps', `${m.def.id}.map.json`), text);
    entries.push({
      id: m.def.id,
      file: `maps/${m.def.id}.map.json`,
      mapHash: m.def.meta.dataHash,
      sha256: m.badSha ? '0'.repeat(64) : createHash('sha256').update(text).digest('hex'),
      pending: m.pending ?? [],
    });
  }
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ schema: 'rich4.data-manifest/1', maps: entries }));
  return dir;
}

describe('DataRegistry', () => {
  it('fixture 始终可用且可开局', () => {
    const c = fixtureCatalog();
    expect(c.list().map((m) => [m.id, m.playable, m.fixture])).toEqual([
      ['test', true, true],
      ['test-allkinds', true, true],
    ]);
    expect(c.registry.getMap('test').def.id).toBe('test');
    // tablesHash 来自手录 TABLES（不是空对象），与 shared 的 fixtureRegistry 一致
    expect(c.registry.tablesHash).toBe(tablesHash);
    expect(fixtureRegistry.tablesHash).toBe(tablesHash);
  });

  it('manifest.pending 非空的地图只列出、不可开局；由缺项引起的校验错误被放行', async () => {
    const def = pendingMap('island');
    const dir = await writeData([{ def, pending: ['stocks', 'holidays'] }]);
    const { log } = capture();
    const c = await loadMapCatalog({ dataDir: dir, defaultMap: 'island', log });
    const island = c.list().find((m) => m.id === 'island')!;
    expect(island).toMatchObject({ playable: false, pending: ['stocks', 'holidays'], fixture: false });
    expect(c.isPlayable('island')).toBe(false);
    expect(c.def('island')?.meta.dataHash).toBe(def.meta.dataHash);
    expect(c.defaultMap).toBe('test');
  });

  it('同一张图没有 pending 时，缺项引起的错误不再放行；sha256 不符、目录缺失都只剩 fixture', async () => {
    const { log, lines } = capture();
    const strict = await loadMapCatalog({
      dataDir: await writeData([{ def: pendingMap('island') }]),
      defaultMap: 'x',
      log,
    });
    expect(strict.has('island')).toBe(false);
    const good = buildTestMapAllKinds();
    const renamed = withDataHash({ ...good, id: 'good', meta: { ...good.meta, source: SOURCE } });
    const bad = await loadMapCatalog({
      dataDir: await writeData([{ def: renamed, badSha: true }]),
      defaultMap: 'x',
      log,
    });
    expect(bad.has('good')).toBe(false);
    const ok = await loadMapCatalog({ dataDir: await writeData([{ def: renamed }]), defaultMap: 'good', log });
    expect(ok.isPlayable('good')).toBe(true);
    expect(ok.defaultMap).toBe('good');
    const none = await loadMapCatalog({ dataDir: join(tmpdir(), 'rich4-no-such-dir'), defaultMap: 'taiwan', log });
    expect(none.list().map((m) => m.id)).toEqual(['test', 'test-allkinds']);
    expect(lines.some((l) => l.level === 'error')).toBe(true);
  });

  it('manifest.json 语法错误：记 error 后只提供 fixture，不抛异常', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rich4-data-'));
    dirs.push(dir);
    await writeFile(join(dir, 'manifest.json'), '{ not json');
    const { log, lines } = capture();
    const c = await loadMapCatalog({ dataDir: dir, defaultMap: 'taiwan', log });
    expect(c.list().map((m) => m.id)).toEqual(['test', 'test-allkinds']);
    expect(c.defaultMap).toBe('test');
    expect(lines.some((l) => l.level === 'error' && l.line.includes('manifest.json'))).toBe(true);
  });

  it('isPendingIssue 只认 stocks 缺项引起的 stockIndex 悬空', () => {
    const def = pendingMap('island');
    const issue = {
      code: 'E_TILE_REF_MISMATCH' as const,
      severity: 'error' as const,
      path: 'companies[0].stockIndex',
      msg: '',
    };
    expect(isPendingIssue(def, issue, ['stocks'])).toBe(true);
    expect(isPendingIssue(def, issue, [])).toBe(false);
    expect(isPendingIssue(def, { ...issue, path: 'companies[0].frontTiles[0]' }, ['stocks'])).toBe(false);
  });
});
