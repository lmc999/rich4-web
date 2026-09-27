/**
 * 视频映射表源数据（Steam 版 Media/*.avi，全部为 Indeo 5；可选输出为 H.264 MP4）。
 *
 * - v2.06 exe 只引用 START、END、OVER、FLYTW / FLYCHINA / FLYJP / FLYUS（set 'v206'）。
 * - v3.11 另外引用 END%02d、THANKS、AIRPLANE（set 'all' 时一并输出）。
 * - srcDurationMs 为本机 ffprobe 实测，build 时对照源文件（不符只警告）。
 * @source docs/research/original-assets/audio_video.md §4.1
 */
import type { Confidence } from './types';

export type VideoSet = 'v206' | 'all';

export interface VideoDef {
  key: string;
  /** Media 目录下的文件名（查找时大小写不敏感） */
  file: string;
  use: string;
  desc: string;
  /** v2.06 是否引用 */
  v206: boolean;
  w: number;
  h: number;
  srcDurationMs: number;
  confidence: Confidence;
}

const endings: VideoDef[] = [];
const END_DUR = [32800, 62000, 47700, 38700, 49500, 51600, 43100, 50100, 49000, 39000, 42400, 61400];
for (let c = 0; c < 12; c++) {
  const n = String(c + 1).padStart(2, '0');
  endings.push({
    key: `end${n}`,
    file: `END${n}.AVI`,
    use: 'ending.char',
    desc: `角色 ${c} 的结局动画（END%02d = 角色号 + 1，凭画面推断）`,
    v206: false,
    w: 640,
    h: 480,
    srcDurationMs: END_DUR[c]!,
    confidence: 'guess',
  });
}

export const VIDEOS: readonly VideoDef[] = [
  {
    key: 'start',
    file: 'Start.avi',
    use: 'intro',
    desc: '片头',
    v206: true,
    w: 640,
    h: 480,
    srcDurationMs: 33867,
    confidence: 'exe',
  },
  {
    key: 'end',
    file: 'End.avi',
    use: 'ending',
    desc: '结局（通用，320×240）',
    v206: true,
    w: 320,
    h: 240,
    srcDurationMs: 30000,
    confidence: 'exe',
  },
  {
    key: 'over',
    file: 'Over.avi',
    use: 'credits',
    desc: '制作群（原版从光盘读取）',
    v206: true,
    w: 640,
    h: 480,
    srcDurationMs: 129500,
    confidence: 'exe',
  },
  {
    key: 'flytw',
    file: 'Flytw.avi',
    use: 'fly.taiwan',
    desc: '飞行过场：台湾',
    v206: true,
    w: 640,
    h: 480,
    srcDurationMs: 6667,
    confidence: 'exe',
  },
  {
    key: 'flychina',
    file: 'Flychina.avi',
    use: 'fly.china',
    desc: '飞行过场：中国大陆',
    v206: true,
    w: 640,
    h: 480,
    srcDurationMs: 6667,
    confidence: 'exe',
  },
  {
    key: 'flyjp',
    file: 'Flyjp.avi',
    use: 'fly.japan',
    desc: '飞行过场：日本',
    v206: true,
    w: 640,
    h: 480,
    srcDurationMs: 6667,
    confidence: 'exe',
  },
  {
    key: 'flyus',
    file: 'Flyus.avi',
    use: 'fly.usa',
    desc: '飞行过场：美国',
    v206: true,
    w: 640,
    h: 480,
    srcDurationMs: 6667,
    confidence: 'exe',
  },
  ...endings,
  {
    key: 'thanks',
    file: 'Thanks.avi',
    use: 'thanks',
    desc: '致谢（v3.11）',
    v206: false,
    w: 640,
    h: 480,
    srcDurationMs: 182200,
    confidence: 'exe',
  },
  {
    key: 'airplane',
    file: 'airplane.avi',
    use: 'airplane',
    desc: '飞机过场（v3.11）',
    v206: false,
    w: 640,
    h: 480,
    srcDurationMs: 13315,
    confidence: 'exe',
  },
];
