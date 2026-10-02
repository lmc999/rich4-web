/**
 * 原版皮肤 A2：资源目录 catalog.v206 的结构自检（不读原版文件）。
 * 编号依据 docs/research/original-assets/{sprites,render,ui}.md，这里只核对公式、唯一性、分组与覆盖率。
 */
import { ASSET_CATEGORIES, LOGICAL_KEY_RE } from '@rich4/shared/assets';
import { describe, expect, it } from 'vitest';
import {
  CATALOG_MKFS,
  type CatalogItem,
  CHAR_POSES,
  catalogCoverage,
  catalogV206,
  categoryOfGroup,
  FATE_ART_TABLE,
  flicPlacementKey,
  HOLIDAY_ART_BASE,
  HOLIDAY_COUNT,
  holidayArtKey,
  landmarkGroup,
  ORIGINAL_MAPS,
  ROAD_OBJECTS,
  SHARED_LANDMARKS,
  setupBgKey,
  TAIWAN,
  TAIWAN_COMPANY_SPRITES,
  TAIWAN_SCENERY_SPRITES,
  unreferencedLandmarks,
  V206_RESOURCE_COUNTS,
  validateCatalog,
} from '../../src/assets/catalog.v206';
import { FLIC_DEFS } from '../../src/assets/data/flic';

const cat = catalogV206();
const byKey = new Map(cat.items.map((it) => [it.key, it]));
const at = (mkf: string, res: number): CatalogItem | undefined =>
  cat.items.find((it) => it.mkf === mkf && it.res === res);

