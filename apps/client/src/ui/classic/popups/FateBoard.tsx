// 原版命运板（original-skin.md §4.2 通用；exe v2.06 fcn.0044c4a0，取证见 docs/research/original-assets/ui.md §2.3）：
// - 板面 Panel#66 图1（ui.newsBoard 第 1 帧，紫色问号板）整张 440×480 贴舞台 (0,0)，盖住工具列与棋盘视窗，资料栏与日历照常可见；
// - 插图 Data#FATE_ART_TABLE[slot]（illustration.fate.<res − 436>，388×251）不透明贴 (25,44)，正好填满板上的白框；
//   slot 是命运处理函数表下标：第 k 条命运 k < 33 为 k，33–36 在大陆 / 日本 / 美国图为 k + 4·gm（插图、标题、语音跟着换）；
// - 文字：原版从 (24,330) 起左上对齐写一两行 28px 粗体 #F0F0F0（#101010 的 (1,1) 阴影、字距 −1）的整句；我们的命运文案分
//   标题与正文（i18n 自拟），标题照原版字体写在 (24,330)，正文与金额另起一块写在标题下方、头像左侧（DEV，见 DEVIATIONS）；
// - 表情头像：抽到命运的人的讲话头像（portrait.speaker.<角色>，map#15+角色）图 FATE_FACE[slot]（1–4），按锚点画在 (390,344)；
//   头像只是点缀，不进「是否用原版画面」的判定（还在加载就先不画）；
// - 原版命运板没有音效，只有语音（soundMap 的 fate.<slot>）；停留时长与任意键跳过由 handler / PopupScene 负责
//   （shared/view/pacing 的 FATE_SHOW：等语音播完、不足 1.6 秒补足；跳过时停掉语音）。
// 加持（FATE 事件 blessing 不为 null）：原版在板子之后重画地图，再出 1.5 秒的通用消息框「<神>保佑……」——这里是
// FateBlessingBox（phase = blessing 的第二个弹窗）。
// data-testid 与程序化 FatePopup 相同（fate-popup[data-fate]、fate-text、fate-amount、fate-blessing），另有 fate-art、fate-title。
import type { ReactNode } from 'react';
import { useTx } from '../../../i18n/tx';
import type { FatePopupSpec } from '../../popups/popupStore';
import { speakerSheet } from '../common/SpeakerBubble';
import { useEnsureSceneSprites } from '../common/sceneAssets';
import { classicText } from '../common/textStyles';
import { useSceneImage } from '../dialogs/parts';
import { Sprite } from '../Sprite';
import { ShowBox } from './CardCast';
import { BOARD_UNDERLAY, FATE_BOARD, FATE_FACE, fateArtKey, NEWS_SHEET } from './layout';
import pp from './popups.module.css';

/** 命运板的字：#F0F0F0、#101010 的 (1,1) 阴影、粗体（fcn.0044e200 样式 3） */
const boardText = (size: number, lineHeight: number) => ({
  ...classicText({ size, bold: true, color: '#f0f0f0', outline: null, shadow: '#101010', lineHeight }),
  // SetTextCharacterExtra(0 − 1)（0x44e3c0）
  letterSpacing: -1,
});

/** 标题：28px（原版整句的字号） */
const TITLE_TEXT = boardText(28, 30);

/**
 * 正文字号：放得下就用 20px，否则 16px（正文区 344×102；按每字一个全角宽保守估计，数字与英文更窄）
 * 金额另占一行。
 */
export function fateBodySize(text: string, hasAmount: boolean): 20 | 16 {
  const B = FATE_BOARD.body;
  const fits = (size: number, lh: number): boolean => {
    const perLine = Math.max(1, Math.floor(B.w / size));
    const lines = Math.ceil([...text].length / perLine) + (hasAmount ? 1 : 0);
    return lines * lh <= B.h;
  };
  return fits(20, 24) ? 20 : 16;
}

