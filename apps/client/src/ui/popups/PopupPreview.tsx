// 开发画廊用的弹窗预览：按钮逐个打开演出弹窗（示例内容），配合 PopupLayer 查看版式与动画。
import type { ReactNode } from 'react';
import { PopupLayer } from './PopupLayer';
import { type PlayerRef, type PopupSpec, usePopupStore } from './popupStore';

const P0: PlayerRef = { seat: 0, character: 9, name: '孙小美' };
const P1: PlayerRef = { seat: 1, character: 4, name: '阿土伯' };
const P2: PlayerRef = { seat: 2, character: 3, name: '钱夫人' };

export const POPUP_SAMPLES: readonly { label: string; spec: PopupSpec; ms: number }[] = [
  {
    label: '新闻',
    ms: 3400,
    spec: {
      kind: 'news',
      id: 8,
      category: 1,
      categoryLabel: '政府公告',
      headline: '地产大亨受表扬',
      body: '孙小美 名下地产最多，获颁奖金 10,000 元。',
      affected: [{ ...P0, deltas: [{ field: 'cash', delta: 10000 }] }],
    },
  },
  {
    label: '命运',
    ms: 2250,
    spec: {
      kind: 'fate',
      player: P1,
      id: 25,
      title: '继承遗产',
      text: '远房亲戚留给 阿土伯 一笔遗产：10,000 元。',
      amountText: '+10,000',
      tone: 'good',
      blessingText: '财运亨通，奖金加倍！',
    },
  },
  {
    label: '出卡',
    ms: 1200,
    spec: {
      kind: 'cardCast',
      player: P0,
      card: 17,
      cardName: '陷害卡',
      desc: '让对手立刻入狱 5 天。',
      title: '孙小美 使用卡片',
      targetText: '阿土伯',
      variant: 'cast',
    },
  },
  {
    label: '神明发威',
    ms: 2750,
    spec: {
      kind: 'god',
      god: 6,
      godName: '大穷神',
      player: P2,
      title: '大穷神 发威',
      line: '大穷神发威，家财散去！',
      good: false,
      slot: { digits: 4, value: 3721 },
      amountText: '-3,721',
    },
  },
  {
    label: '乐透',
    ms: 2800,
    spec: { kind: 'lottery', title: '乐透开奖', number: 12, winner: P1, subtitle: '开出 12 号：阿土伯 独得 36,000 元' },
  },
  {
    label: '魔法屋',
    ms: 1500,
    spec: {
      kind: 'magic',
      caster: P0,
      title: '魔法屋',
      line: '女巫挥动魔杖：现金最多的人，过来吧！',
      targets: [P1, P2],
    },
  },
  {
    label: '终局',
    ms: 2800,
    spec: {
      kind: 'gameOver',
      title: '游戏结束',
      subtitle: '孙小美 获胜',
      winner: P0,
      rows: [
        {
          ...P0,
          rank: 1,
          netWorth: 520000,
          alive: true,
          parts: { cash: 120000, deposit: 200000, stocks: 50000, estate: 150000, loan: 0 },
        },
        {
          ...P2,
          rank: 2,
          netWorth: 240000,
          alive: true,
          parts: { cash: 40000, deposit: 60000, stocks: 90000, estate: 80000, loan: 30000 },
        },
        { ...P1, rank: 3, netWorth: 0, alive: false, parts: { cash: 0, deposit: 0, stocks: 0, estate: 0, loan: 0 } },
      ],
    },
  },
];

export function PopupPreview(): ReactNode {
  const open = (i: number): void => {
    const s = POPUP_SAMPLES[i]!;
    const st = usePopupStore.getState();
    const cur = st.current;
    if (cur) st.close(cur.popupId);
    const id = st.open(s.spec, s.ms, 600);
    // 预览里按真实时间自动关闭（对局中由 handler 按动画时钟关闭）
    setTimeout(() => usePopupStore.getState().close(id), Math.max(4000, s.ms * 2));
  };
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }} data-testid="popup-preview">
      {POPUP_SAMPLES.map((s, i) => (
        <button key={s.label} type="button" className="btn btn--sm btn--cream" onClick={() => open(i)}>
          {s.label}
        </button>
      ))}
      <PopupLayer />
    </div>
  );
}