describe('catalog.v206 结构', () => {
  it('自检无问题：键唯一、资源号不重复、排除段不重叠、分组有类别', () => {
    expect(validateCatalog(cat)).toEqual([]);
  });

  it('逻辑键与分组都符合契约的逻辑键格式，类别在契约枚举内', () => {
    for (const it of cat.items) {
      expect(it.key, it.key).toMatch(LOGICAL_KEY_RE);
      expect(it.group, it.key).toMatch(LOGICAL_KEY_RE);
      expect(ASSET_CATEGORIES).toContain(categoryOfGroup(it.group));
    }
  });

  it('覆盖率 100%：每个图像资源要么收录、要么带理由排除', () => {
    const cov = catalogCoverage(cat);
    expect(cov.totals.uncataloged).toBe(0);
    expect(cov.percent).toBe(100);
    expect(cov.totals.total).toBe(Object.values(V206_RESOURCE_COUNTS).reduce((s, n) => s + n, 0));
    for (const m of CATALOG_MKFS) expect(cov.archives[m].uncataloged).toEqual([]);
    for (const ex of cat.exclusions) expect(ex.reason.length).toBeGreaterThan(4);
  });

  it('条目按 (mkf, 资源号) 排序（build 的处理顺序确定）', () => {
    const order = cat.items.map((it) => CATALOG_MKFS.indexOf(it.mkf) * 1000 + it.res);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe('catalog.v206 编号公式', () => {
  it('角色 21 套姿态：Data#87+21c+k，8 方向；k=9–11 工程车 guess，k=12、16–20 visual，其余 exe', () => {
    expect(CHAR_POSES).toHaveLength(21);
    for (let c = 0; c < 12; c++) {
      for (const p of CHAR_POSES) {
        const it = byKey.get(`char.${c}.${p.name}`)!;
        expect(it.res).toBe(87 + 21 * c + p.k);
        expect(it.group).toBe(`char.${c}`);
        expect(it.type === 'sprite' && it.dirs).toBe(8);
      }
    }
    const conf = (k: number) => CHAR_POSES.find((p) => p.k === k)!.confidence;
    expect([9, 10, 11].map(conf)).toEqual(['guess', 'guess', 'guess']);
    expect([12, 16, 17, 18, 19, 20].map(conf)).toEqual(Array(6).fill('visual'));
    expect([0, 1, 2, 13, 14, 15].map(conf)).toEqual(Array(6).fill('exe'));
  });

  // 回归（线上反馈「选的是忍太郎，头像却是金贝贝」的排查）：按角色号取的每一种条目，角色号 c → 资源号的公式。
  // 这些公式已用本机真实素材包逐行目视核对过（12 行 × 每一列都是同一个人物；test/pc-char-montage.mjs、pc-char-flics.ts）。
  it('按角色号取的条目：角色 c → 资源号（头像、讲话头像、侧视走动、Q 版小人、接物姿态、跳伞 / 表情 FLIC）', () => {
    const face = byKey.get('portrait.face72')!;
    expect([face.mkf, face.res, face.type === 'sprite' && face.frames]).toEqual(['Data', 2, 12]);
    const owner = byKey.get('board.ownerMark')!;
    expect([owner.mkf, owner.res, owner.type === 'sprite' && owner.frames]).toEqual(['map', 13, 12]);
    const res = (key: string): [string, number] => {
      const it = byKey.get(key);
      if (!it) throw new Error(`没有条目 ${key}`);
      return [it.mkf, it.res];
    };
    for (let c = 0; c < 12; c++) {
      expect(res(`portrait.speaker.${c}`)).toEqual(['map', 15 + c]);
      ['walk', 'moto', 'car'].forEach((v, i) => {
        expect(res(`title.sidewalk.${c}.${v}`)).toEqual(['jump', 5 + 3 * c + i]);
      });
      for (let i = 0; i < 3; i++) expect(res(`venue.chibi.${c}.${i}`)).toEqual(['Panel', 27 + 3 * c + i]);
      expect(res(`mg.xicong.char.${c}`)).toEqual(['Panel', 100 + c]);
      expect(res(`char.${c}.parachute`)).toEqual(['Data', 518 + c]);
      expect(res(`char.${c}.emoteA`)).toEqual(['Data', 375 + 2 * c]);
      expect(res(`char.${c}.emoteB`)).toEqual(['Data', 376 + 2 * c]);
      expect(res(`title.freefall.${c}`)).toEqual(['jump', 43 + c]);
      expect(res(`title.parachuteOpen.${c}`)).toEqual(['jump', 55 + c]);
    }
  });

  it('路面物件 Data#354+t（t 与 GodKind 相同），路障/地雷/炸弹 370–372，ZZZ 373', () => {
    for (const o of ROAD_OBJECTS) expect(byKey.get(`object.${o.name}`)!.res).toBe(354 + o.t);
    expect(['object.roadblock', 'object.mine', 'object.bomb', 'object.zzz'].map((k) => byKey.get(k)!.res)).toEqual([
      370, 371, 372, 373,
    ]);
  });

  it('map.mkf：住宅 27+L−1（台湾）、连锁店 47、设施 48+(kind−1)·5+L、企业/景观 spriteRes+26', () => {
    for (let L = 1; L <= 5; L++) expect(byKey.get(`map.taiwan.house.${L}`)!.res).toBe(26 + L);
    expect(TAIWAN).toEqual({ mapId: 'taiwan', gm: 0 });
    expect(byKey.get('board.chain')!.res).toBe(47);
    expect(byKey.get('board.facility.park')!.res).toBe(48);
    expect(byKey.get('board.facility.hotel.1')!.res).toBe(49);
    expect(byKey.get('board.facility.mall.5')!.res).toBe(58);
    expect(byKey.get('board.facility.lab.5')!.res).toBe(68);
    // 已核对：醫院 61→87、綠島 123→149、臺灣人壽 49→75
    expect(TAIWAN_SCENERY_SPRITES).toContain(87);
    expect(TAIWAN_SCENERY_SPRITES).toContain(149);
    expect(TAIWAN_COMPANY_SPRITES).toContain(75);
    expect(TAIWAN_COMPANY_SPRITES.length + TAIWAN_SCENERY_SPRITES.length).toBe(21);
  });

  it('主人色掩膜只标在 map.mkf 的住宅（四张图 27–46）、连锁店、设施与企业上（景观不改色）', () => {
    const owners = cat.items.filter((it) => it.type === 'sprite' && it.ownerMask);
    for (const it of owners) expect(it.mkf).toBe('map');
    const companies = [...new Set(ORIGINAL_MAPS.flatMap((m) => m.companies))];
    expect(owners.map((it) => it.res).sort((a, b) => a - b)).toEqual(
      [
        ...Array.from({ length: 20 }, (_, i) => 27 + i),
        ...Array.from({ length: 22 }, (_, i) => 47 + i),
        ...companies,
      ].sort((a, b) => a - b),
    );
  });

  it('lotHighlight 标 guess；装饰锚点在图心；卡片 k = Data#529+k 全表：165×256 不透明整图、exe 证据', () => {
    expect(byKey.get('board.lotHighlight')!.confidence).toBe('guess');
    const decor = byKey.get('board.decor')!;
    expect(decor.type === 'sprite' && decor.anchor).toBe('center');
    const cards = cat.items.filter((it) => it.group === 'card');
    expect(cards.map((it) => [it.key, it.mkf, it.res])).toEqual(
      Array.from({ length: 30 }, (_, i) => [`card.${i + 1}`, 'Data', 530 + i]),
    );
    for (let k = 1; k <= 30; k++) {
      const it = byKey.get(`card.${k}`)!;
      expect(it.res).toBe(529 + k);
      expect(it.type).toBe('image');
      if (it.type !== 'image') continue;
      expect([it.kind, it.w, it.h, it.transparency, it.confidence]).toEqual(['RAW16', 165, 256, 'opaque', 'exe']);
      expect(it.src.join(' ')).toContain('0x440bea');
    }
    // 目录里不再有四角泛洪抠图的整图（corner-rgb0 只为旧素材包的契约保留）
    expect(cat.items.filter((it) => it.type === 'image' && it.transparency === 'corner-rgb0')).toEqual([]);
    expect(byKey.get('illustration.news.4')!.res).toBe(404);
  });

  it('FLIC：A3 的 105 段全部收录，逻辑键唯一，神明降临按 GodKind 名、按角色的动画带角色号', () => {
    const flics = cat.items.filter((it) => it.type === 'flic');
    expect(flics).toHaveLength(FLIC_DEFS.length);
    expect(flics).toHaveLength(105);
    expect(flicPlacementKey(FLIC_DEFS.find((d) => d.res === 499 && d.mkf === 'Data')!).key).toBe('fx.god.smallWealth');
    expect(at('Data', 518)!.key).toBe('char.0.parachute');
    expect(at('jump', 66)!.key).toBe('title.parachuteOpen.11');
    expect(at('Panel', 78)!.group).toBe('mg.common');
  });

  it('命中掩膜：GO 钮 4 区、魔法屋 13、计算器 16、企鹅最大区号 77', () => {
    const regions = (k: string) => {
      const it = byKey.get(k)!;
      return it.type === 'mask' ? it.regions : -1;
    };
    expect(['ui.goButton.mask', 'venue.magic.mask', 'ui.numpad.mask', 'mg.penguin.mask'].map(regions)).toEqual([
      4, 13, 16, 77,
    ]);
  });
});

describe('catalog.v206 四张原版地图（ORIGINAL_MAPS，gm 0–3）', () => {
  it('地图 id 与 gm：taiwan 0、china 1、japan 2、usa 3（开局设置关卡一至四，exe 0x46aac4 第 9–12 项）', () => {
    expect(ORIGINAL_MAPS.map((m) => [m.mapId, m.gm])).toEqual([
      ['taiwan', 0],
      ['china', 1],
      ['japan', 2],
      ['usa', 3],
    ]);
    expect(ORIGINAL_MAPS[0]!.companies).toBe(TAIWAN_COMPANY_SPRITES);
    expect(ORIGINAL_MAPS[0]!.scenery).toBe(TAIWAN_SCENERY_SPRITES);
    expect(cat.maps).toBe(ORIGINAL_MAPS);
  });

  it('每张图：地面 map#2gm（2×2 切块）、小地图 map#8+gm、住宅 map#27+5gm+L−1，分组 map.<id>', () => {
    for (const m of ORIGINAL_MAPS) {
      const g = byKey.get(`map.${m.mapId}.ground`)!;
      expect(g.type === 'ground' && [g.res, g.mapId, g.cols, g.rows, g.group]).toEqual([
        2 * m.gm,
        m.mapId,
        2,
        2,
        `map.${m.mapId}`,
      ]);
      const mini = byKey.get(`map.${m.mapId}.minimap`)!;
      expect([mini.mkf, mini.res, mini.group, mini.type === 'sprite' && mini.frames]).toEqual([
        'map',
        8 + m.gm,
        `map.${m.mapId}`,
        2,
      ]);
      for (let L = 1; L <= 5; L++) {
        const h = byKey.get(`map.${m.mapId}.house.${L}`)!;
        expect([h.res, h.group, h.type === 'sprite' && h.ownerMask]).toEqual([
          27 + 5 * m.gm + L - 1,
          `map.${m.mapId}`,
          true,
        ]);
      }
    }
  });

  it('企业/景观精灵：多图共用 {75,80,82,84,87,132,144} 进 board.landmarks，其余进唯一引用它的图；企业与景观不重叠', () => {
    const count = new Map<number, number>();
    for (const m of ORIGINAL_MAPS)
      for (const r of new Set([...m.companies, ...m.scenery])) count.set(r, (count.get(r) ?? 0) + 1);
    const derived = [...count]
      .filter(([, n]) => n > 1)
      .map(([r]) => r)
      .sort((a, b) => a - b);
    expect(SHARED_LANDMARKS).toEqual(derived);
    const companies = new Set(ORIGINAL_MAPS.flatMap((m) => m.companies));
    const scenery = new Set(ORIGINAL_MAPS.flatMap((m) => m.scenery));
    expect([...companies].filter((r) => scenery.has(r))).toEqual([]);
    for (const res of count.keys()) {
      const it = byKey.get(`board.landmark.${res}`)!;
      expect([it.mkf, it.res], `map#${res}`).toEqual(['map', res]);
      expect(it.group, `map#${res}`).toBe(landmarkGroup(res));
      expect(it.type === 'sprite' && it.ownerMask, `map#${res}`).toBe(companies.has(res));
    }
    expect(byKey.get('board.landmark.85')!.group).toBe('map.china');
    expect(byKey.get('board.landmark.76')!.group).toBe('map.japan');
    expect(byKey.get('board.landmark.79')!.group).toBe('map.usa');
    expect(byKey.get('board.landmark.149')!.group).toBe('map.taiwan');
    expect(cat.items.filter((it) => it.group === 'board.landmarks').map((it) => it.res)).toEqual([...SHARED_LANDMARKS]);
  });

  it('台湾键名与分组快照：旧键全在、资源号不变；只有共用精灵 75/80/84/87/144 从 map.taiwan 挪到 board.landmarks', () => {
    const taiwan: [string, number, string][] = [
      ['map.taiwan.ground', 0, 'map.taiwan'],
      ['map.taiwan.minimap', 8, 'map.taiwan'],
      ...[1, 2, 3, 4, 5].map((L): [string, number, string] => [`map.taiwan.house.${L}`, 26 + L, 'map.taiwan']),
      ...[...TAIWAN_COMPANY_SPRITES, ...TAIWAN_SCENERY_SPRITES]
        .sort((a, b) => a - b)
        .map((r): [string, number, string] => [
          `board.landmark.${r}`,
          r,
          [75, 80, 84, 87, 144].includes(r) ? 'board.landmarks' : 'map.taiwan',
        ]),
    ];
    expect(taiwan).toHaveLength(28);
    for (const [key, res, group] of taiwan) {
      const it = byKey.get(key);
      expect(it && [it.mkf, it.res, it.group], key).toEqual(['map', res, group]);
    }
    expect(cat.items.filter((it) => it.group === 'map.taiwan')).toHaveLength(23);
  });

  it('节日插画：Data#基址[gm]+slot（exe 0x473098 = 4/28/47/67），键沿用全局编号 res−4，共 24+19+19+20 = 82 张', () => {
    expect(HOLIDAY_ART_BASE).toEqual([4, 28, 47, 67]);
    expect(HOLIDAY_COUNT).toEqual([24, 19, 19, 20]);
    const hol = cat.items.filter((it) => it.group === 'illustration.holiday');
    expect(hol).toHaveLength(82);
    for (const it of hol) {
      expect(it.key).toBe(`illustration.holiday.${it.res - 4}`);
      expect(it.type === 'image' && [it.w, it.h, it.transparency, it.confidence]).toEqual([200, 200, 'opaque', 'exe']);
      expect(it.src.join(' ')).toContain('0x473098');
    }
    // 各图首末 slot → 客户端键偏移 [0,24,43,63][gm] + slot
    const ends: [number, number, number, string][] = [
      [0, 0, 4, 'illustration.holiday.0'],
      [0, 23, 27, 'illustration.holiday.23'],
      [1, 0, 28, 'illustration.holiday.24'],
      [1, 18, 46, 'illustration.holiday.42'],
      [2, 0, 47, 'illustration.holiday.43'],
      [2, 18, 65, 'illustration.holiday.61'],
      [3, 0, 67, 'illustration.holiday.63'],
      [3, 19, 86, 'illustration.holiday.82'],
    ];
    for (const [gm, slot, res, key] of ends) {
      expect(holidayArtKey(gm, slot)).toBe(key);
      expect(byKey.get(key)!.res).toBe(res);
    }
    // Data#66（七夕）没有节日表项：不收，排除并写明原因
    expect(at('Data', 66)).toBeUndefined();
    expect(byKey.has('illustration.holiday.62')).toBe(false);
    expect(cat.exclusions.find((e) => e.mkf === 'Data' && e.from === 66 && e.to === 66)!.reason).toContain('七夕');
  });

  it('开局设置背景 jump#gm：台湾 title.setup.bg（键不变），其他图 title.setup.bg.<id>；exe 证据', () => {
    for (const m of ORIGINAL_MAPS) {
      const it = byKey.get(setupBgKey(m.mapId))!;
      expect([it.mkf, it.res, it.group, it.confidence]).toEqual(['jump', m.gm, 'title', 'exe']);
      expect(it.type === 'image' && [it.w, it.h, it.transparency]).toEqual([640, 480, 'opaque']);
      expect(it.src.join(' ')).toContain('0x406c05');
    }
    expect(['taiwan', 'china', 'japan', 'usa'].map(setupBgKey)).toEqual([
      'title.setup.bg',
      'title.setup.bg.china',
      'title.setup.bg.japan',
      'title.setup.bg.usa',
    ]);
  });

  it('命运插图：exe 0x473dd8 表 49 项，k≥33 按图换（表[k+4gm]），40 张全被引用、升为 exe', () => {
    expect(FATE_ART_TABLE).toHaveLength(49);
    const k33 = (gm: number) => [0, 1, 2, 3].map((j) => FATE_ART_TABLE[33 + 4 * gm + j]);
    expect([0, 1, 2, 3].map(k33)).toEqual([
      [464, 465, 466, 467],
      [464, 468, 469, 470],
      [471, 465, 466, 472],
      [473, 474, 469, 475],
    ]);
    expect(new Set(FATE_ART_TABLE).size).toBe(40);
    for (let res = 436; res <= 475; res++) {
      const it = byKey.get(`illustration.fate.${res - 436}`)!;
      expect([it.res, it.confidence], String(res)).toEqual([res, 'exe']);
    }
    expect(byKey.get('illustration.fate.33')!.desc).toContain('k35@china');
  });

  it('排除表：地图结构数据 map#1/3/5/7、四张图都不引用的精灵 map#69–74/83/86/88/100、help；不再有「其他地图」', () => {
    expect(unreferencedLandmarks()).toEqual([69, 70, 71, 72, 73, 74, 83, 86, 88, 100]);
    const mapEx = cat.exclusions.filter((e) => e.mkf === 'map').map((e) => [e.from, e.to]);
    expect(mapEx).toEqual([
      [1, 1],
      [3, 3],
      [5, 5],
      [7, 7],
      [69, 74],
      [83, 83],
      [86, 86],
      [88, 88],
      [100, 100],
    ]);
    for (const e of cat.exclusions) expect(e.reason).not.toMatch(/其他地图/);
    const cov = catalogCoverage(cat);
    expect(cov.archives.map.excluded).toBe(4 + 10);
    expect(cov.archives.Data.excluded).toBe(1);
    expect(cov.archives.jump.excluded).toBe(0);
  });
});
