import { encodeBig5 } from '../../src/bin/big5';
import { Asm } from './asm';
import { codePe, DataBuilder, dataVaFor, TEXT_VA } from './codePe';

/**
 * 测试专用：带新闻 36 / 命运 49 指针表、魔法屋效果表与条件名表、两张代码节内跳表的合成 exe。
 * 签名只依赖 anchors/tables.json 里的几个关键字（「無罪開釋」「強制拆除」「變賣所有卡片」「財產最多」等），其余文字虚构。
 * 命运 2/3/6/20 调用「加持函数」：分别为 罚金类（处理加倍）、罚金类（不处理加倍）、劫难类、奖金类。
 */

export interface EventExe {
  bytes: Uint8Array;
  va: Record<string, number>;
  news: number[];
  fate: number[];
  effects: number[];
  conds: number[];
}

const big5 = (s: string): number[] => {
  const b = encodeBig5(s);
  if (!b) throw new Error(`无法编码 ${s}`);
  return [...b, 0];
};

export function buildEventExe(): EventExe {
  const TEXT = 0x3000;
  const d = new DataBuilder(dataVaFor(TEXT));
  const va: Record<string, number> = {};
  const str = (key: string, s: string) => {
    va[key] = d.va;
    d.bytes(big5(s));
  };
  for (let k = 0; k < 36; k++) {
    str(
      `N${k}`,
      `#${String(100 + k).padStart(4, '0')}測試新聞${k === 0 ? '無罪開釋' : k === 1 ? '延長刑期%d天' : `第${k}則`}`,
    );
  }
  for (let k = 0; k < 49; k++) {
    str(
      `F${k}`,
      `#${String(200 + k).padStart(4, '0')}測試命運${k === 0 ? '強制拆除' : k === 1 ? '強制徵收' : `第${k}張`}`,
    );
  }
  const catNames = ['類別甲', '類別乙', '類別丙', '類別丁', '類別戊', '類別己'];
  catNames.forEach((c, k) => {
    str(`CAT${k}`, c);
  });
  const effNames = ['變賣所有卡片', '抽取命運三張', ...Array.from({ length: 10 }, (_, k) => `測試效果${k + 2}`)];
  effNames.forEach((c, k) => {
    str(`EN${k}`, c);
  });
  const condNames = [
    '#0046測試財產最多',
    '#0047測試土地最多',
    ...Array.from({ length: 10 }, (_, k) => `#00${50 + k}測試條件${k + 2}`),
  ];
  condNames.forEach((c, k) => {
    str(`CN${k}`, c);
  });
  d.align(4);
  va.PLAYER = d.va;
  d.u32(0, 0, 0, 0);
  // 新闻指针表 + 分类号 + 分类名
  va.NEWS = d.va;
  d.u32(...new Array(36).fill(0));
  d.u8(...[0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 4, 4, ...new Array(14).fill(5)]);
  d.u32(...catNames.map((_, k) => va[`CAT${k}`]!));
  va.FATE = d.va;
  d.u32(...new Array(49).fill(0));
  d.u32(0x12345678);
  va.EFFECTS = d.va;
  effNames.forEach((_, k) => {
    d.u32(7, 100 + k, 200 + k, va[`EN${k}`]!);
  });
  va.CONDS = d.va;
  d.u32(...condNames.map((_, k) => va[`CN${k}`]!));
  d.u32(0);

  const a = new Asm(TEXT_VA);
  a.label('PRINT').ret();
  a.label('FORTUNE').movRegImm('eax', 0).ret();
  for (let k = 0; k < 36; k++) {
    a.label(`news${k}`).pushReg('ebx');
    if (k === 1) a.movRegImm('ecx', 3);
    a.pushImm(va[`N${k}`]!).call('PRINT').addEsp(4).popReg('ebx').ret();
  }
  const fortune: Record<number, [number, number, boolean]> = {
    2: [1, 0, true],
    3: [1, 0, false],
    6: [1, 1, true],
    20: [0, 0, true],
  };
  for (let k = 0; k < 49; k++) {
    a.label(`fate${k}`).pushImm(va[`F${k}`]!).call('PRINT').addEsp(4);
    const f = fortune[k];
    if (f) {
      a.pushImm(f[0]).pushImm(f[1]).call('FORTUNE').addEsp(8).cmpRegImm('eax', 1).jcc(5, `fate${k}_n`).ret();
      a.label(`fate${k}_n`);
      if (f[2]) a.cmpRegImm('eax', 2).jcc(5, `fate${k}_e`);
      a.label(`fate${k}_e`);
    }
    a.ret();
  }
  // 魔法屋效果执行：cmp esi, 0xb; ja END; jmp [esi*4 + JT_E]；各目标读效果名表 +12
  a.label('EFF')
    .cmpRegImm('esi', 0x0b)
    .jcc(7, 'EFF_END')
    .jmpTable('esi', a.va + 7);
  a.label('JT_E');
  for (let k = 0; k < 12; k++) a.u32(0);
  for (let k = 0; k < 12; k++)
    a.label(`eff${k}`)
      .movRegBaseDisp('ebx', 'eax', va.EFFECTS! + 12)
      .call('PRINT')
      .jmp('EFF_END');
  a.label('EFF_END').ret();
  // 条件求名单：目标 7/8 为座驾 and 3 后比较 1/2
  a.label('COND')
    .cmpRegImm('ecx', 0x0b)
    .jcc(7, 'COND_END')
    .jmpTable('ecx', a.va + 7);
  a.label('JT_C');
  for (let k = 0; k < 12; k++) a.u32(0);
  for (let k = 0; k < 12; k++) {
    a.label(`cond${k}`)
      .movAlBaseDisp('eax', va.PLAYER!)
      .andAlImm(3)
      .cmpAlImm(k === 7 ? 1 : k === 8 ? 2 : 0)
      .ret();
  }
  a.label('COND_END').ret();
  a.label('MAIN').call('EFF').call('COND').ret();
  const text = a.finish();
  const dv = new DataView(text.buffer);
  for (let k = 0; k < 12; k++) {
    dv.setUint32(a.addr('JT_E') - TEXT_VA + 4 * k, a.addr(`eff${k}`), true);
    dv.setUint32(a.addr('JT_C') - TEXT_VA + 4 * k, a.addr(`cond${k}`), true);
  }
  const news = Array.from({ length: 36 }, (_, k) => a.addr(`news${k}`));
  const fate = Array.from({ length: 49 }, (_, k) => a.addr(`fate${k}`));
  news.forEach((x, k) => {
    d.patch32(va.NEWS! + 4 * k, x);
  });
  fate.forEach((x, k) => {
    d.patch32(va.FATE! + 4 * k, x);
  });
  for (const l of ['PRINT', 'FORTUNE', 'EFF', 'COND', 'JT_E', 'JT_C']) va[l] = a.addr(l);
  return {
    bytes: codePe(text, d.finish(), TEXT),
    va,
    news,
    fate,
    effects: Array.from({ length: 12 }, (_, k) => a.addr(`eff${k}`)),
    conds: Array.from({ length: 12 }, (_, k) => a.addr(`cond${k}`)),
  };
}
