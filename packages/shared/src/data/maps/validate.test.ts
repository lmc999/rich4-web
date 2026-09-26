import { describe, expect, it } from 'vitest';
import { buildTestMap, buildTestMapAllKinds } from './fixtures/testMap';
import type { AnyLot, FacilityLot, LandLot, LotId, MapDef, TileDef, TileId, TileLink } from './types';
import { MAP_ISSUE_CODES, type MapIssueCode, type ValidateMapOptions, validateMap } from './validate';

const tile = (d: MapDef, id: TileId): TileDef => d.tiles.find((t) => t.id === id)!;
const lot = (d: MapDef, id: LotId): AnyLot => [...d.lots, ...d.companies].find((l) => l.id === id)!;
const land = (d: MapDef, id: LotId) => lot(d, id) as LandLot;
const link = (d: MapDef, from: TileId, to: TileId): TileLink => tile(d, from).links.find((l) => l.to === to)!;
const unlink = (d: MapDef, a: TileId, b: TileId) => {
  tile(d, a).links = tile(d, a).links.filter((l) => l.to !== b);
  tile(d, b).links = tile(d, b).links.filter((l) => l.to !== a);
};
const addLink = (d: MapDef, from: TileId, l: TileLink) => {
  const t = tile(d, from);
  t.links = [...t.links, l].sort((x, y) => x.slot - y.slot);
};
const codes = (d: MapDef, o?: ValidateMapOptions) => validateMap(d, o).issues.map((i) => i.code);

describe('validateMap：fixture 基线', () => {
  it('test 通过（含 strict4），只有 04→19 单向封路的提示', () => {
    for (const strict4 of [false, true]) {
      const r = validateMap(buildTestMap(), { strict4, expect: { nodes: 20, lands: 5, facilities: 1, companies: 2 } });
      expect(r.ok).toBe(true);
      expect(r.issues.filter((i) => i.severity === 'error')).toEqual([]);
      expect(r.issues.map((i) => i.code)).toEqual(['W_LINK_ONEWAY']);
      expect(r.issues[0]!.tiles).toEqual([4, 19]);
    }
  });

  it('test-allkinds 通过（含 strict4），另有死路 26 的提示', () => {
    for (const strict4 of [false, true]) {
      const r = validateMap(buildTestMapAllKinds(), { strict4, expect: { nodes: 26, companies: 3, landscapes: 2 } });
      expect(r.ok).toBe(true);
      expect(r.issues.filter((i) => i.severity === 'error')).toEqual([]);
      expect(r.issues.map((i) => i.code).sort()).toEqual(['W_DEADEND', 'W_LINK_ONEWAY']);
      expect(r.issues.find((i) => i.code === 'W_DEADEND')!.tiles).toEqual([26]);
    }
  });

  it('解除 04→19 封路后不再有 W_LINK_ONEWAY', () => {
    const d = buildTestMap();
    link(d, 4, 19).blocked = false;
    expect(validateMap(d).issues).toEqual([]);
  });
});

interface Mutation {
  name: string;
  expect: MapIssueCode;
  allkinds?: boolean;
  opts?: ValidateMapOptions;
  /** 只产生警告时 ok 应仍为 true */
  warnOnly?: boolean;
  /** 需要同时匹配的消息（基线里已有同 code 时用来区分） */
  msg?: RegExp;
  mutate(d: MapDef): void;
}

