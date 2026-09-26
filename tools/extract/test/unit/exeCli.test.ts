import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../../src/cli';
import { ExitCode, realpathLoose } from '../../src/context';
import { buildSynthExe } from '../helpers/buildExe';
import { buildMapResource, taiwanLikeSpec } from '../helpers/buildMapResource';
import { buildMkf } from '../helpers/buildMkf';

let root: string;
let out: string[];
let err: string[];
const logger = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
const run = (...args: string[]) => main([...args, '--root', root], { logger, cwd: root });
const at = (...p: string[]) => path.join(root, ...p);

function put(rel: string, bytes: Uint8Array | string): void {
  mkdirSync(path.dirname(at(rel)), { recursive: true });
  writeFileSync(at(rel), bytes);
}

function writeExes(opts: { v206?: boolean; v311?: boolean } = {}): void {
  if (opts.v206 !== false) put('original/Game/RICH4.EXE', buildSynthExe({ maps: 1, dataShift: 0x40 }).bytes);
  if (opts.v311 !== false) put('original/MultiverseJourney/rich4.exe', buildSynthExe({ maps: 2 }).bytes);
}

beforeEach(() => {
  root = realpathLoose(mkdtempSync(path.join(tmpdir(), 'rich4-extract-exe-')));
  out = [];
  err = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('CLI exe tables / exe diff / verify --tables（合成 exe）', () => {
  it('exe tables：两版都唯一定位，写 tables.<edition>.json；v2.06 带 xref 交叉核对', async () => {
    writeExes();
    expect(await run('exe', 'tables')).toBe(ExitCode.OK);
    const t206 = JSON.parse(readFileSync(at('.cache', 'extract', 'tables.v206.json'), 'utf8'));
    const t311 = JSON.parse(readFileSync(at('.cache', 'extract', 'tables.v311.json'), 'utf8'));
    expect(t206).toMatchObject({ schema: 'rich4.exe-tables/1', edition: 'v206', stocks: { maps: 1 } });
    expect(t311.stocks.maps).toBe(2);
    const xref = t206.locate.cards.candidates.find((c: { method: string }) => c.method === 'xref');
    expect(xref).toMatchObject({ accepted: true, va: t206.locate.cards.va });
    expect(out.join('\n')).toContain('全部表唯一定位且结构校验通过');
    // 确定性
    const before = readFileSync(at('.cache', 'extract', 'tables.v206.json'), 'utf8');
    expect(await run('exe', 'tables', '--edition', 'v206')).toBe(ExitCode.OK);
    expect(readFileSync(at('.cache', 'extract', 'tables.v206.json'), 'utf8')).toBe(before);
  });

  it('exe tables：缺 exe → exit 2；--edition 非法 → exit 1；卡价不符 → exit 1', async () => {
    expect(await run('exe', 'tables')).toBe(ExitCode.MISSING_INPUT);
    expect(await run('exe', 'tables', '--edition', 'v999')).toBe(ExitCode.STRUCTURE);
    put('original/MultiverseJourney/RICH4.EXE', buildSynthExe({ cardPrice19: 30 }).bytes);
    expect(await run('exe', 'tables', '--edition', 'v311')).toBe(ExitCode.STRUCTURE);
    expect(out.join('\n')).toContain('cards.disputedPrices');
  });

  it('verify --tables：手录表缺失 → 只输出 exe 值与对照清单，exit 0；没有 exe 也没有缓存 → exit 2', async () => {
    expect(await run('verify', '--tables')).toBe(ExitCode.MISSING_INPUT);
    writeExes();
    expect(await run('verify', '--tables')).toBe(ExitCode.OK);
    const rep = JSON.parse(readFileSync(at('.cache', 'extract', 'verify', 'tables.json'), 'utf8'));
    expect(rep.editions).toEqual(['v206', 'v311']);
    expect(rep.verdicts.every((v: { manual: string }) => v.manual === 'missing')).toBe(true);
    expect(rep.checklist.length).toBe(5);
    expect(out.join('\n')).toContain('对照清单');
    // 没有原版 exe 时读缓存
    rmSync(at('original'), { recursive: true, force: true });
    expect(await run('verify', '--tables')).toBe(ExitCode.OK);
  });

  it('verify --tables：手录值与 exe 不符 → exit 1，并核对 @verify 引用', async () => {
    writeExes();
    const rows = Array.from({ length: 30 }, (_, i) => {
      const price = i === 18 ? 30 : 'P';
      return `{ id: ${i + 1}, price: ${price}, deckCount: D[${i}], f7: F[${i}], src: [{ verify: 'extract:cards[${i + 1}].price' }] }`;
    });
    put(
      'packages/shared/src/data/tables/cards.ts',
      `const T = ${JSON.stringify(buildSynthExe().bytes.length)};\n` +
        'const PR = [200,200,35,25,20,20,15,20,160,180,60,15,25,20,100,25,20,20,40,25,25,10,20,50,30,35,35,35,40,70];\n' +
        'const D = [1,2,4,4,4,3,8,3,2,1,2,5,4,4,2,4,4,4,4,4,4,3,3,3,3,4,3,3,2,3];\n' +
        'const F = Array.from({ length: 30 }, (_, i) => i % 2);\n' +
        `export const CARDS = [${rows.map((r, i) => r.replace("'P'", `PR[${i}]`).replace('price: P', `price: PR[${i}]`)).join(',\n')}];\n` +
        'void T;\n',
    );
    put(
      'packages/shared/src/data/tables/items.ts',
      "export const ITEMS = [{ id: 1, src: [{ verify: 'extract:items[99]' }] }];\n",
    );
    expect(await run('verify', '--tables')).toBe(ExitCode.STRUCTURE);
    const text = out.join('\n');
    expect(text).toContain('cards 19.price：手录 30');
    expect(text).toContain('extract:items[99]');
    const rep = JSON.parse(readFileSync(at('.cache', 'extract', 'verify', 'tables.json'), 'utf8'));
    expect(rep.verdicts.find((v: { table: string }) => v.table === 'cards')).toMatchObject({
      manual: 'mismatch',
      mismatches: 1,
    });
    expect(rep.notes).toContain('items.ts 没有 13 项 {id,price,poolInit} 的 ITEMS');
  });

  it('exe diff：写 docs/research/version-diff.md（含地图比较，不含 hex），重复生成字节一致', async () => {
    writeExes();
    const body = buildMapResource(taiwanLikeSpec());
    const filler = { body: Uint8Array.from([1, 2, 3, 4]) };
    put('original/Game/MapDat.MKF', buildMkf([{ body }]));
    put('original/Game/map.mkf', buildMkf([filler, { body }]));
    put('original/MultiverseJourney/map.mkf', buildMkf([filler, { body }]));
    expect(await run('exe', 'diff')).toBe(ExitCode.OK);
    const p = at('docs', 'research', 'version-diff.md');
    const md = readFileSync(p, 'utf8');
    for (const h of ['## 1. 输入指纹', '## 2. 容器', '## 3. 地图', '## 4. 固定表', '## 7. 结论'])
      expect(md).toContain(h);
    expect(md).toContain('| 0 | 台灣 |');
    expect(md).toContain('嫁禍');
    expect(md).not.toMatch(/"hex"|rawHex/);
    expect(existsSync(at('.cache', 'extract', 'version-diff.json'))).toBe(true);
    expect(await run('exe', 'diff')).toBe(ExitCode.OK);
    expect(readFileSync(p, 'utf8')).toBe(md);
  });

  it('exe diff：缺一个版本 → exit 2', async () => {
    writeExes({ v206: false });
    expect(await run('exe', 'diff')).toBe(ExitCode.MISSING_INPUT);
  });
});
