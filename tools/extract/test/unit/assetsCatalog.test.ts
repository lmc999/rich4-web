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
  flicPlacementKey,
  ROAD_OBJECTS,
  TAIWAN_COMPANY_SPRITES,
  TAIWAN_SCENERY_SPRITES,
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

  it('路面物件 Data#354+t（t 与 GodKind 相同），路障/地雷/炸弹 370–372，ZZZ 373', () => {
    for (const o of ROAD_OBJECTS) expect(byKey.get(`object.${o.name}`)!.res).toBe(354 + o.t);
    expect(['object.roadblock', 'object.mine', 'object.bomb', 'object.zzz'].map((k) => byKey.get(k)!.res)).toEqual([
      370, 371, 372, 373,
    ]);
  });

  it('map.mkf：住宅 27+L−1（台湾）、连锁店 47、设施 48+(kind−1)·5+L、企业/景观 spriteRes+26', () => {
    for (let L = 1; L <= 5; L++) expect(byKey.get(`map.taiwan.house.${L}`)!.res).toBe(26 + L);
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

  it('主人色掩膜只标在 map.mkf 的住宅、连锁店、设施与企业上（景观不改色）', () => {
    const owners = cat.items.filter((it) => it.type === 'sprite' && it.ownerMask);
    for (const it of owners) expect(it.mkf).toBe('map');
    expect(owners.map((it) => it.res).sort((a, b) => a - b)).toEqual(
      [...[27, 28, 29, 30, 31], ...Array.from({ length: 22 }, (_, i) => 47 + i), ...TAIWAN_COMPANY_SPRITES].sort(
        (a, b) => a - b,
      ),
    );
  });

  it('lotHighlight 标 guess；装饰锚点在图心；卡片 Data#529+k 带圆角透明', () => {
    expect(byKey.get('board.lotHighlight')!.confidence).toBe('guess');
    const decor = byKey.get('board.decor')!;
    expect(decor.type === 'sprite' && decor.anchor).toBe('center');
    for (let k = 1; k <= 30; k++) {
      const it = byKey.get(`card.${k}`)!;
      expect(it.res).toBe(529 + k);
      expect(it.type === 'image' && it.transparency).toBe('corner-rgb0');
    }
    expect(byKey.get('illustration.fate.0')!.confidence).toBe('guess');
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
