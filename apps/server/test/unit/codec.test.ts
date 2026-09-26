/**
 * codec（design/net.md §11.3 unit/codec）：gzip 与 HMAC 往返、篡改后验签失败、R4S1 编解码、压缩炸弹上限、
 * 以及「组装存档 → 编码签名 → 导出文本 → 解码验签 → migrateSave」整条链。
 */
import { gzipSync } from 'node:zlib';
import { defaultGameConfig } from '@rich4/shared/engine';
import { defaultRoomSettings } from '@rich4/shared/net';
import { migrateSave, SaveFormatError } from '@rich4/shared/save';
import { canonicalJson } from '@rich4/shared/util';
import { describe, expect, it } from 'vitest';
import {
  CodecError,
  decodeR4S1,
  encodeR4S1,
  fromB64url,
  gunzipJson,
  gzipJson,
  randomSecret,
  Signer,
  sha256Hex,
} from '../../src/persistence/codec';
import { buildSaveFile } from '../../src/persistence/SaveService';
import { TEST_SEED } from '../helpers/runnerHarness';
import { createStubEngine } from '../helpers/stubEngine';

const SECRET = 'x'.repeat(32);

function codecReason(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof CodecError) return e.reason;
    throw e;
  }
  return 'ok';
}

describe('gzip(JSON)', () => {
  it('往返保持值不变（含中文与嵌套）', () => {
    const v = { a: [1, 2, { b: '台北 101' }], c: null, d: -3.5 };
    const blob = gzipJson(v);
    expect(blob[0]).toBe(0x1f);
    expect(gunzipJson(blob)).toEqual(v);
  });

  it('不是 gzip、不是 JSON、解压超限都抛 CodecError', () => {
    expect(codecReason(() => gunzipJson(new Uint8Array([1, 2, 3])))).toBe('badEncoding');
    expect(codecReason(() => gunzipJson(new Uint8Array(gzipSync('not json'))))).toBe('badJson');
    const bomb = new Uint8Array(gzipSync(Buffer.alloc(64 * 1024, 0x20)));
    expect(bomb.length).toBeLessThan(1024);
    expect(codecReason(() => gunzipJson(bomb, 4096))).toBe('tooLarge');
  });

  it('sha256Hex 已知向量', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('HMAC 签名', () => {
  const s = new Signer(SECRET);
  const blob = gzipJson({ hello: 'world' });

  it('签名可以验证；篡改一个字节、换密钥、空签名都失败', () => {
    const sig = s.sign(blob);
    expect(sig).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.verify(blob, sig)).toBe(true);
    const tampered = blob.slice();
    tampered[tampered.length - 5] = tampered[tampered.length - 5]! ^ 0xff;
    expect(s.verify(tampered, sig)).toBe(false);
    expect(new Signer('y'.repeat(32)).verify(blob, sig)).toBe(false);
    expect(s.verify(blob, '')).toBe(false);
    expect(s.verify(blob, 'not base64!')).toBe(false);
    expect(s.verify(blob, sig.slice(0, 20))).toBe(false);
  });

  it('密钥至少 32 字节；随机密钥满足要求', () => {
    expect(() => new Signer('short')).toThrow();
    expect(() => new Signer(randomSecret())).not.toThrow();
  });
});

describe('R4S1 导出文本', () => {
  const blob = gzipJson({ n: 1 });

  it('编码与解码往返；未验证的存档签名段为空', () => {
    const text = encodeR4S1(blob, 'abc_-');
    expect(text.startsWith('R4S1.')).toBe(true);
    expect(decodeR4S1(`  ${text}\n`)).toEqual({ blob, sig: 'abc_-' });
    const unsigned = encodeR4S1(blob, '');
    expect(unsigned.endsWith('.')).toBe(true);
    expect(decodeR4S1(unsigned).sig).toBe('');
  });

  it('前缀、段数、字符集不对一律拒绝', () => {
    expect(codecReason(() => decodeR4S1('R4S2.AAAA.'))).toBe('badEncoding');
    expect(codecReason(() => decodeR4S1('R4S1.AAAA'))).toBe('badEncoding');
    expect(codecReason(() => decodeR4S1('R4S1.AA+A.sig'))).toBe('badEncoding');
    expect(codecReason(() => decodeR4S1('R4S1.AAAA.si=g'))).toBe('badEncoding');
    expect(codecReason(() => decodeR4S1('R4S1..sig'))).toBe('badEncoding');
    expect(codecReason(() => fromB64url('a b'))).toBe('badEncoding');
  });
});

describe('存档整条链', () => {
  it('buildSaveFile → gzip + 签名 → R4S1 → 解码验签 → migrateSave，state 规范 JSON 不变', () => {
    const engine = createStubEngine();
    const state = engine.createGame(
      { ...defaultGameConfig('test', 20260927), debug: true },
      [
        { seat: 0, character: 3, controller: 'human' },
        { seat: 2, character: 5, controller: 'ai', ai: { preset: 'normal' } },
      ],
      TEST_SEED,
    );
    const file = buildSaveFile({
      name: '测试存档',
      savedAt: 1,
      engine,
      settings: defaultRoomSettings(state.config),
      seats: [
        { index: 0, characterId: 3, nickname: 'A', kind: 'human', ownerTokenHash: 'f'.repeat(64) },
        { index: 2, characterId: 5, nickname: 'AI3', kind: 'ai', ai: { preset: 'normal' } },
      ],
      state,
      chat: [],
    });
    expect(file.meta).toEqual({
      mapId: 'test',
      gameDay: state.clock.elapsedDays,
      date: state.clock.date,
      seats: [
        { characterId: 3, nickname: 'A', kind: 'human' },
        { characterId: 5, nickname: 'AI3', kind: 'ai' },
      ],
    });
    const signer = new Signer(SECRET);
    const blob = gzipJson(file);
    const text = encodeR4S1(blob, signer.sign(blob));
    const back = decodeR4S1(text);
    expect(signer.verify(back.blob, back.sig)).toBe(true);
    const save = migrateSave(gunzipJson(back.blob));
    expect(canonicalJson(save.game)).toBe(canonicalJson(state));
    expect(save.seats.map((x) => x.index)).toEqual([0, 2]);

    // 改动内容但沿用旧签名：仍可解码（非官方存档），验签失败
    const forged = gzipJson({ ...file, name: '改过的' });
    expect(signer.verify(forged, back.sig)).toBe(false);
    expect(migrateSave(gunzipJson(forged)).name).toBe('改过的');
  });

  it('未来版本的存档被 migrateSave 拒绝', () => {
    expect(() => migrateSave({ format: 'rich4-save', schemaVersion: 99 })).toThrow(SaveFormatError);
  });
});
