// 调试（A12 第一组场所屏）：客户端构建的一个变体——只在内存里改一处接入点（不改源文件），验证接入方式与截图：
//   ui/popups/PopupLayer.tsx：乐透开奖弹窗换成 ClassicLotteryDraw（原版开奖演出，不可用时画原来的 LotteryDrawPopup）。
// （股市已由 dialogs/TurnMenuFull.tsx 用 ClassicStockSheet 接入，不再需要改。）
// 用法：见 test/w3-venues-a.config.ts（W3_INTEGRATE=1 时用这个构建）。产物只在 .cache 下。
import { mergeConfig, type Plugin } from 'vite';
import base from '../apps/client/vite.config';

function integrateVenuesA(): Plugin {
  return {
    name: 'w3:integrate-venues-a',
    enforce: 'pre',
    transform(code, id) {
      const file = id.replaceAll('\\', '/');
      if (file.endsWith('/ui/popups/PopupLayer.tsx')) {
        const call = '<LotteryDrawPopup spec={p} ms={p.realMs} />';
        if (code.includes('ClassicLotteryDraw')) return undefined;
        if (!code.includes(call)) {
          this.warn('PopupLayer.tsx：没找到 LotteryDrawPopup');
          return code;
        }
        return `import { ClassicLotteryDraw } from '../classic/venues/a/LotteryDraw';\n${code.replace(
          call,
          `<ClassicLotteryDraw spec={p} ms={p.realMs} minMs={p.minMs} onSkip={() => usePopupStore.getState().skip(p.popupId)} fallback={${call}} />`,
        )}`;
      }
      return undefined;
    },
  };
}

export default mergeConfig(base, { plugins: [integrateVenuesA()], root: new URL('../apps/client', import.meta.url).pathname });
