// 12 个角色的纸娃娃配置（致敬原作性格原型，造型为自绘，不复刻原作形象；design/client.md §6.2）。
// 键与 shared/data/tables/ids.ts 的 CHARACTER_KEYS 一致（角色 0..11）；名字走 i18n（characters.original/alt）。
// 代表色取自说明书（docs/research/r_minigames_chars.md §2.2），用于地块归属以外的角色点缀。
import type { BodyBuild } from './rig';

export type HairStyle =
  | 'short'
  | 'spiky'
  | 'bald'
  | 'long'
  | 'topknot'
  | 'bob'
  | 'braids'
  | 'pigtails'
  | 'tuft'
  | 'curly';
export type HatStyle =
  | 'none'
  | 'cowboy'
  | 'keffiyeh'
  | 'hood'
  | 'straw'
  | 'tiara'
  | 'headband'
  | 'cap'
  | 'ribbon'
  | 'featherBand';
export type OutfitStyle =
  | 'cowboy'
  | 'robe'
  | 'ninja'
  | 'gown'
  | 'farmer'
  | 'princess'
  | 'hakama'
  | 'sailor'
  | 'tunic'
  | 'dress'
  | 'newsboy'
  | 'onesie';
export type EyeStyle = 'round' | 'narrow' | 'lashes' | 'dot';
export type Accessory =
  | 'bandana'
  | 'mustache'
  | 'beard'
  | 'goldChain'
  | 'shuriken'
  | 'pearls'
  | 'towel'
  | 'rose'
  | 'katana'
  | 'newsBag'
  | 'baseball'
  | 'pacifier'
  | 'lipstick'
  | 'freckles';

export interface CharacterConfig {
  /** i18n 键，与 shared CHARACTER_KEYS 相同 */
  key: string;
  /** 原版角色号 0..11 */
  index: number;
  build: BodyBuild;
  skin: string;
  hair: { style: HairStyle; color: string };
  eyes: EyeStyle;
  hat: { style: HatStyle; color: string; accent: string };
  outfit: { style: OutfitStyle; primary: string; secondary: string; legs: string; shoes: string };
  accessories: readonly Accessory[];
  /** 代表色 */
  color: string;
  /** 咕哝音参数（voiceBabble，M10 使用） */
  babble: { basePitch: number; wave: 'square' | 'triangle' | 'sine'; speed: number };
}

const SKIN = { light: '#FFE0C2', fair: '#FFE8D6', tan: '#F2C79A', brown: '#D9A273' } as const;

