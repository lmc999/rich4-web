// zzfx@1.3.2（MIT，Frank Force）没有自带类型；只声明本项目用到的部分。
// 注意：该模块在求值时就会 new AudioContext，所以只能在浏览器里、解锁之后动态 import（见 procedural.ts）。
declare module 'zzfx' {
  export const ZZFX: {
    volume: number;
    sampleRate: number;
    audioContext: { close?(): Promise<void> } | undefined;
    buildSamples(...params: (number | undefined)[]): number[];
  };
}
