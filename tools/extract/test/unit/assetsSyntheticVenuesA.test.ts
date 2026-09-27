/**
 * 合成素材包里场所屏第一组（A12：银行 / ATM、百货、乐透投注与开奖、股市）的条目：与原版包同键同组同帧数，
 * 客户端布局依赖的帧尺寸 / 锚点取原版值，跑马灯与摇奖机 FLC 可逐帧解码。全部自绘。
 * 帧与 FLC 直接调生成函数检查（快）；另有一个整包构建的用例确认条目真的写进了 manifest（输出到临时目录，不入库）。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parsePackManifest } from '@rich4/shared/assets';
import { describe, expect, it } from 'vitest';
import { catalogV206, type FlicItem } from '../../src/assets/catalog.v206';
import { buildSyntheticPack } from '../../src/assets/synthetic';
import { SYNTH_UI_SPRITES, synthVenuesA, synthVenuesAFlic, synthVenuesASpriteDims } from '../../src/assets/syntheticUi';
import { ExtractContext, realpathLoose } from '../../src/context';
import { decodeFlcFrames, parseFlc } from '../../src/gfx/flc';

const cat = new Map(catalogV206().items.map((it) => [it.key, it]));

/** 按资源目录的帧数生成 */
const dims = (key: string): [number, number, number, number][] => {
  const it = cat.get(key);
  if (it?.type !== 'sprite' || typeof it.frames !== 'number') throw new Error(key);
  return synthVenuesASpriteDims(key, it.frames);
};

