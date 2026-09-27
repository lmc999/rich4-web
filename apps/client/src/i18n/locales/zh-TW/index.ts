// zh-TW 语言包（由 scripts/gen-zh-tw.ts 从 zh-CN 生成并入库，勿手改 JSON；词汇差异见 ../../zhTw.ts 的覆盖表）。
// 只在原版皮肤启用时由 i18n.setUiLanguage('zh-TW') 懒加载，不进首屏。
import cards from './cards.json';
import charactersAlt from './characters.alt.json';
import charactersOriginal from './characters.original.json';
import events from './events.json';
import fate from './fate.json';
import game from './game.json';
import gods from './gods.json';
import hud from './hud.json';
import items from './items.json';
import lobby from './lobby.json';
import magic from './magic.json';
import minigames from './minigames.json';
import news from './news.json';
import tiles from './tiles.json';
import ui from './ui.json';

export const ZH_TW_CHARACTER_NAMESETS = { original: charactersOriginal, alt: charactersAlt } as const;

export function zhTWResources(nameset: 'original' | 'alt' = 'original') {
  return {
    ui,
    game,
    cards,
    items,
    gods,
    tiles,
    events,
    news,
    fate,
    magic,
    minigames,
    characters: ZH_TW_CHARACTER_NAMESETS[nameset],
    lobby,
    hud,
  };
}