export const CHARACTERS: readonly CharacterConfig[] = [
  {
    key: 'johnJoe',
    index: 0,
    build: 'adult',
    skin: SKIN.tan,
    hair: { style: 'short', color: '#8A5A2B' },
    eyes: 'narrow',
    hat: { style: 'cowboy', color: '#B07A3E', accent: '#6B4423' },
    outfit: { style: 'cowboy', primary: '#E86A4A', secondary: '#946126', legs: '#4A76C9', shoes: '#6B4423' },
    accessories: ['bandana'],
    color: '#946126',
    babble: { basePitch: 150, wave: 'square', speed: 1 },
  },
  {
    key: 'shalonbasi',
    index: 1,
    build: 'adult',
    skin: SKIN.brown,
    hair: { style: 'short', color: '#2B2B2B' },
    eyes: 'round',
    hat: { style: 'keffiyeh', color: '#FFFFFF', accent: '#E0B83C' },
    outfit: { style: 'robe', primary: '#FFFFFF', secondary: '#E0B83C', legs: '#FFFFFF', shoes: '#C9A060' },
    accessories: ['mustache', 'beard', 'goldChain'],
    color: '#BDC3C6',
    babble: { basePitch: 120, wave: 'triangle', speed: 0.9 },
  },
  {
    key: 'shintaro',
    index: 2,
    build: 'adult',
    skin: SKIN.light,
    hair: { style: 'short', color: '#2A1E26' },
    eyes: 'narrow',
    hat: { style: 'hood', color: '#41323B', accent: '#C0392B' },
    outfit: { style: 'ninja', primary: '#41323B', secondary: '#C0392B', legs: '#41323B', shoes: '#2A1E26' },
    accessories: ['shuriken'],
    color: '#41323B',
    babble: { basePitch: 170, wave: 'square', speed: 1.3 },
  },
  {
    key: 'madamQian',
    index: 3,
    build: 'adult',
    skin: SKIN.fair,
    hair: { style: 'curly', color: '#4B2A55' },
    eyes: 'lashes',
    hat: { style: 'none', color: '#000000', accent: '#000000' },
    outfit: { style: 'gown', primary: '#C626C3', secondary: '#F7C8F0', legs: '#C626C3', shoes: '#7A1A78' },
    accessories: ['pearls', 'lipstick'],
    color: '#C626C3',
    babble: { basePitch: 260, wave: 'triangle', speed: 1.2 },
  },
  {
    key: 'atubo',
    index: 4,
    build: 'adult',
    skin: SKIN.tan,
    hair: { style: 'bald', color: '#9A9A9A' },
    eyes: 'dot',
    hat: { style: 'straw', color: '#E8C872', accent: '#B8943E' },
    outfit: { style: 'farmer', primary: '#FFFFFF', secondary: '#C5B830', legs: '#3F6FB8', shoes: '#7A5230' },
    accessories: ['mustache', 'towel'],
    color: '#C5B830',
    babble: { basePitch: 110, wave: 'sine', speed: 0.8 },
  },
  {
    key: 'princessSarah',
    index: 5,
    build: 'adult',
    skin: SKIN.fair,
    hair: { style: 'long', color: '#F4C95D' },
    eyes: 'lashes',
    hat: { style: 'tiara', color: '#FFD84D', accent: '#F2545B' },
    outfit: { style: 'princess', primary: '#ED9D9D', secondary: '#FFFFFF', legs: '#ED9D9D', shoes: '#D86C8C' },
    accessories: ['rose'],
    color: '#ED9D9D',
    babble: { basePitch: 280, wave: 'sine', speed: 1.1 },
  },
  {
    key: 'miyamoto',
    index: 6,
    build: 'kid',
    skin: SKIN.light,
    hair: { style: 'topknot', color: '#1F1A17' },
    eyes: 'round',
    hat: { style: 'headband', color: '#FFFFFF', accent: '#E8453C' },
    outfit: { style: 'hakama', primary: '#2FAE55', secondary: '#1F5E8C', legs: '#1F5E8C', shoes: '#F5E6C8' },
    accessories: ['katana'],
    color: '#00F038',
    babble: { basePitch: 210, wave: 'square', speed: 1.2 },
  },
  {
    key: 'tangtang',
    index: 7,
    build: 'kid',
    skin: SKIN.fair,
    hair: { style: 'bob', color: '#8B5A3C' },
    eyes: 'lashes',
    hat: { style: 'ribbon', color: '#FF8FB1', accent: '#E0527D' },
    outfit: { style: 'sailor', primary: '#FFFFFF', secondary: '#2C3E7A', legs: '#2C3E7A', shoes: '#5A3A2A' },
    accessories: [],
    color: '#FFFFA0',
    babble: { basePitch: 300, wave: 'sine', speed: 1.2 },
  },
  {
    key: 'wumi',
    index: 8,
    build: 'kid',
    skin: SKIN.brown,
    hair: { style: 'braids', color: '#241A14' },
    eyes: 'round',
    hat: { style: 'featherBand', color: '#E77C08', accent: '#F2545B' },
    outfit: { style: 'tunic', primary: '#E77C08', secondary: '#8A4B12', legs: '#C98A4B', shoes: '#8A4B12' },
    accessories: [],
    color: '#E77C08',
    babble: { basePitch: 290, wave: 'triangle', speed: 1.3 },
  },
  {
    key: 'sunXiaomei',
    index: 9,
    build: 'kid',
    skin: SKIN.fair,
    hair: { style: 'pigtails', color: '#1F1A17' },
    eyes: 'round',
    hat: { style: 'none', color: '#000000', accent: '#000000' },
    outfit: { style: 'dress', primary: '#CC1A20', secondary: '#FFD84D', legs: '#FFE0C2', shoes: '#E0262B' },
    accessories: ['freckles'],
    color: '#CC1A20',
    babble: { basePitch: 320, wave: 'sine', speed: 1.25 },
  },
  {
    key: 'danny',
    index: 10,
    build: 'kid',
    skin: SKIN.light,
    hair: { style: 'spiky', color: '#A0622D' },
    eyes: 'round',
    hat: { style: 'cap', color: '#2017FE', accent: '#FFFFFF' },
    outfit: { style: 'newsboy', primary: '#5BA3E0', secondary: '#E8D8A8', legs: '#6B5842', shoes: '#FFFFFF' },
    accessories: ['newsBag', 'baseball'],
    color: '#2017FE',
    babble: { basePitch: 240, wave: 'square', speed: 1.3 },
  },
  {
    key: 'jinBeibei',
    index: 11,
    build: 'baby',
    skin: SKIN.fair,
    hair: { style: 'tuft', color: '#E8B04A' },
    eyes: 'round',
    hat: { style: 'none', color: '#000000', accent: '#000000' },
    outfit: { style: 'onesie', primary: '#0EBDBD', secondary: '#FFFFFF', legs: '#0EBDBD', shoes: '#FFFFFF' },
    accessories: ['pacifier'],
    color: '#0EBDBD',
    babble: { basePitch: 360, wave: 'sine', speed: 0.9 },
  },
];

