/**
 * 音乐映射表源数据（Steam 版 Media/Music/track02..26.ogg）。
 *
 * - Steam 版用 DxWnd 虚拟 CD：trackNN.ogg 是虚拟光盘第 NN 轨；Midi.txt 第 k 行（0 起）↔ track k+2。
 * - 棋盘曲（fcn.004533f0）：CD 模式 `play cdtrack from idx+2`；n=0 时按 (cur+1)&7 轮播，一曲播完接下一首。
 * - 场景曲（fcn.00453037）：参数 arg，轨号 = (arg & 0x7fff) + 10；bit15 = 不记录棋盘曲续播点；播完从头循环。
 * - 场景曲打断棋盘曲时续播点压栈（0x47c5fb），离开场景后从断点续播。
 * - tracklen.nfo 的时长不可信（例如 track03 标 141 s，实长 169.18 s），时长以 OGG 实测为准。
 * - loop：场景曲的建议循环区间 = silencedetect（-50 dB，0.2 s）测得的首尾静音边界；build 时裁到这个区间，
 *   浏览器原生 loop 即近乎无缝。源文件时长与表不符（±50 ms 以外）时不裁剪并给出警告。
 * @source exe v2.06 0x4534ef（add eax,2）、0x453037、名字表 0x47c597；DxWnd 0x1008b344（mov ebx,2）
 * @source docs/research/original-assets/audio_video.md §3；.cache/assets-research/audio/audio-manifest.v206.json
 */
import type { Confidence } from './types';

export type MusicRole = 'board' | 'scene' | 'unused';

export interface MusicTrackDef {
  track: number;
  /** Midi.txt 中的名字（去掉 .MID），用于核对行号 */
  midi: string;
  role: MusicRole;
  /** 棋盘曲轮播下标 0..7（仅 board） */
  boardIdx?: number;
  /** 本机 OGG 实测时长（ms），用于核对是否同一发行版 */
  srcDurationMs: number;
  /** 场景曲循环区间（ms，相对源文件）；棋盘曲与未用曲为 null（不裁剪、不循环） */
  loop: { startMs: number; endMs: number } | null;
}

export const MUSIC_TRACKS: readonly MusicTrackDef[] = [
  { track: 2, midi: 'RICH08', role: 'board', boardIdx: 0, srcDurationMs: 143917, loop: null },
  { track: 3, midi: 'RICH16', role: 'board', boardIdx: 1, srcDurationMs: 169181, loop: null },
  { track: 4, midi: 'RICH17', role: 'board', boardIdx: 2, srcDurationMs: 181952, loop: null },
  { track: 5, midi: 'RICH18', role: 'board', boardIdx: 3, srcDurationMs: 180094, loop: null },
  { track: 6, midi: 'RICH19', role: 'board', boardIdx: 4, srcDurationMs: 153437, loop: null },
  { track: 7, midi: 'RICH20', role: 'board', boardIdx: 5, srcDurationMs: 187153, loop: null },
  { track: 8, midi: 'RICH21', role: 'board', boardIdx: 6, srcDurationMs: 130264, loop: null },
  { track: 9, midi: 'RICH22', role: 'board', boardIdx: 7, srcDurationMs: 171781, loop: null },
  { track: 10, midi: 'MIDI01', role: 'scene', srcDurationMs: 48762, loop: { startMs: 484, endMs: 48020 } },
  { track: 11, midi: 'MIDI02', role: 'scene', srcDurationMs: 48205, loop: { startMs: 249, endMs: 48205 } },
  { track: 12, midi: 'MIDI03', role: 'scene', srcDurationMs: 16625, loop: { startMs: 0, endMs: 15438 } },
  { track: 13, midi: 'MIDI04', role: 'unused', srcDurationMs: 39242, loop: null },
  { track: 14, midi: 'MIDI05', role: 'scene', srcDurationMs: 54520, loop: { startMs: 338, endMs: 52300 } },
  { track: 15, midi: 'MIDI06', role: 'scene', srcDurationMs: 79180, loop: { startMs: 502, endMs: 77294 } },
  { track: 16, midi: 'MIDI07', role: 'scene', srcDurationMs: 51270, loop: { startMs: 475, endMs: 49349 } },
  { track: 17, midi: 'MIDI08', role: 'scene', srcDurationMs: 66781, loop: { startMs: 350, endMs: 63610 } },
  { track: 18, midi: 'MIDI09', role: 'scene', srcDurationMs: 21734, loop: { startMs: 417, endMs: 21086 } },
  { track: 19, midi: 'MIDI10', role: 'scene', srcDurationMs: 41378, loop: { startMs: 265, endMs: 39753 } },
  { track: 20, midi: 'MIDI11', role: 'scene', srcDurationMs: 69799, loop: { startMs: 0, endMs: 68440 } },
  { track: 21, midi: 'MIDI12', role: 'scene', srcDurationMs: 45047, loop: { startMs: 296, endMs: 44249 } },
  { track: 22, midi: 'MIDI13', role: 'scene', srcDurationMs: 43375, loop: { startMs: 0, endMs: 42596 } },
  { track: 23, midi: 'MIDI14-1', role: 'scene', srcDurationMs: 40078, loop: { startMs: 297, endMs: 39148 } },
  { track: 24, midi: 'MIDI14-2', role: 'scene', srcDurationMs: 19876, loop: { startMs: 251, endMs: 19601 } },
  { track: 25, midi: 'MIDI15', role: 'scene', srcDurationMs: 21502, loop: { startMs: 251, endMs: 20396 } },
  { track: 26, midi: 'MIDI16', role: 'scene', srcDurationMs: 20712, loop: { startMs: 309, endMs: 19568 } },
];