const MUTATIONS: Mutation[] = [
  {
    name: '重复格 id',
    expect: 'E_ID_DUP',
    mutate: (d) => {
      tile(d, 2).id = 1;
    },
  },
  {
    name: '重复地块 id',
    expect: 'E_ID_DUP',
    mutate: (d) => {
      lot(d, 'L2').id = 'L1';
    },
  },
  {
    name: '重复地标 id',
    expect: 'E_ID_DUP',
    mutate: (d) => {
      d.landmarks[1]!.id = d.landmarks[0]!.id;
    },
  },
  {
    name: 'links 目标不存在',
    expect: 'E_LINK_TARGET',
    mutate: (d) => {
      link(d, 2, 3).to = 99;
    },
  },
  {
    name: 'links 指向自己',
    expect: 'E_LINK_TARGET',
    mutate: (d) => {
      link(d, 2, 3).to = 2;
    },
  },
  {
    name: 'links 不对称',
    expect: 'E_LINK_ASYM',
    mutate: (d) => {
      tile(d, 3).links = tile(d, 3).links.filter((l) => l.to !== 2);
    },
  },
  {
    name: '同格重复槽号',
    expect: 'E_SLOT_DUP',
    mutate: (d) => {
      link(d, 13, 12).slot = 0;
    },
  },
  {
    name: 'links 未按槽号排序',
    expect: 'E_SLOT_DUP',
    mutate: (d) => {
      tile(d, 13).links.reverse();
    },
  },
  {
    name: 'flags 在空槽上置封路位（blocked 非边）',
    expect: 'E_BLOCKED_NOT_LINK',
    mutate: (d) => {
      tile(d, 2).src = { flags: (0x40000000 >>> 0) | 2 };
    },
  },
  {
    name: 'flags 封路位与 link.blocked 不一致',
    expect: 'E_BLOCKED_NOT_LINK',
    mutate: (d) => {
      tile(d, 4).src = { flags: 13 };
    },
  },
  {
    name: '两格同一 cell',
    expect: 'E_CELL_COLLIDE',
    mutate: (d) => {
      tile(d, 20).cell = { ...tile(d, 19).cell };
    },
  },
  {
    name: '连接格压在游戏格上',
    expect: 'E_CELL_COLLIDE',
    allkinds: true,
    mutate: (d) => {
      d.roadCells.push({ ...tile(d, 22).cell });
    },
  },
  {
    name: '矩形宽为 0',
    expect: 'E_RECT_INVALID',
    mutate: (d) => {
      lot(d, 'L1').rect.w = 0;
    },
  },
  {
    name: '企业矩形越界',
    expect: 'E_OUT_OF_BOUNDS',
    mutate: (d) => {
      lot(d, 'C2').rect = { x: 11, y: 5, w: 2, h: 2 };
    },
  },
  {
    name: '装饰越界',
    expect: 'E_OUT_OF_BOUNDS',
    mutate: (d) => {
      d.decorations[0]!.cell = { x: -1, y: 0 };
    },
  },
  {
    name: '地块重叠',
    expect: 'E_OVERLAP',
    mutate: (d) => {
      lot(d, 'L4').rect = { ...lot(d, 'L5').rect };
    },
  },
  {
    name: '地块压在道路格上',
    expect: 'E_OVERLAP',
    mutate: (d) => {
      lot(d, 'F1').rect = { x: 2, y: 3, w: 2, h: 2 };
    },
  },
  {
    name: '地块前沿格不相邻',
    expect: 'E_LOT_FRONT_NOT_ADJ',
    mutate: (d) => {
      lot(d, 'L1').rect = { x: 10, y: 1, w: 1, h: 1 };
    },
  },
  {
    name: '关押地标与关押格不相邻',
    expect: 'E_LOT_FRONT_NOT_ADJ',
    mutate: (d) => {
      d.landmarks.find((m) => m.kind === 'jail')!.rect = { x: 9, y: 7, w: 2, h: 1 };
    },
  },
  {
    name: '地块无前沿格',
    expect: 'E_LOT_NO_FRONT',
    mutate: (d) => {
      lot(d, 'L1').frontTiles = [];
      delete tile(d, 5).ref;
      tile(d, 5).kind = 'plain';
    },
  },
  {
    name: 'tile.ref 指向别的地块',
    expect: 'E_TILE_REF_MISMATCH',
    mutate: (d) => {
      tile(d, 6).ref = { lot: 'L3' };
    },
  },
  {
    name: 'kind 与落点码不符',
    expect: 'E_TILE_REF_MISMATCH',
    mutate: (d) => {
      tile(d, 2).kind = 'fate';
    },
  },
  {
    name: '企业引用不存在的股票',
    expect: 'E_TILE_REF_MISMATCH',
    mutate: (d) => {
      (lot(d, 'C2') as { stockIndex: number }).stockIndex = 99;
    },
  },
  {
    name: 'holdFor 格没有对应地标',
    expect: 'E_TILE_REF_MISMATCH',
    mutate: (d) => {
      tile(d, 16).holdFor = 'jail';
    },
  },
  {
    name: '同街地名不一致',
    expect: 'E_STREET_NAME',
    mutate: (d) => {
      d.strings['zh-TW'][lot(d, 'L2').nameKey] = '別的街';
    },
  },
  {
    name: '街道成员不一致',
    expect: 'E_STREET_NAME',
    mutate: (d) => {
      land(d, 'L4').streetId = 'S01';
    },
  },
  {
    name: 'rent 只有 5 项',
    expect: 'E_RENT_SHAPE',
    mutate: (d) => {
      land(d, 'L1').rent = [400, 1000, 2500, 6000, 12000] as unknown as LandLot['rent'];
    },
  },
  {
    name: 'rateWindow[0] 不等于 housePrice',
    expect: 'E_RENT_SHAPE',
    mutate: (d) => {
      (lot(d, 'F1') as FacilityLot).rateWindow[0] = 700;
    },
  },
  {
    name: '地价为负',
    expect: 'E_PRICE_RANGE',
    mutate: (d) => {
      land(d, 'L1').landPrice = -1;
    },
  },
  {
    name: '捷径孤岛不可达',
    expect: 'E_UNREACHABLE',
    mutate: (d) => {
      unlink(d, 4, 19);
      unlink(d, 20, 13);
    },
  },
  {
    name: '缺监狱关押格',
    expect: 'E_HOLD_MISSING',
    mutate: (d) => {
      delete tile(d, 14).holdFor;
      delete d.landmarks.find((m) => m.kind === 'jail')!.holdTile;
    },
  },
  {
    name: '缺医院落点格（码 5）',
    expect: 'E_HOLD_MISSING',
    mutate: (d) => {
      tile(d, 15).landingCode = 1;
      tile(d, 15).kind = 'park';
    },
  },
  {
    name: 'terrain 行宽不符',
    expect: 'E_TERRAIN_SHAPE',
    mutate: (d) => {
      d.terrain[0] = d.terrain[0]!.slice(1);
    },
  },
  {
    name: 'terrain 行数不符',
    expect: 'E_TERRAIN_SHAPE',
    mutate: (d) => {
      d.terrain.pop();
    },
  },
  {
    name: 'terrain 非法字符',
    expect: 'E_TERRAIN_SHAPE',
    mutate: (d) => {
      d.terrain[8] = 'x'.repeat(12);
    },
  },
  {
    name: 'meta.counts 不符',
    expect: 'E_COUNT_MISMATCH',
    mutate: (d) => {
      d.meta.counts.lands = 4;
    },
  },
  { name: 'expect 计数不符', expect: 'E_COUNT_MISMATCH', opts: { expect: { nodes: 103 } }, mutate: () => {} },
  {
    name: 'via 断开',
    expect: 'E_VIA_BROKEN',
    allkinds: true,
    mutate: (d) => {
      link(d, 22, 23).via = [{ x: 11, y: 3 }];
      link(d, 23, 22).via = [{ x: 11, y: 3 }];
    },
  },
  {
    name: '反向 via 未镜像',
    expect: 'E_VIA_BROKEN',
    allkinds: true,
    mutate: (d) => {
      link(d, 23, 22).via!.reverse();
    },
  },
  {
    name: '长边缺 via',
    expect: 'E_VIA_BROKEN',
    allkinds: true,
    mutate: (d) => {
      delete link(d, 22, 23).via;
      delete link(d, 23, 22).via;
    },
  },
  {
    name: '对角边（非 strict4 只警告）',
    expect: 'W_DIAGONAL_LINK',
    warnOnly: true,
    mutate: (d) => {
      addLink(d, 20, { to: 12, slot: 1, blocked: false });
      addLink(d, 12, { to: 20, slot: 0, blocked: false });
    },
  },
  {
    name: 'strict4 下对角边为错误',
    expect: 'W_DIAGONAL_LINK',
    opts: { strict4: true },
    mutate: (d) => {
      addLink(d, 20, { to: 12, slot: 1, blocked: false });
      addLink(d, 12, { to: 20, slot: 0, blocked: false });
    },
  },
  {
    name: 'via 过长',
    expect: 'W_VIA_LONG',
    allkinds: true,
    warnOnly: true,
    mutate: (d) => {
      // 把 23..26 与 C3 右移 2 格，via 变成 4 个连接格
      const shift = 2;
      d.grid.w += shift;
      d.terrain = d.terrain.map((r) => r + 'g'.repeat(shift));
      for (const id of [23, 24, 25, 26]) {
        const t = tile(d, id);
        t.cell = { x: t.cell.x + shift, y: t.cell.y };
        t.world = { x: t.world.x + 32 * shift, y: t.world.y };
      }
      const c3 = lot(d, 'C3');
      c3.rect = { ...c3.rect, x: c3.rect.x + shift };
      c3.world = { x: c3.world.x + 32 * shift, y: c3.world.y };
      const via = [11, 12, 13, 14].map((x) => ({ x, y: 3 }));
      d.roadCells = via.map((c) => ({ ...c }));
      link(d, 22, 23).via = via.map((c) => ({ ...c }));
      link(d, 23, 22).via = via.map((c) => ({ ...c })).reverse();
    },
  },
  {
    name: 'rent 不单调',
    expect: 'W_RENT_NONMONO',
    warnOnly: true,
    mutate: (d) => {
      land(d, 'L1').rent = [400, 1000, 900, 6000, 12000, 24000];
    },
  },
  { name: '出现死路', expect: 'W_DEADEND', warnOnly: true, mutate: (d) => unlink(d, 16, 17) },
  {
    name: '名称为空',
    expect: 'W_NAME_EMPTY',
    warnOnly: true,
    mutate: (d) => {
      d.strings['zh-CN'][lot(d, 'F1').nameKey] = '';
    },
  },
  {
    name: '双向封路',
    expect: 'W_LINK_ONEWAY',
    warnOnly: true,
    msg: /both ways/,
    mutate: (d) => {
      link(d, 19, 4).blocked = true;
    },
  },
  {
    name: '企业的远端百货格（另有相邻前沿格）',
    expect: 'W_COMPANY_REMOTE_FRONT',
    warnOnly: true,
    mutate: (d) => attachRemoteFront(d, 'C2', 8, 15),
  },
];

