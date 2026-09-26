import { describe, expect, it } from 'vitest';
import { MkfArchive, MkfError } from '../../src/mkf/container';
import { ascii, buildMkf, getU32, setU32 } from '../helpers/buildMkf';

const body = (n: number, fill = 0x11) => new Uint8Array(n).fill(fill);

describe('MkfArchive 解析', () => {
  it('列出资源并读取未压缩资源体', () => {
    const a = body(10, 0xaa);
    const b = body(3, 0xbb);
    const mkf = MkfArchive.open(buildMkf([{ body: a }, { body: b }]), 't.mkf');
    expect(mkf.count).toBe(2);
    expect(mkf.hasSentinel).toBe(false);
    expect(mkf.indexTableOffset).toBe(4 + 16 + 10 + 16 + 3);
    const [e0, e1] = mkf.entries();
    expect(e0).toMatchObject({
      index: 0,
      offset: 4,
      rawSize: 10,
      storedSize: 10,
      compressed: false,
      kind: 'data',
      gap: 0,
    });
    expect(e1).toMatchObject({ index: 1, offset: 30, rawSize: 3, storedSize: 3 });
    expect(mkf.read(0)).toEqual(a);
    expect(mkf.read(1)).toEqual(b);
    expect(mkf.warnings).toEqual([]);
  });

  it('识别哨兵：最后一项 == indexTableOffset 不计入资源数', () => {
    const mkf = MkfArchive.open(buildMkf([{ body: body(4) }, { body: body(4) }], { sentinel: true }), 's.mkf');
    expect(mkf.hasSentinel).toBe(true);
    expect(mkf.count).toBe(2);
  });

  it('按魔数识别 SPR/SMP/GND，图像字段合法', () => {
    const spr = new Uint8Array(32);
    spr.set(ascii('SPR\0'));
    const gnd = new Uint8Array(32);
    gnd.set(ascii('GND\0'));
    const smp = new Uint8Array(8);
    smp.set(ascii('SMP\0'));
    const mkf = MkfArchive.open(
      buildMkf([
        { body: spr, imageOffset: 16, imageSize: 16 },
        { body: gnd, imageOffset: 8, imageSize: 8 },
        { body: smp },
        { body: body(8), imageOffset: 4, imageSize: 4 },
      ]),
      'k.mkf',
    );
    expect(mkf.entries().map((e) => e.kind)).toEqual(['SPR', 'GND', 'SMP', 'unknown']);
  });

  it('压缩资源：读取时抛 COMPRESSED_NOT_SUPPORTED', () => {
    const mkf = MkfArchive.open(buildMkf([{ body: body(6), rawSize: 20 }]), 'z.mkf');
    expect(mkf.entry(0).compressed).toBe(true);
    expect(mkf.entry(0).kind).toBe('unknown');
    expect(() => mkf.read(0)).toThrow(MkfError);
    expect(() => mkf.read(0)).toThrow(/COMPRESSED_NOT_SUPPORTED/);
  });

  it('资源号不存在时报错', () => {
    const mkf = MkfArchive.open(buildMkf([{ body: body(2) }]), 'x.mkf');
    expect(() => mkf.read(1)).toThrow(/E_MKF_RESOURCE_INDEX/);
    expect(() => mkf.entry(-1)).toThrow(/E_MKF_RESOURCE_INDEX/);
  });

  it('资源之间有空隙：只告警', () => {
    const mkf = MkfArchive.open(buildMkf([{ body: body(4), gapAfter: 3 }, { body: body(4) }]), 'g.mkf');
    expect(mkf.warnings).toHaveLength(1);
    expect(mkf.warnings[0]).toMatchObject({ code: 'W_MKF_GAP', index: 0 });
    expect(mkf.entry(0).gap).toBe(3);
  });
});

describe('MkfArchive 不变量', () => {
  const good = () => buildMkf([{ body: body(8) }, { body: body(8) }, { body: body(8) }]);

  it('indexTableOffset 越界或未对齐', () => {
    const bytes = good();
    setU32(bytes, 0, bytes.length);
    expect(() => MkfArchive.open(bytes, 'a')).toThrow(/E_MKF_INDEX_OFFSET/);
    const b2 = good();
    setU32(b2, 0, getU32(b2, 0) + 2);
    expect(() => MkfArchive.open(b2, 'b')).toThrow(/E_MKF_INDEX_OFFSET/);
    expect(() => MkfArchive.open(new Uint8Array(4), 'c')).toThrow(/E_MKF_TOO_SMALL/);
  });

  it('index[0] 必须为 4', () => {
    const bytes = good();
    const x = getU32(bytes, 0);
    setU32(bytes, x, 8);
    expect(() => MkfArchive.open(bytes, 'a')).toThrow(/E_MKF_FIRST_START/);
  });

  it('索引必须严格递增', () => {
    const bytes = good();
    const x = getU32(bytes, 0);
    setU32(bytes, x + 8, getU32(bytes, x + 4));
    expect(() => MkfArchive.open(bytes, 'a')).toThrow(/E_MKF_INDEX_ORDER/);
  });

  it('索引越过索引表起点', () => {
    const bytes = good();
    const x = getU32(bytes, 0);
    setU32(bytes, x + 8, x + 4);
    expect(() => MkfArchive.open(bytes, 'a')).toThrow(/E_MKF_INDEX_RANGE/);
  });

  it('资源体越过下一项起点', () => {
    const bytes = good();
    setU32(bytes, 4 + 4, 9);
    setU32(bytes, 4, 9);
    expect(() => MkfArchive.open(bytes, 'a')).toThrow(/E_MKF_ENTRY_OVERFLOW/);
  });

  it('16 字节头放不下', () => {
    const bytes = good();
    const x = getU32(bytes, 0);
    setU32(bytes, x + 4, 10);
    expect(() => MkfArchive.open(bytes, 'a')).toThrow(/E_MKF_ENTRY_HEADER/);
  });

  it('imageOffset+imageSize 超过 rawSize', () => {
    const bytes = buildMkf([{ body: body(8), imageOffset: 4, imageSize: 8 }]);
    expect(() => MkfArchive.open(bytes, 'a')).toThrow(/E_MKF_IMAGE_RANGE/);
  });
});