export const BOARD_TRACK_OFFSET = 2;
export const SCENE_TRACK_OFFSET = 10;
/** 场景曲参数 bit15：进入场景时不记录棋盘曲续播点 */
export const SCENE_NO_RESUME_BIT = 0x8000;

export interface MusicSceneDef {
  key: string;
  desc: string;
  /** exe 传给场景曲函数的参数（含 bit15） */
  arg: number;
  /** v2.06 调用点 */
  callSites: readonly string[];
  confidence: Confidence;
}

export const MUSIC_SCENES: readonly MusicSceneDef[] = [
  { key: 'title', desc: '标题画面', arg: 0x0, callSites: ['0x402a16'], confidence: 'exe' },
  { key: 'setup', desc: '开局设定', arg: 0x8001, callSites: ['0x406e52'], confidence: 'exe' },
  {
    key: 'gameOver',
    desc: '游戏结束结算（其后播 END / OVER 视频）',
    arg: 0x8006,
    callSites: ['0x40746e'],
    confidence: 'exe',
  },
  { key: 'bankrupt', desc: '破产', arg: 0x2, callSites: ['0x40ca4e'], confidence: 'exe' },
  { key: 'bankrupt.alt', desc: '破产的另一分支（与拍卖同曲）', arg: 0x5, callSites: ['0x40cc93'], confidence: 'exe' },
  { key: 'mg.penguin', desc: '小游戏：企鹅挖宝', arg: 0xc, callSites: ['0x414cc0'], confidence: 'exe' },
  { key: 'mg.balloon', desc: '小游戏：七彩气球', arg: 0xb, callSites: ['0x414ebe'], confidence: 'exe' },
  { key: 'mg.fortune', desc: '小游戏：喜从天降', arg: 0xa, callSites: ['0x4150de'], confidence: 'exe' },
  { key: 'shop.item', desc: '道具商店', arg: 0x6, callSites: ['0x42e0ea'], confidence: 'exe' },
  { key: 'lottery.bet', desc: '乐透投注', arg: 0x6, callSites: ['0x430a24'], confidence: 'exe' },
  { key: 'lottery.draw', desc: '乐透开奖', arg: 0x8, callSites: ['0x430b89'], confidence: 'exe' },
  { key: 'magic', desc: '魔法屋', arg: 0x7, callSites: ['0x432c50', '0x432ed8'], confidence: 'exe' },
  { key: 'bank', desc: '银行', arg: 0x4, callSites: ['0x43599e', '0x435c0a'], confidence: 'exe' },
  { key: 'month', desc: '月结颁奖（存款利息 / 月末）', arg: 0x9, callSites: ['0x438e97'], confidence: 'exe' },
  { key: 'auction', desc: '拍卖', arg: 0x5, callSites: ['0x43b437'], confidence: 'exe' },
  { key: 'jail', desc: '监狱（警车押送）', arg: 0xf, callSites: ['0x43c0d1'], confidence: 'exe' },
  { key: 'hospital', desc: '医院（救护车送医）', arg: 0x10, callSites: ['0x43d75e'], confidence: 'exe' },
  {
    key: 'holiday.christmas',
    desc: '节日：圣诞 12/25（节日表 music=13）',
    arg: 0x800d,
    callSites: ['0x450d26'],
    confidence: 'exe',
  },
  {
    key: 'holiday.lunarNewYear',
    desc: '节日：农历正月初一至初三（节日表 music=14）',
    arg: 0x800e,
    callSites: ['0x450d26'],
    confidence: 'exe',
  },
];

export function sceneTrack(arg: number): number {
  return (arg & 0x7fff) + SCENE_TRACK_OFFSET;
}

export function boardTrack(idx: number): number {
  return idx + BOARD_TRACK_OFFSET;
}