/** 把格 tileId 改成落点码 code 并挂为 lotId 的额外前沿格（格 8 与 C2、L1 的建筑都不相邻） */
function attachRemoteFront(d: MapDef, lotId: LotId, tileId: TileId, code: number): void {
  const t = tile(d, tileId);
  t.landingCode = code;
  t.kind = code === 14 ? 'bank' : code === 15 ? 'shop' : code === 16 ? 'magic' : t.kind;
  t.ref = { lot: lotId };
  lot(d, lotId).frontTiles.push(tileId);
}

describe('validateMap：企业远端前沿格（architecture §16.2）', () => {
  it('远端银行格只报 W_COMPANY_REMOTE_FRONT，并带格号', () => {
    const d = buildTestMap();
    attachRemoteFront(d, 'C2', 8, 14);
    const r = validateMap(d);
    expect(r.ok).toBe(true);
    const w = r.issues.filter((i) => i.code === 'W_COMPANY_REMOTE_FRONT');
    expect(w).toHaveLength(1);
    expect(w[0]!.severity).toBe('warn');
    expect(w[0]!.tiles).toEqual([8]);
    expect(w[0]!.path).toBe('companies[1].frontTiles[1]');
    expect(r.issues.some((i) => i.code === 'E_LOT_FRONT_NOT_ADJ')).toBe(false);
  });

  it('落点码不是 14/15 的远端前沿格仍是 E_LOT_FRONT_NOT_ADJ', () => {
    const d = buildTestMap();
    attachRemoteFront(d, 'C2', 8, 16);
    const r = validateMap(d);
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.code)).toContain('E_LOT_FRONT_NOT_ADJ');
    expect(r.issues.map((i) => i.code)).not.toContain('W_COMPANY_REMOTE_FRONT');
  });

  it('企业没有任何相邻前沿格时，百货格不相邻也是错误', () => {
    const d = buildTestMap();
    attachRemoteFront(d, 'C2', 8, 15);
    lot(d, 'C2').rect = { x: 10, y: 7, w: 1, h: 1 };
    const r = validateMap(d);
    expect(r.ok).toBe(false);
    const errs = r.issues.filter((i) => i.code === 'E_LOT_FRONT_NOT_ADJ');
    expect(errs.map((i) => i.tiles)).toEqual([[10], [8]]);
    expect(r.issues.map((i) => i.code)).not.toContain('W_COMPANY_REMOTE_FRONT');
  });

  it('住宅地不适用：另有相邻前沿格时远端格仍是错误', () => {
    const d = buildTestMap();
    attachRemoteFront(d, 'L1', 8, 15);
    const r = validateMap(d);
    expect(r.ok).toBe(false);
    expect(r.issues.find((i) => i.code === 'E_LOT_FRONT_NOT_ADJ')?.tiles).toEqual([8]);
  });
});

