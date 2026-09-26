// qrcode 1.5 没有自带类型：只声明前端用到的浏览器 API（lib/browser.js）
declare module 'qrcode' {
  export interface QRCodeToStringOptions {
    type?: 'svg';
    margin?: number;
    width?: number;
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
    color?: { dark?: string; light?: string };
  }
  // biome-ignore lint/suspicious/noShadowRestrictedNames: qrcode 的导出名就是 toString
  export function toString(text: string, opts?: QRCodeToStringOptions): Promise<string>;
  const QRCode: { toString: typeof toString };
  export default QRCode;
}
