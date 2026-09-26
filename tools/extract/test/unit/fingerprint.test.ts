import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExitCode, PACKAGE_DIR } from '../../src/context';
import {
  buildFingerprintReport,
  buildLock,
  EXPECTED_FILES,
  identifyFile,
  inspectExe,
  type KnownFiles,
  loadKnownFiles,
} from '../../src/fingerprint/identify';
import { type ScannedFile, scanOriginal } from '../../src/fingerprint/scan';
import { offsetToVa, parsePe, suspiciousSections, vaToOffset } from '../../src/pe/pe';
import { buildPe } from '../helpers/buildPe';

const H = (c: string) => c.repeat(64);
const S1 = (c: string) => c.repeat(40);

const KNOWN: KnownFiles = {
  schema: 'rich4.known-files/1',
  files: [
    {
      id: 'g.exe',
      role: 'exe',
      edition: 'v206',
      path: 'Game/RICH4.EXE',
      sha256: H('a'),
      sha1: null,
      size: null,
      reference: false,
      verified: true,
      source: 't',
    },
    {
      id: 'g.map',
      role: 'mapmkf',
      edition: 'v206',
      path: 'Game/map.mkf',
      sha256: H('b'),
      sha1: null,
      size: null,
      reference: false,
      verified: true,
      source: 't',
    },
    {
      id: 'm.exe',
      role: 'exe',
      edition: 'v311',
      path: 'MultiverseJourney/RICH4.EXE',
      sha256: H('c'),
      sha1: null,
      size: null,
      reference: false,
      verified: true,
      source: 't',
    },
    {
      id: 'm.map',
      role: 'mapmkf',
      edition: 'v311',
      path: 'MultiverseJourney/map.mkf',
      sha256: H('d'),
      sha1: null,
      size: null,
      reference: false,
      verified: true,
      source: 't',
    },
    {
      id: 'ref.exe',
      role: 'exe',
      edition: 'v311',
      path: null,
      sha256: H('e'),
      sha1: null,
      size: 1,
      reference: true,
      verified: false,
      source: 't',
    },
    {
      id: 'ref.data',
      role: 'datamkf',
      edition: 'v311',
      path: null,
      sha256: null,
      sha1: S1('f'),
      size: null,
      reference: true,
      verified: false,
      source: 't',
    },
  ],
};

const file = (p: string, sha256: string, sha1 = S1('0')): ScannedFile => ({ path: p, size: 1, sha256, sha1 });
const fullSet = (): ScannedFile[] => [
  file('Game/rich4.exe', H('a')),
  file('Game/map.mkf', H('b')),
  file('MultiverseJourney/rich4.exe', H('c')),
  file('MultiverseJourney/map.mkf', H('d')),
];