export const CHARACTER_KEYS: readonly string[] = CHARACTERS.map((c) => c.key);

export function characterByKey(key: string): CharacterConfig {
  const c = CHARACTERS.find((x) => x.key === key);
  if (!c) throw new Error(`unknown character ${key}`);
  return c;
}

export function characterByIndex(index: number): CharacterConfig {
  const c = CHARACTERS[index];
  if (!c) throw new Error(`unknown character index ${index}`);
  return c;
}

/** 神明占位造型（M6 完整实现前的画廊占位）；键与 shared GOD_KEYS 一致 */
export interface GodLook {
  key: string;
  big: boolean;
  robe: string;
  aura: string;
  symbol: string;
}

export const GOD_LOOKS: readonly GodLook[] = [
  { key: 'smallWealth', big: false, robe: '#E8453C', aura: '#FFD84D', symbol: '财' },
  { key: 'bigWealth', big: true, robe: '#E8453C', aura: '#FFD84D', symbol: '财' },
  { key: 'smallFortune', big: false, robe: '#F2B705', aura: '#FFF3B0', symbol: '福' },
  { key: 'bigFortune', big: true, robe: '#F2B705', aura: '#FFF3B0', symbol: '福' },
  { key: 'smallPoor', big: false, robe: '#8A8F99', aura: '#C9CCD6', symbol: '穷' },
  { key: 'bigPoor', big: true, robe: '#8A8F99', aura: '#C9CCD6', symbol: '穷' },
  { key: 'smallMisfortune', big: false, robe: '#6B5B8A', aura: '#B8A8D8', symbol: '衰' },
  { key: 'bigMisfortune', big: true, robe: '#6B5B8A', aura: '#B8A8D8', symbol: '衰' },
  { key: 'angel', big: true, robe: '#FFFFFF', aura: '#BFE8FF', symbol: '✦' },
  { key: 'devil', big: true, robe: '#3A2A3A', aura: '#F2545B', symbol: '✖' },
  { key: 'dog', big: false, robe: '#A0643C', aura: '#E8C8A0', symbol: '犬' },
  { key: 'earthGod', big: true, robe: '#8A5A2B', aura: '#FFE28A', symbol: '土' },
  { key: 'death', big: true, robe: '#1F1A24', aura: '#9B6BFF', symbol: '☠' },
];
