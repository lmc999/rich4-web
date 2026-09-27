// 格式选择与音量曲线（design-draft §3.7；audio_video.md §5：Ogg Opus 为主，Safari 18.4 以前不支持时回退 m4a）。
import type { AudioFormat } from './types';

/** canPlayType 探测用的 MIME（带 codecs，避免「容器支持、编码不支持」的误判） */
export const FORMAT_MIME: Readonly<Record<AudioFormat, string>> = Object.freeze({
  opus: 'audio/ogg; codecs="opus"',
  m4a: 'audio/mp4; codecs="mp4a.40.2"',
});

/** 按 canPlayType 排出格式优先级：Opus 可播时 Opus 在前；否则 m4a 在前；两者都探测不到时仍按 Opus、m4a 依次尝试 */
export function formatOrder(canPlayType: (mime: string) => string): AudioFormat[] {
  const ok = (f: AudioFormat): boolean => {
    try {
      return canPlayType(FORMAT_MIME[f]) !== '';
    } catch {
      return false;
    }
  };
  if (ok('opus')) return ['opus', 'm4a'];
  if (ok('m4a')) return ['m4a', 'opus'];
  return ['opus', 'm4a'];
}

/** 首选格式 */
export function pickFormat(canPlayType: (mime: string) => string): AudioFormat {
  return formatOrder(canPlayType)[0]!;
}

/** 滑杆 0..1 → 增益的动态范围（dB） */
export const VOLUME_RANGE_DB = 40;

export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

/** 线性滑杆值 → 增益（dB 曲线：1 → 0 dB，0.5 → −20 dB，0 → 静音），client.md §7.1「线性转 dB 曲线」 */
export function volumeToGain(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 0;
  if (v >= 1) return 1;
  return dbToGain(-VOLUME_RANGE_DB * (1 - v));
}