/** 命运处理函数表下标（缺省等于命运编号） */
export function fateSlotOf(spec: Pick<FatePopupSpec, 'id' | 'slot'>): number {
  return spec.slot ?? spec.id;
}

export function FateBoard({ spec }: { spec: FatePopupSpec }): ReactNode {
  const t = useTx();
  const slot = fateSlotOf(spec);
  const artKey = fateArtKey(slot);
  const img = useSceneImage(artKey);
  const face = FATE_FACE[slot] ?? 2;
  const sheet = speakerSheet(spec.player.character);
  useEnsureSceneSprites([sheet]);
  const A = FATE_BOARD.art;
  const T = FATE_BOARD.title;
  const B = FATE_BOARD.body;
  const size = fateBodySize(spec.text, spec.amountText !== null);
  const bodyText = boardText(size, size === 20 ? 24 : 20);
  const tone = spec.amountTone ?? (spec.amountText?.startsWith('-') ? 'loss' : 'gain');
  return (
    <section
      className={pp.layer}
      style={{ left: 0, top: 0, width: FATE_BOARD.w, height: FATE_BOARD.h }}
      data-testid="fate-popup"
      data-fate={spec.id}
      data-slot={slot}
      data-tone={spec.tone}
      data-phase="board"
      aria-label={t('events:popup.fate')}
    >
      <span
        className={pp.underlay}
        style={{ left: 0, top: 0, width: FATE_BOARD.w, height: FATE_BOARD.h, background: BOARD_UNDERLAY }}
        aria-hidden="true"
      />
      <Sprite sheet={NEWS_SHEET} frame={FATE_BOARD.frame} x={0} y={0} origin="topLeft" testId="fate-board" />
      {img ? (
        <span
          className={pp.art}
          style={{ left: A.x, top: A.y, width: A.w, height: A.h, backgroundImage: `url("${img.url}")` }}
          data-testid="fate-art"
          data-asset-key={artKey}
          data-src={img.url}
          aria-hidden="true"
        />
      ) : (
        <span
          className={pp.blank}
          style={{ left: A.x, top: A.y, width: A.w, height: A.h }}
          data-testid="fate-art-blank"
          data-asset-key={artKey}
          aria-hidden="true"
        />
      )}
      <h2
        className={pp.text}
        style={{ ...TITLE_TEXT, left: T.x, top: T.y, margin: 0, whiteSpace: 'nowrap', overflow: 'visible' }}
        data-testid="fate-title"
      >
        {spec.title}
      </h2>
      <div className={pp.text} style={{ ...bodyText, left: B.x, top: B.y, width: B.w, height: B.h }}>
        <p data-testid="fate-text" data-size={size}>
          {spec.text}
        </p>
        {spec.amountText && (
          <p
            className={tone === 'loss' ? pp.loss : tone === 'gain' ? pp.gain : undefined}
            data-testid="fate-amount"
            data-tone={spec.amountTone ?? null}
          >
            {spec.amountText}
          </p>
        )}
      </div>
      <Sprite sheet={sheet} frame={face} x={FATE_BOARD.face.x} y={FATE_BOARD.face.y} testId="fate-face" />
    </section>
  );
}

/**
 * 加持消息框（原版命运板之后 fcn.0043f90f(0x489330, 1500)：重画地图后宝石消息框画在 (220,129)，16px 粗体居中，停 1.5 秒）。
 * 文字是我们的加持文案（events:blessing.*）。
 */
export function FateBlessingBox({ spec }: { spec: FatePopupSpec }): ReactNode {
  const t = useTx();
  return (
    <section
      className={pp.layer}
      style={{ left: 0, top: 0, width: 640, height: 480 }}
      data-testid="fate-popup"
      data-fate={spec.id}
      data-slot={fateSlotOf(spec)}
      data-phase="blessing"
      aria-label={t('events:popup.fate')}
    >
      <ShowBox lines={3} testId="fate-blessing-box">
        <p data-testid="fate-blessing">{spec.blessingText}</p>
      </ShowBox>
    </section>
  );
}
