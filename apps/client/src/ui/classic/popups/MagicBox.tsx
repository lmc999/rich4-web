// 原版皮肤的魔法屋演出（点名 MAGIC_CONDITION、施法 MAGIC_CAST）：原版魔法屋的每个效果都用「%s\n\n…」加通用消息框
// fcn.0043f90f（Data#476 图5 画在 (220,129)，16px 粗体居中）报结果（exe 魔法屋效果执行函数 fcn.00431093），没有女巫立绘的
// 结果卡。这里用同一个宝石消息框（CardCast 的 ShowBox）写标题、说明与被点到的人，代替程序化 MagicPopup 的自绘女巫卡片。
// 点名在原版里怎么显示没有逐字取证，沿用同一个框（DEVIATIONS 的「随机事件的原版画面」一节）。
// data-testid 与程序化 MagicPopup 相同（magic-popup）。
import type { ReactNode } from 'react';
import type { MagicPopupSpec } from '../../popups/popupStore';
import { classicText } from '../common/textStyles';
import { ShowBox } from './CardCast';
import pp from './popups.module.css';

const TITLE = classicText({ size: 16, bold: true, color: '#f0f0f0', outline: null, shadow: '#101010', lineHeight: 18 });
const SMALL = classicText({ size: 12, color: '#f0f0f0', outline: null, shadow: '#101010', lineHeight: 15 });

/** 文字在框里大约占几行（按 16px 行计：标题每行 10 字、小字每行 13 字，空一行） */
export function magicBoxLines(spec: Pick<MagicPopupSpec, 'title' | 'line'>, targets: string): number {
  const n = (s: string, per: number) => (s ? Math.ceil([...s].length / per) : 0);
  const small = n(spec.line, 13) + n(targets, 13);
  return n(spec.title, 10) + 1 + Math.ceil((small * 15) / 18);
}

export function MagicBox({ spec }: { spec: MagicPopupSpec }): ReactNode {
  const targets = spec.targets.length === 0 ? '' : spec.targets.map((p) => p.name).join('、');
  return (
    <section
      className={pp.layer}
      style={{ left: 0, top: 0, width: 640, height: 480 }}
      data-testid="magic-popup"
      data-targets={spec.targets.map((p) => p.seat).join(',')}
      aria-label={spec.title}
    >
      <ShowBox lines={magicBoxLines(spec, targets)} testId="magic-box">
        <p style={TITLE} data-testid="magic-title">
          {spec.title}
        </p>
        <p style={{ ...SMALL, marginTop: 8 }} data-testid="magic-line">
          {spec.line}
        </p>
        {/* 没有人符合时点名的说明已经写明（magic:conditionNobody），不再重复 */}
        {targets && (
          <p style={SMALL} data-testid="magic-targets">
            {targets}
          </p>
        )}
      </ShowBox>
    </section>
  );
}
