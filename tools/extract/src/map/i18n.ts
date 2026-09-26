import type { MapDef } from '@rich4/shared/data';
import { Converter } from 'opencc-js/t2cn';

/**
 * 地图文案：zh-TW 取原版 Big5 解码后的原文；zh-CN 在构建期用 opencc-js 做繁→简
 * （from 'tw'：台湾正体用字 → to 'cn'：大陆简体字形，只做字级转换、不改词）。opencc-js 只在构建期使用。
 */

let converter: ((s: string) => string) | null = null;

export function toZhCN(text: string): string {
  converter ??= Converter({ from: 'tw', to: 'cn' });
  return converter(text);
}

export class StringTable {
  private readonly tw = new Map<string, string>();

  put(key: string, zhTW: string): void {
    const prev = this.tw.get(key);
    if (prev !== undefined && prev !== zhTW) throw new Error(`i18n: ${key} 重复且文本不同`);
    this.tw.set(key, zhTW);
  }

  toStrings(): MapDef['strings'] {
    const keys = [...this.tw.keys()].sort();
    const zhTW: Record<string, string> = {};
    const zhCN: Record<string, string> = {};
    for (const k of keys) {
      const t = this.tw.get(k)!;
      zhTW[k] = t;
      zhCN[k] = toZhCN(t);
    }
    return { 'zh-TW': zhTW, 'zh-CN': zhCN };
  }
}

/** 地图名（我们自己的标签，不来自原版文件）。 */
export const MAP_NAMES: Readonly<Record<string, string>> = { taiwan: '台灣' };