describe('合成包：场所屏第一组', () => {
  it('六个精灵条目、两段 FLC：键在资源目录里、同组，精灵随 UI 精灵一起写进合成包', () => {
    const { sprites, flics } = synthVenuesA();
    expect([...sprites].sort()).toEqual([
      'venue.bank.atm',
      'venue.bank.screen',
      'venue.lottery.bet',
      'venue.lottery.draw',
      'venue.shop.screen',
      'venue.stock.screen',
    ]);
    expect([...flics].sort()).toEqual(['venue.lottery.machine', 'venue.lottery.marquee']);
    for (const k of sprites) {
      expect(SYNTH_UI_SPRITES, k).toContain(k);
      const it = cat.get(k)!;
      expect(it.type, k).toBe('sprite');
      expect(it.confidence, k).not.toBe('guess');
      if (it.type === 'sprite') expect(dims(k), k).toHaveLength(it.frames as number);
    }
    for (const k of flics) {
      const it = cat.get(k)!;
      expect(it.type, k).toBe('flic');
      expect(it.confidence, k).not.toBe('guess');
    }
  });

  it('客户端布局依赖的帧尺寸与锚点同原版', () => {
    const bank = dims('venue.bank.screen');
    expect(bank[0]).toEqual([640, 480, 0, 0]);
    expect(bank[1]).toEqual([344, 240, 62, 198]);
    expect(bank[15]).toEqual([200, 280, 0, 0]);
    expect(bank[16]).toEqual([114, 40, 0, 0]);
    expect(bank[18]).toEqual([80, 40, 0, 0]);
    expect(bank[21]).toEqual([195, 142, 0, 0]);
    expect(bank[22]).toEqual([250, 110, 0, 0]);
    expect(bank[23]).toEqual([29, 29, 14, 14]);

    const atm = dims('venue.bank.atm');
    expect(atm[0]).toEqual([320, 338, 0, 0]);
    expect(atm[1]).toEqual([80, 41, 0, 0]);
    expect(atm[3]).toEqual([43, 41, 0, 0]);
    expect(atm[4]).toEqual([204, 26, 0, 0]);
    for (let f = 5; f <= 16; f++) expect(atm[f]).toEqual([33, 17, 0, 0]);
    expect(atm[17]).toEqual([49, 25, 0, 0]);
    expect(atm[18]).toEqual([57, 25, 0, 0]);
    for (let f = 19; f <= 28; f++) expect(atm[f]).toEqual([18, 32, 0, 0]);
    expect(atm[29]).toEqual([29, 29, 14, 14]);

    const shop = dims('venue.shop.screen');
    expect(shop[1]).toEqual([222, 462, 0, 0]);
    expect(shop[2]).toEqual([173, 448, -52, 208]);
    expect(shop[13]).toEqual([85, 85, 0, 0]);
    expect(shop[16]).toEqual([640, 480, 0, 0]);
    expect(shop[18]).toEqual([182, 256, -21, 229]);
    expect(shop[28]).toEqual([70, 69, 6, 9]);
    expect(shop[35]).toEqual([80, 40, 0, 0]);
    expect(shop[37]).toEqual([90, 40, 0, 0]);

    const bet = dims('venue.lottery.bet');
    expect(bet[7]).toEqual([58, 47, 28, 25]);
    expect(bet[8]).toEqual([237, 192, 0, 0]);
    expect(bet[9]).toEqual([172, 28, 0, 0]);

    const draw = dims('venue.lottery.draw');
    expect(draw[6]).toEqual([162, 460, 0, 0]);
    expect(draw[22]).toEqual([187, 140, 0, 0]);
    expect(draw[23]).toEqual([233, 192, 120, 98]);
    expect(draw[24]).toEqual([295, 262, 147, 130]);
    expect(draw[25]).toEqual([40, 34, 20, 17]);
    for (let f = 37; f <= 46; f++) expect(draw[f]).toEqual([71, 70, 35, 35]);

    const stock = dims('venue.stock.screen');
    expect(stock[0]).toEqual([640, 480, 0, 0]);
    expect(stock[2]).toEqual([587, 375, 0, 0]);
    for (let f = 3; f <= 11; f++) expect(stock[f]).toEqual([80, 112, 0, 0]);
  });

  it('跑马灯（213×68×5，索引 0 透明）与摇奖机（275×270×42，不透明）：头部与资源目录一致、逐帧可解', () => {
    for (const k of synthVenuesA().flics) {
      const d = (cat.get(k) as FlicItem).def;
      const flc = parseFlc(synthVenuesAFlic(k, d.w, d.h, d.frames, d.frameMs), k);
      expect([flc.width, flc.height, flc.frames, flc.speed]).toEqual([d.w, d.h, d.frames, d.frameMs]);
      const frames = decodeFlcFrames(flc);
      expect(frames).toHaveLength(d.frames);
      expect(frames[0]!.pixels.some((v) => v !== 0)).toBe(true);
    }
    expect((cat.get('venue.lottery.marquee') as FlicItem).def.opaque).toBeFalsy();
    expect((cat.get('venue.lottery.machine') as FlicItem).def.opaque).toBe(true);
  });

  it('整包构建：条目写进 manifest（同组、帧数、FLC 透明方式）', { timeout: 240_000 }, async () => {
    const root = realpathLoose(mkdtempSync(path.join(tmpdir(), 'rich4-synth-venues-a-')));
    try {
      const dir = path.join(root, '.cache', 'synthetic-pack');
      const ctx = new ExtractContext({ root, logger: { out: () => {}, err: () => {} } });
      await buildSyntheticPack({ ctx, outDir: dir });
      const m = parsePackManifest(JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')));
      for (const k of synthVenuesA().sprites) {
        const e = m.entries[k]!;
        const it = cat.get(k)!;
        expect(e.type === 'sprite' && [e.group, e.frames.count], k).toEqual([
          it.group,
          it.type === 'sprite' ? it.frames : -1,
        ]);
      }
      const mq = m.entries['venue.lottery.marquee']!;
      const mc = m.entries['venue.lottery.machine']!;
      expect(mq.type === 'flic' && [mq.w, mq.h, mq.frames, mq.transparency]).toEqual([213, 68, 5, 'index0']);
      expect(mc.type === 'flic' && [mc.w, mc.h, mc.frames, mc.transparency]).toEqual([275, 270, 42, 'opaque']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
