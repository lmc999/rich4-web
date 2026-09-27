import { describe, expect, it } from 'vitest';
import { MKF_DECOMPRESS_FAILED, MkfArchive, MkfError } from '../../src/mkf/container';
import { classifyMkfResource, isBig5Text, type KindInput } from '../../src/mkf/kind';
import { LzhufError } from '../../src/mkf/lzhuf';
import { buildFlc, buildGnd, buildSmp, buildSpr, buildWave, flcByteRun } from '../helpers/buildGfx';
import { buildMkf } from '../helpers/buildMkf';
import { encodeLzhufTokens, lzhufCompress, tokenize } from '../helpers/lzhufEncode';

const big5 = Uint8Array.from([0xa4, 0x6a, 0xb4, 0x49, 0xaf, 0xce, 0x00, 0x0d, 0x0a]); // 大富翁\0\r\n

function kind(body: Uint8Array, img: [number, number] = [0, 0], rawSize = body.length): string {
  const input: KindInput = { rawSize, imageOffset: img[0], imageSize: img[1], head: body, body };
  return classifyMkfResource(input);
}

describe('资源类型判定（合成）', () => {
  const spr = buildSpr([{ w: 2, h: 1, pixels: [0, 1] }], [0, 0x7fff]);
  const smp = buildSmp([{ w: 1, h: 1, pixels: [0x1234] }]);
  const gnd = buildGnd(1, 1, [], [new Uint8Array(1024)]);
  const flc = buildFlc({ w: 2, h: 1, frames: [{ subs: [flcByteRun(Uint8Array.of(0, 0), 2, 1)] }], headerFrames: 1 });
  const wav = buildWave({ rate: 22050, samples: Uint8Array.of(128, 129) });

  it('魔数：SPR/SMP/GND/FLIC/WAVE', () => {
    expect(kind(spr, [24, 512])).toBe('SPR');
    expect(kind(smp, [24, 2])).toBe('SMP');
    expect(kind(gnd, [16, 512])).toBe('GND');
    expect(kind(flc)).toBe('FLIC');
    expect(kind(wav)).toBe('WAVE');
  });

  it('FLIC 需要头部 size 与资源长度一致', () => {
    const bad = flc.slice();
    bad[0] = (bad[0]! + 1) & 0xff;
    expect(kind(bad)).toBe('DATA');
  });

  it('EMPTY / RAW16 / TEXT / DATA / UNKNOWN', () => {
    expect(kind(new Uint8Array(0))).toBe('EMPTY');
    expect(kind(new Uint8Array(80000), [4, 79996])).toBe('RAW16');
    expect(kind(new Uint8Array(100), [4, 96])).toBe('RAW16');
    expect(kind(big5)).toBe('TEXT');
    expect(kind(Uint8Array.of(1, 2, 3, 0x80))).toBe('DATA');
    expect(kind(Uint8Array.of(0x41, 0x42))).toBe('DATA'); // 纯 ASCII 不算 Big5 文本
    expect(kind(new Uint8Array(100), [8, 50])).toBe('UNKNOWN');
    expect(kind(new Uint8Array(100), [0, 100])).toBe('UNKNOWN');
  });

  it('只有前缀、拿不到正文时 TEXT/DATA 判为 UNKNOWN', () => {
    expect(classifyMkfResource({ rawSize: 50, imageOffset: 0, imageSize: 0, head: big5, body: () => null })).toBe(
      'UNKNOWN',
    );
    expect(classifyMkfResource({ rawSize: 50, imageOffset: 0, imageSize: 0, head: big5, body: () => big5 })).toBe(
      'TEXT',
    );
  });

  it('isBig5Text：非法 Big5 序列、控制字节', () => {
    expect(isBig5Text(Uint8Array.of(0xa4))).toBe(false);
    expect(isBig5Text(Uint8Array.of(0xa4, 0x6a, 0x01))).toBe(false);
    expect(isBig5Text(new Uint8Array(0))).toBe(false);
  });
});

describe('MkfArchive：压缩资源自动解压', () => {
  const spr = buildSpr([{ w: 3, h: 2, ax: 1, ay: 2, pixels: [0, 1, 2, 3, 4, 5] }], [0, 0x7c00, 0x03e0, 0x001f]);
  const text = new Uint8Array(300).fill(0xa4);
  for (let i = 1; i < 300; i += 2) text[i] = 0x6a;
  const dataRes = Uint8Array.from({ length: 400 }, (_, i) => i % 7);

  const build = () =>
    buildMkf([
      { body: lzhufCompress(spr).bytes, rawSize: spr.length, imageOffset: 24, imageSize: 512 },
      { body: lzhufCompress(text).bytes, rawSize: text.length },
      { body: lzhufCompress(dataRes).bytes, rawSize: dataRes.length },
      { body: spr, imageOffset: 24, imageSize: 512 },
      { body: new Uint8Array(0) },
    ]);

  it('kind 按解压后的内容判定；read 返回解压结果，readStored 返回原样字节', () => {
    const mkf = MkfArchive.open(build(), 'z.mkf');
    expect(mkf.entries().map((e) => [e.compressed, e.kind])).toEqual([
      [true, 'SPR'],
      [true, 'TEXT'],
      [true, 'DATA'],
      [false, 'SPR'],
      [false, 'EMPTY'],
    ]);
    expect(Buffer.from(mkf.read(0)).equals(Buffer.from(spr))).toBe(true);
    expect(Buffer.from(mkf.read(1)).equals(Buffer.from(text))).toBe(true);
    expect(Buffer.from(mkf.read(2)).equals(Buffer.from(dataRes))).toBe(true);
    expect(mkf.readStored(0).length).toBe(mkf.entry(0).storedSize);
    expect(mkf.read(3)).toEqual(spr);
    expect(mkf.read(4).length).toBe(0);
  });

  it('压缩流不合规：kind=UNKNOWN，read 抛 COMPRESSED_NOT_SUPPORTED 且 cause 为 LzhufError', () => {
    const noEnd = encodeLzhufTokens(tokenize(dataRes)).bytes;
    const mkf = MkfArchive.open(buildMkf([{ body: noEnd, rawSize: dataRes.length }]), 'bad.mkf');
    expect(mkf.entry(0).kind).toBe('UNKNOWN');
    try {
      mkf.read(0);
      throw new Error('应抛错');
    } catch (e) {
      expect(e).toBeInstanceOf(MkfError);
      expect((e as MkfError).code).toBe(MKF_DECOMPRESS_FAILED);
      expect((e as Error).message).toContain('E_LZHUF_NO_END');
      expect((e as Error).cause).toBeInstanceOf(LzhufError);
    }
  });
});