describe('指纹识别', () => {
  it('仓库内 known-files.json 合法，且登记了 5 个已核实的 Steam 文件', async () => {
    const k = await loadKnownFiles(PACKAGE_DIR);
    const verified = k.files.filter((f) => f.verified && !f.reference).map((f) => f.id);
    expect(verified).toHaveLength(5);
    expect(k.files.find((f) => f.id === 'steam.game.exe')?.sha256).toBe(
      '110b29f9d2fadcff3836eb69ec380aa264951859c90955da6e11158d2f956a13',
    );
    expect(k.files.find((f) => f.id === 'steam.mj.exe')?.edition).toBe('v311');
  });

  it('全部已知：exit 0；大小写不同也算同一路径', () => {
    const r = buildFingerprintReport(fullSet(), KNOWN, { allowUnknown: false });
    expect(r.exitCode).toBe(ExitCode.OK);
    expect(r.files.map((f) => f.status)).toEqual(['known', 'known', 'known', 'known']);
    expect(r.missing).toEqual([]);
    expect(r.optionalMissing).toEqual(['Game/MapDat.mkf', 'MultiverseJourney/Data.mkf']);
    expect(buildLock(r).files['Game/map.mkf']).toBe(H('b'));
  });

  it('未知哈希：exit 3；--allow-unknown 放行为 0 并告警', () => {
    const set = [...fullSet(), file('Game/MapDat.MKF', H('9'))];
    const r = buildFingerprintReport(set, KNOWN, { allowUnknown: false });
    expect(r.exitCode).toBe(ExitCode.UNKNOWN_FINGERPRINT);
    const r2 = buildFingerprintReport(set, KNOWN, { allowUnknown: true });
    expect(r2.exitCode).toBe(ExitCode.OK);
    expect(r2.warnings.some((w) => w.includes('Game/MapDat.MKF'))).toBe(true);
  });

  it('缺必需文件：exit 2', () => {
    const r = buildFingerprintReport(fullSet().slice(1), KNOWN, { allowUnknown: true });
    expect(r.exitCode).toBe(ExitCode.MISSING_INPUT);
    expect(r.missing).toEqual(['Game/RICH4.EXE']);
    expect(EXPECTED_FILES.filter((e) => e.required)).toHaveLength(4);
  });

  it('版本目录放错：exit 1', () => {
    const set = fullSet();
    set[0] = file('Game/rich4.exe', H('c'));
    set[2] = file('MultiverseJourney/rich4.exe', H('a'));
    const r = buildFingerprintReport(set, KNOWN, { allowUnknown: false });
    expect(r.files[0]!.status).toBe('misplaced');
    expect(r.exitCode).toBe(ExitCode.STRUCTURE);
  });

  it('参考哈希（mytbk）按 sha256 / sha1 匹配', () => {
    expect(identifyFile(file('MultiverseJourney/rich4.exe', H('e')), KNOWN).status).toBe('reference');
    const d = identifyFile(file('MultiverseJourney/Data.mkf', H('7'), S1('f')), KNOWN);
    expect(d).toMatchObject({ status: 'reference', knownId: 'ref.data' });
  });

  it('扫描目录：只收 .exe/.mkf，路径排序、POSIX 分隔符', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rich4-scan-'));
    try {
      mkdirSync(path.join(dir, 'Game'));
      writeFileSync(path.join(dir, 'Game', 'RICH4.EXE'), 'x');
      writeFileSync(path.join(dir, 'Game', 'map.MKF'), 'abc');
      writeFileSync(path.join(dir, 'Game', 'song.mid'), 'm');
      writeFileSync(path.join(dir, '.DS_Store'), 'z');
      const s = await scanOriginal(dir);
      expect(s.map((f) => f.path)).toEqual(['Game/RICH4.EXE', 'Game/map.MKF']);
      expect(s[1]).toMatchObject({
        size: 3,
        sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('PE 解析', () => {
  const secs = [
    { name: 'AUTO', virtualAddress: 0x1000, virtualSize: 0, rawSize: 0x200, rawPointer: 0x400 },
    { name: 'DGROUP', virtualAddress: 0x3000, virtualSize: 0x100, rawSize: 0x200, rawPointer: 0x600 },
    { name: '.bss', virtualAddress: 0x5000, virtualSize: 0, rawSize: 0x100, rawPointer: 0 },
  ];

  it('节表与 VA/文件偏移互转（VirtualSize=0 按 rawSize）', () => {
    const pe = parsePe(buildPe(secs));
    expect(pe.imageBase).toBe(0x400000);
    expect(pe.sections.map((s) => s.name)).toEqual(['AUTO', 'DGROUP', '.bss']);
    expect(vaToOffset(pe, 0x401010)).toBe(0x410);
    expect(vaToOffset(pe, 0x403080)).toBe(0x680);
    expect(vaToOffset(pe, 0x403100)).toBeNull();
    expect(vaToOffset(pe, 0x405000)).toBeNull();
    expect(offsetToVa(pe, 0x410)).toBe(0x401010);
    expect(offsetToVa(pe, 0x10)).toBeNull();
    expect(suspiciousSections(pe)).toEqual([]);
  });

  it('发现 .bind 节（SteamStub）', () => {
    const pe = parsePe(
      buildPe([...secs, { name: '.bind', virtualAddress: 0x6000, virtualSize: 0, rawSize: 0x10, rawPointer: 0x800 }]),
    );
    expect(suspiciousSections(pe)).toEqual(['.bind']);
    const info = inspectExe(
      buildPe([{ name: '.bind', virtualAddress: 0x1000, virtualSize: 0, rawSize: 0x10, rawPointer: 0x400 }]),
      'x',
    );
    expect(info).toMatchObject({ suspicious: ['.bind'] });
  });

  it('非 PE 文件', () => {
    expect(() => parsePe(new Uint8Array(0x100))).toThrow(/E_PE_DOS/);
    expect(inspectExe(new Uint8Array(4), 'bad')).toHaveProperty('error');
  });
});
