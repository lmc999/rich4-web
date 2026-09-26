/**
 * 13 种道具的数据表（design/engine.md §10.4、§14）。
 *
 * @source exe v3.11 道具表 VA 0x47fee2，13 × 8 字节（mytbk/rich4 asm）
 * @source docs/research/g_arbitration.md §1、docs/research/r_references.md §2.2（1..8 的价格与 Fandom「道具一覽」两个独立来源一致）
 * @verify extract:items[id]（V-E1）
 */
import type { Sourced, Src } from '../source';
import type { Ferocity } from './cards';
import { ITEM_IDS, ITEM_KEYS, type ItemId, isPoolItem, type ResearchProject } from './ids';

export interface ItemDef extends Sourced {
  id: ItemId;
  key: string;
  /** 点券价（商店买价；卖回价 = trunc(价 × 数量 × 0.9)） */
  price: number;
  /** 全局共享库存初值：1..8 各 10，9..13 为 0（研究所产出，不受库存限制） */
  poolInit: number;
  /** 百货公司有售（只有 1..8） */
  shopSellable: boolean;
  /** 研究所研发项目（9..13 对应 1..5），其余为 null */
  research: ResearchProject | null;
  /** 电脑的凶狠度（exe 道具表 +7）：个性闸门 d = f7 − personality（design/minigames-ai.md §8.2、§9.6） */
  f7: Ferocity;
}

const ITEM_TABLE_VA = 0x47fee2;
const ITEM_ROW_BYTES = 8;

/** 下标 = 道具号 − 1 */
const PRICES: readonly number[] = [15, 30, 25, 25, 80, 150, 100, 30, 30, 40, 95, 150, 250];
/** 下标 = 道具号 − 1（@verify extract:tools[id].f7） */
const F7: readonly Ferocity[] = [0, 1, 1, 1, 0, 0, 2, 0, 1, 2, 1, 2, 2];

function itemSrc(id: ItemId): Src[] {
  return [
    { exe: '3.11', va: `0x${(ITEM_TABLE_VA + (id - 1) * ITEM_ROW_BYTES).toString(16)}` },
    { research: 'docs/research/r_references.md §2.2' },
    { verify: `extract:items[${id}]` },
  ];
}

export const ITEMS: readonly ItemDef[] = Object.freeze(
  ITEM_IDS.map((id): ItemDef => {
    const pooled = isPoolItem(id);
    return Object.freeze({
      id,
      key: ITEM_KEYS[id],
      price: PRICES[id - 1]!,
      poolInit: pooled ? 10 : 0,
      shopSellable: pooled,
      research: pooled ? null : ((id - 8) as ResearchProject),
      f7: F7[id - 1]!,
      src: itemSrc(id),
      confidence: pooled ? 'high' : 'medium',
    });
  }),
);

export function itemDef(id: ItemId): ItemDef {
  return ITEMS[id - 1]!;
}

/** 下标 = 道具号（0 不用），开局共享库存（发放开局道具之前） */
export function initialItemPool(): number[] {
  const out = [0];
  for (const it of ITEMS) out.push(it.poolInit);
  return out;
}