describe('validateMap：变异命中预期 issue code', () => {
  it(`共 ${MUTATIONS.length} 种变异，覆盖全部 ${MAP_ISSUE_CODES.length} 个 code`, () => {
    expect(MUTATIONS.length).toBeGreaterThanOrEqual(25);
    expect(new Set(MUTATIONS.map((m) => m.expect))).toEqual(new Set(MAP_ISSUE_CODES));
  });

  for (const m of MUTATIONS) {
    it(`${m.name} → ${m.expect}`, () => {
      const d = m.allkinds ? buildTestMapAllKinds() : buildTestMap();
      m.mutate(d);
      const r = validateMap(d, m.opts);
      expect(r.issues.map((i) => i.code)).toContain(m.expect);
      if (m.msg) expect(r.issues.some((i) => i.code === m.expect && m.msg!.test(i.msg))).toBe(true);
      if (m.warnOnly) {
        expect(r.issues.filter((i) => i.severity === 'error')).toEqual([]);
        expect(r.ok).toBe(true);
      } else {
        expect(r.ok).toBe(false);
        expect(r.issues.some((i) => i.code === m.expect && i.severity === 'error')).toBe(true);
      }
    });
  }

  it('变异不影响其他新生成的 fixture（生成器每次返回新对象）', () => {
    const a = buildTestMap();
    tile(a, 2).kind = 'fate';
    expect(codes(buildTestMap())).toEqual(['W_LINK_ONEWAY']);
  });

  it('issue 带 path 与涉及的格', () => {
    const d = buildTestMap();
    link(d, 2, 3).to = 99;
    const issue = validateMap(d).issues.find((i) => i.code === 'E_LINK_TARGET')!;
    expect(issue.path).toBe('tiles[1].links[0]');
    expect(issue.tiles).toEqual([2, 99]);
    expect(issue.severity).toBe('error');
  });
});
