// 原版亮卡（出卡、被动卡生效、没有效果）：照 exe v2.06 亮卡函数 fcn.00440bac 的版式——
// - 宝石消息框 Data#476 图5（ui.common，195×133，锚点 97,81）画在 (220,129)，即 (123,48)–(318,181)（0x440c5c）；
// - 框里的字以 (220,129) 为中心逐行居中（fcn.0044e2e3 对齐模式 4，DT_CENTER；0x440c77），16px 粗体 #F0F0F0，
//   样式 bit0 = #101010 的 (1,1) 阴影（fcn.0044e200(16, 0xf0f0f0, 0x101010, 3, 1)，0x440bda；0x44e45e–0x44e4a8）；
// - 卡片插画 Data#(529+k)（card.<k>，165×256）**不透明**整张贴在 (138,200)–(303,456)（0x440c95：fcn.00454a55 →
//   fcn.0045419a 逐行 rep movsd，没有色键），没有翻面、飞入动画；
// - 卡图下垫黑底（CARD_ART_UNDERLAY）：旧素材包把四角连通的黑色抠成了透明，垫黑后与原版的不透明拷贝相同；
// - 停 1.5 秒（handler 按 shared/view/pacing 的 CARD_SHOW_MS），期间页面上任意鼠标左 / 右键或按键按下再放开（在输入框里
//   打字除外）立即结束，没有最短时间、不画跳过钮（原版 fcn.00450f9a(1500) 遇 WM_LBUTTONUP / WM_RBUTTONUP / WM_KEYUP
//   即返回；PopupScene 的 anyInputSkips）；
// - 亮卡期间棋盘上不叠网页版的气泡、粒子与光束（handlers/cards 经 popupStore.opensClassic 判定），toast 在缺省位置时暂缓显示
//   （手机横屏时 toast 排在棋盘视窗以外，不暂缓；hud/Overlays 的 Toasts），
//   卡片台词在亮卡结束后才说（soundMap 的 timed）。
// 文字：原版是单句「使用%s」（0x463353）/「%s\n\n復仇卡生效！」（0x46337c，嫁禍 0x46338d、免罪 0x4633e9 同式），
// 免費卡确认后同样是「使用免費卡」。联机时别人看不到出卡人的选目标过程，所以一律带上出卡人（与被动卡同一格式），
// 有目标时另起一行小字写目标；卡片说明不上框（原版没有，悬停卡片欄时在日历位置能看到）。
// 坐标以棋盘视窗 REGION.board（0,40 起）为基准换算，与 exe 的屏幕坐标相同。
// data-testid 与程序化 CardCastPopup 同名（card-cast-popup[data-card][data-variant]）；插画带 data-asset-key。
import { CARD, type CardId } from '@rich4/shared/engine';
import type { ReactNode } from 'react';
import { useTx } from '../../../i18n/tx';
import type { CardCastPopupSpec } from '../../popups/popupStore';
import { CLASSIC_FRAMES } from '../common/frames';
import { NineSlice } from '../common/NineSlice';
import { classicText } from '../common/textStyles';
import { MESSAGE_BOX } from '../common/YesNoBox';
import { CARD_ART, CARD_ART_UNDERLAY, cardArtKey, useSceneImage } from '../dialogs/parts';
import { REGION } from '../layout';
import pp from './popups.module.css';

/**
 * 亮卡的画点（exe v2.06 fcn.00440bac，屏幕坐标 = 棋盘视窗 (0,40) + 偏移）：
 * box = 消息框画点（锚点 97,81），text = 文字中心，card = 卡图左上角（锚点 0,0，0x43fe70 图结构模板）。
 * @source docs/research/original-assets/ui.md §2.2（亮卡）
 */
export const CARD_SHOW_LAYOUT = {
  box: { x: REGION.board.x + 220, y: REGION.board.y + 89 },
  text: { x: REGION.board.x + 220, y: REGION.board.y + 89 },
  card: { x: REGION.board.x + 138, y: REGION.board.y + 160 },
} as const;

/** 框里的字：16px 粗体 #F0F0F0，#101010 的 (1,1) 阴影，逐行居中 */
const SHOW_TEXT = classicText({
  size: 16,
  bold: true,
  color: '#f0f0f0',
  outline: null,
  shadow: '#101010',
  align: 'center',
  lineHeight: 18,
});
/** 目标行：小一号 */
const TARGET_TEXT = classicText({ size: 12, color: '#f0f0f0', outline: null, shadow: '#101010', align: 'center' });

/** 框里的句式：出卡、免費卡（原版确认后是「使用免費卡」）→ use；复仇 / 嫁祸 / 免罪 → passive；没有效果 → fizzle */
export function cardShowMode(variant: CardCastPopupSpec['variant'], card: CardId): 'use' | 'passive' | 'fizzle' {
  if (variant === 'fizzle') return 'fizzle';
  if (variant === 'passive' && card !== CARD.FREE) return 'passive';
  return 'use';
}

export function CardCast({ spec }: { spec: CardCastPopupSpec }): ReactNode {
  const t = useTx();
  const key = cardArtKey(spec.card);
  const img = useSceneImage(key);
  const mode = cardShowMode(spec.variant, spec.card);
  const L = CARD_SHOW_LAYOUT;
  const box = L.box;
  return (
    <section
      className={pp.layer}
      style={{ left: 0, top: 0, width: 640, height: 480 }}
      data-testid="card-cast-popup"
      data-card={spec.card}
      data-variant={spec.variant}
      data-mode={mode}
      aria-label={spec.title}
    >
      <NineSlice
        spec={CLASSIC_FRAMES.messageBox}
        x={box.x - MESSAGE_BOX.ax}
        y={box.y - MESSAGE_BOX.ay}
        w={MESSAGE_BOX.w}
        h={MESSAGE_BOX.h}
        testId="card-cast-frame"
      />
      <div
        className={pp.text}
        style={{
          left: box.x - MESSAGE_BOX.ax + MESSAGE_BOX.text.x,
          top: L.text.y,
          width: MESSAGE_BOX.text.w,
          transform: 'translateY(-50%)',
          overflow: 'visible',
          whiteSpace: 'pre-line',
        }}
        data-testid="card-cast-box"
      >
        <p style={SHOW_TEXT} data-testid="card-cast-line">
          {t(`events:popup.cardShow.${mode}`, { who: spec.player.name, card: spec.cardName })}
        </p>
        {spec.targetText && (
          <p style={TARGET_TEXT} data-testid="card-cast-target">
            {t('events:popup.cardShow.target', { target: spec.targetText })}
          </p>
        )}
      </div>
      <span
        className={pp.art}
        style={{
          left: L.card.x,
          top: L.card.y,
          width: CARD_ART.w,
          height: CARD_ART.h,
          backgroundColor: CARD_ART_UNDERLAY,
          backgroundImage: img ? `url("${img.url}")` : undefined,
          filter: spec.variant === 'fizzle' ? 'grayscale(1) brightness(0.8)' : undefined,
        }}
        data-testid="card-cast-art"
        data-asset-key={key}
        data-src={img?.url}
        aria-hidden="true"
      />
    </section>
  );
}
